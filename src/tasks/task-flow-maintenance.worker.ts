import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { getSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { isTaskFlowCancellationPending } from "./task-cancellation-state.js";
import {
  resolveTaskFlowMaintenanceAction,
  type TaskFlowMaintenanceInput,
  type TaskFlowMaintenanceOutcome,
} from "./task-flow-maintenance-policy.js";
import { normalizeRestoredFlowRecord } from "./task-flow-registry.records.js";
import {
  deleteTaskFlowRowInDatabase,
  readTaskFlowRecord,
  updateTaskFlowRecordInDatabase,
} from "./task-flow-registry.store.kernel.js";
import { listTaskRecordsForFlowReadInDatabase } from "./task-registry.store.kernel.js";

const log = createSubsystemLogger("tasks/task-flow-registry");

export function maintainTaskFlowInDatabase(
  database: OpenClawStateDatabase,
  input: TaskFlowMaintenanceInput,
): TaskFlowMaintenanceOutcome {
  let committed: TaskFlowMaintenanceOutcome | undefined;
  try {
    return runOpenClawStateWriteTransaction(
      ({ db }) => {
        requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
        const maintain = (): TaskFlowMaintenanceOutcome => {
          const stored = readTaskFlowRecord(db, input.flowId);
          if (!stored) {
            return "unchanged";
          }
          const current = normalizeRestoredFlowRecord(stored);
          if (current.revision !== input.expectedRevision) {
            return "revision_conflict";
          }
          const action = resolveTaskFlowMaintenanceAction(current, input.now, () =>
            listTaskRecordsForFlowReadInDatabase(db, current.flowId).some(
              isTaskFlowCancellationPending,
            ),
          );
          if (!action || action.kind !== input.action) {
            return "unchanged";
          }
          if (action.kind === "prune") {
            deleteTaskFlowRowInDatabase(db, current.flowId);
            return "pruned";
          }
          const result = updateTaskFlowRecordInDatabase(db, {
            flowId: current.flowId,
            expectedRevision: input.expectedRevision,
            patch: action.patch,
          });
          if (!result.applied && result.reason === "invalid_patch") {
            throw result.error;
          }
          return result.applied ? "reconciled" : "unchanged";
        };
        const result = maintain();
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
        deferSqlitePostCommitPublication(db, () => {
          committed = result;
        });
        return result;
      },
      { database, path: database.path, env: getSqliteWorkerStateContext().environment },
      { operationLabel: "flows.maintain" },
    );
  } catch (error) {
    if (committed !== undefined) {
      log.warn("Task-flow maintenance committed before cleanup failed", {
        flowId: input.flowId,
        error,
      });
      return committed;
    }
    throw error;
  }
}
