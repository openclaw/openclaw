import { retainCliProcessJobUntilExit, withCliProcessScope } from "../cli/runtime-cleanup-scope.js";
import { AsyncWorkScope, runOutsideAsyncWorkScope } from "../shared/async-work-scope.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import {
  UPDATE_REPAIR_IPC_MAX_BYTES,
  updateRepairParentMessageSchema,
  type UpdateRepairWorkerMessage,
} from "./update-repair-protocol.js";

// Released updaters invoke this entry before their update has settled. Keep the
// wire contract, but leave inference and operator state to post-failure triage.
const deferredReason =
  "Inference repair is deferred until after the update has failed. Updates do not require inference.";
const controller = new AbortController();
const work = new AsyncWorkScope();
// Capture authority admission before a rehearsal target can project different state paths.
const admissionEnv = { ...process.env };
const pendingSends = new Set<Promise<void>>();
let started = false;
let closing = false;
let finalExitCode = 0;
let execution = Promise.resolve();

function send(message: UpdateRepairWorkerMessage): Promise<void> {
  const sending = new Promise<void>((resolve, reject) => {
    if (
      !process.connected ||
      !process.send ||
      Buffer.byteLength(JSON.stringify(message)) > UPDATE_REPAIR_IPC_MAX_BYTES
    ) {
      reject(new Error("Repair orchestrator disconnected."));
      return;
    }
    process.send(message, (error) => (error ? reject(error) : resolve()));
  });
  pendingSends.add(sending);
  void sending.then(
    () => pendingSends.delete(sending),
    (error: unknown) => {
      pendingSends.delete(sending);
      stop(1, error);
    },
  );
  return sending;
}

function stop(code: number, reason?: unknown, messages: UpdateRepairWorkerMessage[] = []): void {
  if (code !== 0) {
    finalExitCode = code;
  }
  if (closing) {
    return;
  }
  closing = true;
  controller.abort(reason ?? new Error("Repair worker finished."));
  work.beginClose(controller.signal.reason);
  // Fence input now; settle an accepted turn before releasing its native owners.
  process.off("message", onMessage);
  void runOutsideAsyncWorkScope(async () => {
    try {
      await startup.catch(() => undefined);
      await execution;
      await work.drain();
      await drainGlobalSingletonLifecycleState();
      for (const message of messages) {
        await send(message);
      }
    } catch {
      finalExitCode = 1;
      process.stderr.write("Update repair worker failed while settling execution or cleanup.\n");
    } finally {
      await Promise.allSettled(pendingSends);
      process.off("disconnect", onDisconnect);
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      process.stdin.destroy();
      if (process.connected) {
        process.disconnect?.();
      }
      process.exitCode = finalExitCode;
    }
  });
}

function finish(status: "unavailable" | "aborted", reason: string): void {
  stop(0, undefined, [
    { type: "event", event: { type: "stopped", status, reason } },
    {
      type: "result",
      result: {
        status,
        attempts: [],
        finalValidation: { ok: false, score: 0, summary: reason },
        reason,
      },
    },
  ]);
}

function onDisconnect(): void {
  stop(started ? 1 : 0, new Error("Repair orchestrator disconnected."));
}
function onSignal(): void {
  const error = new Error("Repair worker cancelled.");
  controller.abort(error);
  if (!started) {
    finish("aborted", error.message);
  }
}
function onMessage(raw: unknown): void {
  if (closing) {
    return;
  }
  try {
    if (Buffer.byteLength(JSON.stringify(raw)) > UPDATE_REPAIR_IPC_MAX_BYTES) {
      throw new Error("Repair request exceeded its bounded diagnostic budget.");
    }
    const message = updateRepairParentMessageSchema.parse(raw);
    if (message.type === "cancel") {
      controller.abort(new Error(message.reason));
      if (!started) {
        finish("aborted", message.reason);
      }
      return;
    }
    if (message.type === "validation-result" || message.type === "validation-error") {
      throw new Error("Repair worker did not request validation.");
    }
    if (started) {
      throw new Error("Repair worker already owns an execution.");
    }
    started = true;
    if (message.type === "start") {
      finish("unavailable", deferredReason);
      return;
    }
    execution = startup
      .then(() =>
        work.track(async () => {
          controller.signal.throwIfAborted();
          const { runDelegatedUpdateRepairTurn } = await import("./update-repair-turn-worker.js");
          controller.signal.throwIfAborted();
          const result = await runDelegatedUpdateRepairTurn(
            message,
            admissionEnv,
            controller.signal,
            (route) => {
              void send({ type: "event", event: { type: "route-selected", ...route } }).catch(
                () => {},
              );
            },
          );
          if (!closing) {
            stop(0, undefined, [{ type: "turn-result", result }]);
          }
        }),
      )
      .catch((error: unknown) => stop(1, error));
  } catch (error) {
    stop(1, error);
  }
}
process.once("disconnect", onDisconnect);
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);
process.on("message", onMessage);
const startup = Promise.resolve().then(() => withCliProcessScope(retainCliProcessJobUntilExit));
void startup.then(
  () => {
    if (!closing) {
      void send({
        type: "ready",
        candidateRehearsal: true,
        repairTurns: true,
        executorDelegation: "pid-start-v1",
      }).catch(() => {});
    }
  },
  (error: unknown) => stop(1, error),
);
