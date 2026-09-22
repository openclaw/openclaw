import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { toErrorObject } from "./errors.js";
import { runUpdateRepairLoop } from "./update-repair-agent.js";
import {
  UPDATE_REPAIR_IPC_MAX_BYTES,
  updateRepairParentMessageSchema,
  type UpdateRepairWorkerMessage,
  type UpdateRepairValidation,
} from "./update-repair-protocol.js";
import {
  createManagedUpdateRequesterAuthority,
  UpdateRequesterRevokedError,
} from "./update-requester-authority.js";
import { getUpdateRun } from "./update-run-ledger.js";

const controller = new AbortController();
// Capture admission before any rehearsal projection. Copied state is inference
// input, never the authority for requester policy or update-run liveness.
const ledgerEnv = { ...process.env };
let started = false;
let requestId = 0;
let pending:
  | {
      id: number;
      resolve: (validation: UpdateRepairValidation) => void;
      reject: (error: Error) => void;
    }
  | undefined;

function send(message: UpdateRepairWorkerMessage, complete?: () => void): void {
  if (!process.connected || !process.send) {
    controller.abort(new Error("Repair orchestrator disconnected."));
    return;
  }
  if (Buffer.byteLength(JSON.stringify(message)) > UPDATE_REPAIR_IPC_MAX_BYTES) {
    controller.abort(new Error("Repair response exceeded its bounded diagnostic budget."));
    return;
  }
  process.send(message, (error) => {
    if (error) {
      controller.abort(error);
    } else {
      complete?.();
    }
  });
}

process.once("disconnect", () => controller.abort(new Error("Repair orchestrator disconnected.")));
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => controller.abort(new Error("Repair worker cancelled.")));
}
process.on("message", (raw: unknown) => {
  try {
    if (Buffer.byteLength(JSON.stringify(raw)) > UPDATE_REPAIR_IPC_MAX_BYTES) {
      throw new Error("Repair request exceeded its bounded diagnostic budget.");
    }
    const message = updateRepairParentMessageSchema.parse(raw);
    if (message.type === "cancel") {
      controller.abort(new Error(message.reason));
    } else if (message.type === "validation-result" || message.type === "validation-error") {
      if (pending?.id === message.id) {
        if (message.type === "validation-result") {
          pending.resolve(message.validation);
        } else {
          pending.reject(new Error(message.reason));
        }
      }
    } else {
      if (started) {
        throw new Error("Repair worker already owns an execution.");
      }
      started = true;
      void (async () => {
        const runtime = await import("./update-repair-agent.runtime.js");
        const requester = message.requester;
        const requesterAuthority = requester
          ? await runtime.withUpdateRepairEnvironment(message.target, () =>
              createManagedUpdateRequesterAuthority(requester, ledgerEnv),
            )
          : undefined;
        return runUpdateRepairLoop({
          target: message.target,
          context: {
            ...message.failure,
            ...message.context,
            phase: message.context.phase ?? "verifying",
          },
          budget: message.budget,
          signal: controller.signal,
          isCurrent: () => {
            if (!process.connected || controller.signal.aborted) {
              return false;
            }
            if (requesterAuthority?.isCurrent() === false) {
              throw new UpdateRequesterRevokedError();
            }
            if (!message.runId) {
              return true;
            }
            const run = getUpdateRun(message.runId, { env: ledgerEnv });
            return run?.status === "running" && run.phase === "repairing";
          },
          onEvent: (event) => send({ type: "event", event }),
          validate: async (signal) => {
            signal.throwIfAborted();
            const id = ++requestId;
            const deferred = createDeferredCore<UpdateRepairValidation>();
            const abort = () => {
              send({ type: "cancel-validation", id });
              deferred.reject(toErrorObject(signal.reason, "Repair validation cancelled."));
            };
            pending = { id, ...deferred };
            signal.addEventListener("abort", abort, { once: true });
            try {
              send({ type: "validate", id });
              return await deferred.promise;
            } finally {
              signal.removeEventListener("abort", abort);
              pending = undefined;
            }
          },
        });
      })()
        .then(async (result) => {
          await closeOpenClawStateDatabaseAsync();
          send({ type: "result", result }, () => process.exit(0));
        })
        .catch(() => process.exit(1));
    }
  } catch (error) {
    controller.abort(error);
    if (!started) {
      process.exit(1);
    }
  }
});
send({ type: "ready", candidateRehearsal: true });
