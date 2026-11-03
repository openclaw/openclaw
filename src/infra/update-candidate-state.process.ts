import { AsyncLocalStorage } from "node:async_hooks";
import { isPromise } from "node:util/types";
import { MessageChannel } from "node:worker_threads";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import { resolveCommandProcessSignal, withCommandProcessScope } from "../process/exec-spawn.js";
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

type StateInspectionScope = {
  source: ReturnType<typeof captureRuntimeWorkerSource>;
  broker?: ReturnType<typeof createSpawnBrokerHost>;
  pending: Set<Promise<unknown>>;
  closing: boolean;
};
const inspectionScopes = new AsyncLocalStorage<StateInspectionScope>();
const inspectionCommands = new AsyncLocalStorage<{
  directory: string;
  run: (argv: string[], options: StateInspectionOptions) => Promise<SpawnResult>;
}>();
function decodeInspectionFailure(failure: StateInspectionFailure): unknown {
  const cause = decodeNativeWorkerFailure(failure.error);
  return failure.uncertain ? new CommandProcessCleanupError({ cause }) : cause;
}

export function runStateInspectionCommand(
  argv: string[],
  options: StateInspectionOptions,
): Promise<SpawnResult> {
  return (
    inspectionCommands.getStore()?.run(argv, options) ?? runUtf8CommandWithTimeout(argv, options)
  );
}

/** Only the command owner can lend its cleanup tree to an isolated inspection. */
export function getStateInspectionStagingRoot(): string | undefined {
  return inspectionCommands.getStore()?.directory;
}

/** Maintenance shares native custody startup; each inspection still retires its own tree. */
export function createStateInspectionScope() {
  const source = captureRuntimeWorkerSource(resolveRuntimeProcessEntrypointUrl("spawnBroker"));
  const scope: StateInspectionScope = { source, pending: new Set(), closing: false };
  const operations = new Set<Promise<unknown>>();
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      // Admitted callbacks may still need to launch their next isolated observation.
      await Promise.allSettled(operations);
      scope.closing = true;
      await Promise.allSettled(scope.pending);
      // Open native claims refuse shutdown even if a caller caught uncertain cleanup.
      await scope.broker?.close();
    })());
  source.runtimeGeneration?.retain(scope, close);
  return {
    run<T>(operation: () => T): T {
      if (closing) {
        throw new Error("State inspection scope is closing");
      }
      const value = inspectionScopes.run(scope, operation);
      // Preserve synchronous values without assimilating user-defined thenables.
      if (isPromise(value)) {
        operations.add(value);
        void value.then(
          () => operations.delete(value),
          () => operations.delete(value),
        );
      }
      return value;
    },
    close,
  };
}

async function withStateInspectionScope<T>(operation: () => Promise<T>): Promise<T> {
  const scope = createStateInspectionScope();
  let outcome: { value: T } | { cause: unknown };
  try {
    outcome = { value: await scope.run(operation) };
  } catch (cause) {
    outcome = { cause };
  }
  try {
    await scope.close();
  } catch (cause) {
    throw new AggregateError(
      "cause" in outcome ? [outcome.cause, cause] : [cause],
      "State inspection scope cleanup failed",
      { cause },
    );
  }
  if ("cause" in outcome) {
    throw outcome.cause;
  }
  return outcome.value;
}

/** One surviving command owner keeps temporary state images through creator exit. */
export function withStateInspectionStaging<T>(
  root: string,
  inspect: (stagingRoot: string) => Promise<T>,
  options: { allowLegacyWorker?: boolean; signal?: AbortSignal } = {},
): Promise<T> {
  const scope = inspectionScopes.getStore();
  if (!scope) {
    return withStateInspectionScope(() => withStateInspectionStaging(root, inspect, options));
  }
  if (scope.closing) {
    return Promise.reject(new Error("State inspection scope is closing"));
  }
  const work = runStateInspectionStaging(scope, root, inspect, options);
  scope.pending.add(work);
  void work.then(
    () => scope.pending.delete(work),
    () => scope.pending.delete(work),
  );
  return work;
}

async function runStateInspectionStaging<T>(
  scope: StateInspectionScope,
  root: string,
  inspect: (stagingRoot: string) => Promise<T>,
  options: { allowLegacyWorker?: boolean; signal?: AbortSignal },
): Promise<T> {
  options.signal?.throwIfAborted();
  const { source } = scope;
  const broker = (scope.broker ??= createSpawnBrokerHost({
    nativeResources: true,
    workerUrl: source.moduleUrl,
  }));
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
    const { signal: inputSignal, onOutputChunk, baseEnv, env, ...serializable } = commandOptions;
    const signal = resolveCommandProcessSignal(inputSignal);
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
    outcome = {
      value: await inspectionCommands.run({ directory, run }, () => inspect(directory)),
    };
  } catch (cause) {
    outcome = { cause };
  }
  const cleanupErrors: unknown[] = [];
  try {
    // The native owner independently joins command groups, including uncertain caller cleanup.
    await client.close().catch((error: unknown) => cleanupErrors.push(error));
    await lease.close();
    lease.release();
  } catch (cause) {
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
