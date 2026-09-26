import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { getSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import {
  hasAuthoritativeTaskBackingFromRecords,
  selectCurrentCanonicalTaskBacking,
} from "./task-backing-records.js";
import {
  isProvisionalSubagentKillTask,
  isTaskFlowCancellationPending,
} from "./task-cancellation-state.js";
import {
  matchesTaskFlowCancellationSelection,
  type TaskFlowCancellationInput,
  type TaskFlowCancellationReceipt,
} from "./task-flow-cancellation.types.js";
import { normalizeRestoredFlowRecord } from "./task-flow-registry.records.js";
import {
  readTaskFlowRecord,
  updateSelectedTaskFlowRecordInDatabase,
} from "./task-flow-registry.store.kernel.js";
import { isTerminalTaskFlow } from "./task-flow-registry.types.js";
import {
  listTaskRecordsForFlowReadInDatabase,
  readTaskRegistryMutationSnapshotInDatabase,
} from "./task-registry.store.kernel.js";

const log = createSubsystemLogger("tasks/executor");

/** Intent and finalization each reread the exact flow and its children under write admission. */
export function cancelTaskFlowInDatabase(
  database: OpenClawStateDatabase,
  input: TaskFlowCancellationInput,
): TaskFlowCancellationReceipt {
  let committed: TaskFlowCancellationReceipt | undefined;
  try {
    return runOpenClawStateWriteTransaction(
      ({ db }) => {
        requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
        const cancel = (): TaskFlowCancellationReceipt => {
          const stored = readTaskFlowRecord(db, input.selected.flowId);
          const flow = stored && normalizeRestoredFlowRecord(stored);
          if (!flow || flow.ownerKey !== input.selected.ownerKey) {
            return { found: false, cancelled: false, reason: "Flow not found." };
          }
          if (!matchesTaskFlowCancellationSelection(flow, input.selected)) {
            return {
              found: true,
              cancelled: false,
              reason: "Flow changed while cancellation was in progress.",
            };
          }
          const tasks = listTaskRecordsForFlowReadInDatabase(db, flow.flowId, "control");
          const provisional = tasks.filter(isProvisionalSubagentKillTask);
          if (isTerminalTaskFlow(flow)) {
            if (flow.status === "cancelled" && provisional.length > 0) {
              return input.phase === "request"
                ? { found: true, cancelled: false, flow, tasks, dispatch: provisional }
                : {
                    found: true,
                    cancelled: false,
                    reason: "One or more child tasks remain provisionally cancelled.",
                    flow,
                    tasks,
                  };
            }
            const cancelled = input.phase === "finalize" && flow.status === "cancelled";
            return {
              found: true,
              cancelled,
              ...(cancelled ? {} : { reason: `Flow is already ${flow.status}.` }),
              flow,
              tasks,
            };
          }
          if (flow.revision !== input.expectedRevision) {
            return {
              found: true,
              cancelled: false,
              reason: "Flow changed while cancellation was in progress.",
              flow,
              tasks,
            };
          }
          const active = tasks.filter(isTaskFlowCancellationPending);
          if (input.phase === "request") {
            const hasBacking = active.every((task) =>
              hasAuthoritativeTaskBackingFromRecords(task, {
                isManagedFlow: (flowId) => readTaskFlowRecord(db, flowId)?.syncMode === "managed",
                resolveCurrentCanonicalBacking: (scope) =>
                  selectCurrentCanonicalTaskBacking({
                    ...scope,
                    candidates: [
                      ...readTaskRegistryMutationSnapshotInDatabase(db, {
                        taskId: task.taskId,
                        runId: scope.runId,
                        childSessionKey: scope.childSessionKey,
                      }).tasks.values(),
                    ],
                    isTaskMirroredFlow: (flowId) =>
                      readTaskFlowRecord(db, flowId)?.syncMode === "task_mirrored",
                  }),
              }),
            );
            if (!hasBacking) {
              return {
                found: true,
                cancelled: false,
                reason:
                  "Child task ownership could not be verified; no cancellation was performed.",
                flow,
                tasks,
              };
            }
            if (flow.cancelRequestedAt != null) {
              return { found: true, cancelled: false, flow, tasks, dispatch: active };
            }
          } else if (active.length > 0) {
            return {
              found: true,
              cancelled: false,
              reason: "One or more child tasks are still active.",
              flow,
              tasks,
            };
          } else if (flow.cancelRequestedAt == null) {
            return {
              found: true,
              cancelled: false,
              reason: "Flow cancellation is no longer requested.",
              flow,
              tasks,
            };
          }
          const result = updateSelectedTaskFlowRecordInDatabase(db, flow, {
            expectedRevision: flow.revision,
            patch:
              input.phase === "request"
                ? { cancelRequestedAt: input.now, updatedAt: input.now }
                : {
                    status: "cancelled",
                    blockedTaskId: null,
                    blockedSummary: null,
                    waitJson: null,
                    endedAt: input.now,
                    updatedAt: input.now,
                  },
          });
          if (!result.applied) {
            if (result.reason === "invalid_patch") {
              throw result.error;
            }
            return {
              found: true,
              cancelled: false,
              reason: "Flow changed while cancellation was in progress.",
              flow,
              tasks,
            };
          }
          return {
            found: true,
            cancelled: input.phase === "finalize",
            flow: result.flow,
            tasks,
            ...(input.phase === "request" ? { dispatch: active } : {}),
          };
        };
        const result = cancel();
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
        deferSqlitePostCommitPublication(db, () => {
          committed = result;
        });
        return result;
      },
      { database, path: database.path, env: getSqliteWorkerStateContext().environment },
      { operationLabel: "flows.cancel" },
    );
  } catch (error) {
    if (committed) {
      log.warn("Flow cancellation committed before cleanup failed", {
        flowId: input.selected.flowId,
        error,
      });
      return committed;
    }
    throw error;
  }
}
