import { createAgentCleanupScope } from "../agents/run-cleanup-timeout.js";
import { retainCliProcessJobUntilExit, withCliProcessScope } from "../cli/runtime-cleanup-scope.js";
import {
  withDelegatedUpdateCommandExecutor,
  type UpdateCommandChildGrant,
} from "../cli/update-cli/update-command-executor.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { toErrorObject } from "./errors.js";
import { runUpdateRepairLoop } from "./update-repair-agent.js";
import {
  UPDATE_REPAIR_IPC_MAX_BYTES,
  updateRepairParentMessageSchema,
  type UpdateRepairWorkerMessage,
  type UpdateRepairValidation,
  type UpdateRepairTurnResult,
} from "./update-repair-protocol.js";
import { createUpdateRepairTurnRunner, repairSummary } from "./update-repair-turn.js";
import {
  createManagedUpdateRequesterAuthority,
  UpdateRequesterRevokedError,
} from "./update-requester-authority.js";
import { getUpdateRun } from "./update-run-ledger.js";
import type { UpdateRecoveryFence } from "./update-run-recovery.js";

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
      if (message.turn && (!message.runId || !message.executor)) {
        throw new Error("Update repair requires its delegated executor.");
      }
      started = true;
      void (async () => {
        const run = async (fence?: UpdateRecoveryFence) => {
          fence?.assertCurrent();
          const runtime = await import("./update-repair-agent.runtime.js");
          fence?.assertCurrent();
          const requester = message.requester;
          const requesterAuthority = requester
            ? await runtime.withUpdateRepairEnvironment(message.target, () =>
                createManagedUpdateRequesterAuthority(requester, ledgerEnv),
              )
            : undefined;
          const isCurrent = () => {
            if (!process.connected || controller.signal.aborted) {
              return false;
            }
            fence?.assertCurrent();
            if (requesterAuthority?.isCurrent() === false) {
              throw new UpdateRequesterRevokedError();
            }
            if (!message.runId) {
              return true;
            }
            const updateRun = getUpdateRun(message.runId, { env: ledgerEnv });
            return updateRun?.status === "running" && updateRun.phase === "repairing";
          };
          const turn = message.turn;
          if (turn) {
            const cleanup = createAgentCleanupScope();
            const timer = setTimeout(
              () => controller.abort(new Error("per-turn-budget")),
              turn.timeoutMs,
            );
            let result: UpdateRepairTurnResult;
            try {
              result = await cleanup.run(() =>
                createUpdateRepairTurnRunner(message.target)({
                  ...turn,
                  signal: controller.signal,
                  isCurrent,
                  onRoute: (route) =>
                    send({ type: "event", event: { type: "route-selected", ...route } }),
                }),
              );
              // Preserve drained counts on cancellation; live turns cannot report
              // completion after their requester or update run was revoked.
              if (result.status === "completed" && !controller.signal.aborted && !isCurrent()) {
                throw new Error("Repair no longer owns the update attempt.");
              }
              if (cleanup.outcome === "uncertain") {
                throw new Error("Update repair cleanup could not be confirmed.");
              }
            } catch (error) {
              result = {
                status: "aborted",
                reason: repairSummary(
                  error instanceof Error ? error.message : String(error),
                  message.target,
                ),
              };
            } finally {
              clearTimeout(timer);
            }
            return { type: "turn-result", result } as const;
          }
          // v2026.9.4 sends this complete-loop envelope without an executor or phase.
          // Preserve its receiver contract; current updaters send delegated turns.
          const result = await runUpdateRepairLoop({
            target: message.target,
            context: {
              ...message.failure,
              ...message.context,
              phase: message.context.phase ?? "verifying",
            },
            budget: message.budget,
            signal: controller.signal,
            isCurrent,
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
          return { type: "result", result } as const;
        };
        if (message.executor) {
          return await withDelegatedUpdateCommandExecutor(
            // SAFETY: The live owner validates private IPC lineage and our PID/start identity.
            message.executor as UpdateCommandChildGrant,
            message.runId ?? "",
            message.target.installRoot,
            run,
          );
        }
        return await run();
      })()
        .then((result) => {
          closeOpenClawStateDatabase();
          send(result, () => process.exit(0));
        })
        .catch((error: unknown) => {
          if (message.turn) {
            closeOpenClawStateDatabase();
            send(
              {
                type: "turn-result",
                result: {
                  status: "aborted",
                  reason: repairSummary(
                    error instanceof Error ? error.message : String(error),
                    message.target,
                  ),
                },
              },
              () => process.exit(0),
            );
          } else {
            process.exit(1);
          }
        });
    }
  } catch (error) {
    controller.abort(error);
    if (!started) {
      process.exit(1);
    }
  }
});
void withCliProcessScope(retainCliProcessJobUntilExit).then(
  () =>
    send({
      type: "ready",
      candidateRehearsal: true,
      repairTurns: true,
      executorDelegation: "pid-start-v1",
    }),
  () => process.exit(1),
);
