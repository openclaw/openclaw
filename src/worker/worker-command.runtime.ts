import { realpath } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";
import { readByteStreamWithLimit } from "@openclaw/media-core/read-byte-stream-with-limit";
import { WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES } from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import {
  getActiveBackgroundExecSessionCount,
  waitForExecScope,
} from "../agents/bash-process-registry.js";
import { toErrorObject } from "../infra/errors.js";
import { createBoundedLineFramer } from "../process/bounded-line-framer.js";
import type { WorkerBrowserRuntime } from "./browser-runtime.js";
import { parseWorkerLaunchDescriptor, type WorkerLaunchDescriptor } from "./launch-descriptor.js";
import {
  parseWorkerProcessRequest,
  type WorkerProcessMessage,
  type WorkerProcessResult,
} from "./worker-process-protocol.js";
import { createWorkerRuntimeEnvironment, runWorkerDescriptor } from "./worker.runtime.js";

type RunWorkerCommandOptions = {
  input: Readable;
  lifetime?: WorkerCommandLifetime;
  output: Writable;
  browserRuntime?: WorkerBrowserRuntime;
  managed?: boolean;
};

export type WorkerCommandLifetime = {
  dispose: () => void;
  reportConnectionFailure: (cause: string | undefined) => void;
  signal: AbortSignal;
  started: Promise<boolean>;
  terminateOwnedTree: () => void;
};

function workerInputBytes(raw: unknown, label: string): Buffer {
  if (typeof raw === "string" || raw instanceof Uint8Array) {
    return Buffer.from(raw);
  }
  throw new Error(`${label} input must be bytes`);
}

async function runManagedWorkerCommand(
  options: RunWorkerCommandOptions,
  signal: AbortSignal,
): Promise<void> {
  let environment: Awaited<ReturnType<typeof createWorkerRuntimeEnvironment>> | undefined;
  let binding: string | undefined;
  let lastTurnId: string | undefined;
  let active: { turnId: string; controller: AbortController } | undefined;
  let running: Promise<void> | undefined;
  let idleCleanup: Promise<void> | undefined;
  let draining: Promise<void> | undefined;
  let closed = false;
  const framer = createBoundedLineFramer(
    WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES,
    "managed worker request exceeds the protocol payload limit",
  );
  let removeListeners = () => {};

  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: unknown) => {
        if (closed) {
          return;
        }
        const failure =
          error === undefined ? undefined : toErrorObject(error, "managed worker command failed");
        closed = true;
        active?.controller.abort(failure ?? new Error("worker supervisor input closed"));
        options.input.destroy();
        options.output.destroy();
        if (failure) {
          reject(failure);
        } else {
          resolve();
        }
      };
      const write = (response: WorkerProcessMessage) =>
        new Promise<void>((resolveWrite, rejectWrite) => {
          const onClose = () => rejectWrite(new Error("managed worker result output closed"));
          // A failed write reports through both the callback and the stream. The callback owns
          // the result; retain one listener to consume the matching runtime error event.
          const onError = () => {};
          options.output.once("close", onClose);
          options.output.once("error", onError);
          options.output.write(`${JSON.stringify(response)}\n`, (error) => {
            options.output.off("close", onClose);
            if (error) {
              rejectWrite(error);
            } else {
              options.output.off("error", onError);
              resolveWrite();
            }
          });
        });
      const onLine = (line: Buffer) => {
        let value: unknown;
        try {
          value = JSON.parse(line.toString("utf8"));
        } catch {
          throw new Error("managed worker request is not valid JSON");
        }
        const request = parseWorkerProcessRequest(value);
        if (request.type === "cancel") {
          if (active?.turnId === request.turnId) {
            active.controller.abort(new Error("worker turn cancelled"));
          }
          return;
        }
        if (active || lastTurnId === request.turnId) {
          throw new Error("managed worker turn is already active or was already executed");
        }
        // The node turn journal owns replay history; retain only the immediate
        // transport duplicate here, then require fresh Gateway admission.
        lastTurnId = request.turnId;
        const current = { turnId: request.turnId, controller: new AbortController() };
        active = current;
        running = (async (descriptor: WorkerLaunchDescriptor, idleRetention?: true) => {
          const workspaceDir = await realpath(descriptor.assignment.workspaceDir);
          const workerContainmentRoot = await realpath(
            descriptor.assignment.workerContainmentRoot ?? workspaceDir,
          );
          const nextBinding = JSON.stringify({
            environmentId: descriptor.admission.environmentId,
            sessionId: descriptor.admission.sessionId,
            ownerEpoch: descriptor.admission.ownerEpoch,
            agentId: descriptor.assignment.agentId,
            permissionMode: descriptor.assignment.permissionMode,
            workspaceDir,
            workerContainmentRoot,
          });
          if (binding !== undefined && binding !== nextBinding) {
            throw new Error("managed worker environment binding changed; relaunch required");
          }
          binding = nextBinding;
          if (closed) {
            return;
          }
          environment ??= await createWorkerRuntimeEnvironment(descriptor.admission.sessionId);
          await idleCleanup;
          if (closed) {
            return;
          }
          const result = await runWorkerDescriptor(
            {
              ...descriptor,
              assignment:
                descriptor.assignment.permissionMode === undefined
                  ? { ...descriptor.assignment, workspaceDir }
                  : { ...descriptor.assignment, workspaceDir, workerContainmentRoot },
            },
            {
              environmentStateDir: environment.stateDir,
              signal: current.controller.signal,
              ...(options.lifetime
                ? { onConnectionFailure: options.lifetime.reportConnectionFailure }
                : {}),
              ...(options.browserRuntime ? { browserRuntime: options.browserRuntime } : {}),
            },
          );
          if (closed) {
            return;
          }
          const stateDir = environment.stateDir;
          const scopeKey = `worker:${descriptor.admission.sessionId}`;
          const disposeProfile = async () => {
            const { disposeWorkerGitHubEnvironment } = await import("./github-binding.runtime.js");
            await disposeWorkerGitHubEnvironment(stateDir, descriptor.assignment.turnId);
          };
          const canRetain = result.status === "completed" || result.status === "failed";
          let retention: WorkerProcessResult["retention"] =
            canRetain && getActiveBackgroundExecSessionCount() > 0
              ? "background"
              : canRetain && idleRetention && !current.controller.signal.aborted
                ? "idle"
                : undefined;
          if (retention === "idle") {
            await waitForExecScope(scopeKey);
            await disposeProfile();
            if (current.controller.signal.aborted) {
              retention = undefined;
            }
          }
          if (closed) {
            return;
          }
          const retainWorker = retention !== undefined;
          if (retainWorker) {
            active = undefined;
          }
          await write({
            type: "result",
            turnId: current.turnId,
            result,
            retainWorker,
            ...(idleRetention && retention ? { retention } : {}),
          });
          if (retention === "background") {
            const isCurrent = () => !closed && !active && lastTurnId === current.turnId;
            draining = Promise.all([draining, waitForExecScope(scopeKey)])
              .then(async () => {
                // Remove this turn's profile even if a newer turn is already running.
                await (idleCleanup = disposeProfile());
                if (idleRetention && isCurrent()) {
                  await write({ type: "idle-ready", turnId: current.turnId });
                }
              })
              .catch(finish);
          }

          if (!retainWorker) {
            active = undefined;
            finish();
          }
        })(request.descriptor, request.idleRetention).catch(finish);
      };
      const onData = (raw: unknown) => {
        if (closed) {
          return;
        }
        try {
          const chunk = workerInputBytes(raw, "managed worker");
          for (const line of framer.push(chunk)) {
            onLine(line);
            if (closed) {
              break;
            }
          }
        } catch (error) {
          finish(error);
        }
      };
      const onEnd = () => finish();
      const onAbort = () => finish(signal.reason);
      options.input.on("data", onData);
      options.input.once("end", onEnd);
      options.input.once("close", onEnd);
      options.input.once("error", finish);
      options.output.once("error", finish);
      signal.addEventListener("abort", onAbort, { once: true });
      removeListeners = () => {
        options.input.off("data", onData);
        options.input.off("end", onEnd);
        options.input.off("close", onEnd);
        options.input.off("error", finish);
        options.output.off("error", finish);
        signal.removeEventListener("abort", onAbort);
      };
      if (signal.aborted) {
        onAbort();
      } else if (options.input.readableEnded || options.input.destroyed) {
        onEnd();
      }
    });
  } finally {
    framer.clear();
    try {
      await running;
      await environment?.close();
      await draining;
    } finally {
      removeListeners();
    }
  }
}

async function readLaunchDescriptor(input: Readable): Promise<WorkerLaunchDescriptor> {
  const bytes = await readByteStreamWithLimit(
    input.map((chunk: unknown) => workerInputBytes(chunk, "worker launch descriptor")),
    {
      maxBytes: WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES,
      onOverflow: () => new Error("worker launch descriptor exceeds the protocol payload limit"),
    },
  );
  if (bytes.length === 0) {
    throw new Error("worker launch descriptor is required on stdin");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error("worker launch descriptor is not valid JSON", { cause: error });
  }
  return parseWorkerLaunchDescriptor(decoded);
}

/** Process shell for `openclaw worker`: stdin descriptor in, JSON result out, signals abort the run. */
export async function runWorkerCommand(options: RunWorkerCommandOptions): Promise<void> {
  const abortController = new AbortController();
  const stop = () => abortController.abort(new Error("worker interrupted"));
  let lifetimeEnded = false;
  const stopForLifetime = () => {
    if (lifetimeEnded || !options.lifetime) {
      return;
    }
    lifetimeEnded = true;
    abortController.abort(
      options.lifetime.signal.reason ?? new Error("worker supervisor lifetime ended"),
    );
    options.lifetime.terminateOwnedTree();
  };
  try {
    const [descriptor, started] = await Promise.all([
      options.managed ? undefined : readLaunchDescriptor(options.input),
      options.lifetime?.started ?? true,
    ]);
    if (!started) {
      return;
    }
    options.lifetime?.signal.addEventListener("abort", stopForLifetime, { once: true });
    if (options.lifetime?.signal.aborted) {
      stopForLifetime();
    }
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    if (!descriptor) {
      await runManagedWorkerCommand(options, abortController.signal);
      return;
    }
    const result = await runWorkerDescriptor(descriptor, {
      signal: abortController.signal,
      ...(options.lifetime
        ? { onConnectionFailure: options.lifetime.reportConnectionFailure }
        : {}),
      ...(options.browserRuntime ? { browserRuntime: options.browserRuntime } : {}),
    });
    const encoded = `${JSON.stringify(result)}\n`;
    options.output.write(encoded);
  } finally {
    options.lifetime?.signal.removeEventListener("abort", stopForLifetime);
    options.lifetime?.dispose();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
