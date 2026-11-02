import { AsyncLocalStorage } from "node:async_hooks";
import { MessageChannel } from "node:worker_threads";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import { withCommandProcessScope } from "../process/exec-spawn.js";
import { runUtf8CommandWithTimeout, type SpawnResult } from "../process/exec.js";
import { createSpawnBrokerHost } from "../process/spawn-broker/host.js";
import { attachBrokerNativeResource } from "../process/spawn-broker/resource-client.js";
import { BrokerNativeResourceCloseError } from "../process/spawn-broker/resource-protocol.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveRuntimeProcessEntrypointUrl } from "./runtime-process-url.js";
import {
  captureRuntimeWorkerSource,
  resolveRuntimeWorkerGenerationUrl,
} from "./runtime-worker-generation.js";
import { retainSnapshotWork } from "./sqlite-readonly-location-cleanup.js";
import type {
  StateInspectionOptions,
  StateInspectionFailure,
  StateInspectionReply,
  StateInspectionRequest,
} from "./update-state-inspection-resource.js";
import { decodeNativeWorkerFailure } from "./worker-native-error.js";

const inspectionCommands = new AsyncLocalStorage<
  (argv: string[], options: StateInspectionOptions) => Promise<SpawnResult>
>();
function decodeInspectionFailure(failure: StateInspectionFailure): unknown {
  const cause = decodeNativeWorkerFailure(failure.error);
  return failure.uncertain ? new CommandProcessCleanupError({ cause }) : cause;
}

export function runStateInspectionCommand(
  argv: string[],
  options: StateInspectionOptions,
): Promise<SpawnResult> {
  return inspectionCommands.getStore()?.(argv, options) ?? runUtf8CommandWithTimeout(argv, options);
}

/** One surviving command owner keeps temporary state images through creator exit. */
export async function withStateInspectionStaging<T>(
  root: string,
  inspect: (stagingRoot: string) => Promise<T>,
  options: { allowLegacyWorker?: boolean; signal?: AbortSignal } = {},
): Promise<T> {
  options.signal?.throwIfAborted();
  const source = captureRuntimeWorkerSource(resolveRuntimeProcessEntrypointUrl("spawnBroker"));
  const broker = createSpawnBrokerHost({ nativeResources: true, workerUrl: source.moduleUrl });
  const retired = createDeferredCore();
  void retired.promise.catch(() => {});
  source.runtimeGeneration?.retain(broker, () => retired.promise);
  const { port1, port2 } = new MessageChannel();
  const allocated = createDeferredCore<string>();
  let sequence = 0;
  const pending = new Map<
    number,
    {
      result: ReturnType<typeof createDeferredCore<SpawnResult>>;
      output: StateInspectionOptions["onOutputChunk"];
      outputError?: unknown;
      outputStopped: boolean;
    }
  >();
  const fail = (error: Error) => {
    allocated.reject(error);
    for (const command of pending.values()) {
      command.result.reject(error);
    }
  };
  let lease: ReturnType<typeof broker.captureNativeResource>;
  try {
    lease = broker.captureNativeResource(
      {
        moduleUrl: resolveRuntimeWorkerGenerationUrl(
          resolveRuntimeProcessEntrypointUrl("updateStateInspectionResource"),
          source.runtimeGeneration,
        ).href,
        input: { root, allowLegacyWorker: options.allowLegacyWorker === true },
        ownerPort: false,
      },
      { message() {}, failed: fail },
    );
  } catch (error) {
    port1.close();
    port2.close();
    try {
      await broker.close();
      retired.resolve();
    } catch (cause) {
      retired.reject(cause);
      throw cause;
    }
    throw error;
  }
  const send = (request: StateInspectionRequest) => port2.postMessage(request);
  port2.on("message", (reply: StateInspectionReply) => {
    if (reply.type === "allocated") {
      allocated.resolve(reply.directory);
      return;
    }
    const command = pending.get(reply.id);
    if (!command) {
      return;
    }
    if (reply.type === "output") {
      if (command.outputStopped) {
        return;
      }
      try {
        if (command.output?.(Buffer.from(reply.chunk), reply.stream) === false) {
          command.outputStopped = true;
          send({ type: "cancel", id: reply.id });
        }
      } catch (error) {
        command.outputStopped = true;
        command.outputError = error;
        send({ type: "cancel", id: reply.id });
      }
    } else if (reply.type === "error") {
      command.result.reject(decodeInspectionFailure(reply));
    } else if (command.outputError !== undefined) {
      command.result.reject(command.outputError);
    } else {
      // The observer owns this stop decision even when the native result is already in transit.
      command.result.resolve(
        command.outputStopped
          ? {
              ...reply.value,
              outputLimitExceeded: true,
              termination: "signal",
              killIssuedByAbort: true,
              noOutputTimedOut: false,
            }
          : reply.value,
      );
    }
  });
  const client = attachBrokerNativeResource(lease.attachment, port1, () => {}, fail);
  const run = async (argv: string[], commandOptions: StateInspectionOptions) => {
    const { signal, onOutputChunk, baseEnv, env, ...serializable } = commandOptions;
    signal?.throwIfAborted();
    const id = ++sequence;
    const result = createDeferredCore<SpawnResult>();
    pending.set(id, { result, output: onOutputChunk, outputStopped: false });
    const abort = () => send({ type: "cancel", id });
    signal?.addEventListener("abort", abort, { once: true });
    try {
      // Environment views can be Proxy-backed; the native socket needs plain snapshots.
      send({
        type: "run",
        id,
        argv,
        options: { ...serializable, baseEnv: baseEnv && { ...baseEnv }, env: env && { ...env } },
      });
      return await result.promise;
    } finally {
      signal?.removeEventListener("abort", abort);
      pending.delete(id);
    }
  };
  let outcome: { value: T } | { cause: unknown };
  try {
    const directory = await allocated.promise;
    options.signal?.throwIfAborted();
    outcome = { value: await inspectionCommands.run(run, () => inspect(directory)) };
  } catch (cause) {
    outcome = { cause };
  }
  const cleanupErrors: unknown[] = [];
  try {
    // The native owner independently joins command groups, including uncertain caller cleanup.
    await client.close().catch((error: unknown) => cleanupErrors.push(error));
    await lease.close();
    lease.release();
    await broker.close();
    retired.resolve();
  } catch (cause) {
    retired.reject(cause);
    cleanupErrors.push(cause);
  } finally {
    client.dispose();
    port1.close();
    port2.close();
  }
  if (cleanupErrors.length) {
    const decoded = cleanupErrors.map((error) => {
      if (!(error instanceof BrokerNativeResourceCloseError)) {
        return error;
      }
      // SAFETY: The paired domain resource supplies its typed failure payload.
      return decodeInspectionFailure(error.payload as StateInspectionFailure);
    });
    throw new AggregateError(
      "cause" in outcome ? [outcome.cause, ...decoded] : decoded,
      "State inspection command and staging cleanup failed",
      { cause: decoded[0] },
    );
  }
  if ("cause" in outcome) {
    throw outcome.cause;
  }
  return outcome.value;
}

/** A bounded command result does not release snapshot ownership before late process cleanup. */
export function withUpdateStateInspectionWork<T>(
  run: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  let stop = () => {};
  const work = withCommandProcessScope((stopScope) => {
    stop = stopScope;
    return run();
  }, signal);
  return retainSnapshotWork(work, () => stop());
}
