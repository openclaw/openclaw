import { isSqliteLockError } from "../infra/sqlite-error-diagnostics.js";
import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { getSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { syncTaskMirroredFlowRecordInDatabase } from "./task-flow-registry.store.kernel.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import { readTaskRecord } from "./task-registry.store.kernel.js";
import type { TaskLiveFlowSyncOutcome } from "./task-registry.store.types.js";

const log = createSubsystemLogger("tasks/task-flow-registry");

export function syncLiveTaskFlowInDatabase(
  database: OpenClawStateDatabase,
  params: { taskId: string; flowId: string },
): TaskLiveFlowSyncOutcome {
  let admitted = false;
  let current: TaskFlowRecord | undefined;
  let committed: TaskLiveFlowSyncOutcome | undefined;
  try {
    return runOpenClawStateWriteTransaction<TaskLiveFlowSyncOutcome>(
      ({ db }) => {
        const task = readTaskRecord(db, params.taskId);
        if (!task || task.parentFlowId?.trim() !== params.flowId) {
          return { kind: "not-selected" };
        }
        const synced = syncTaskMirroredFlowRecordInDatabase(db, task, (flow) => {
          current = flow;
          requestSqliteWorkerOperationAdmission({
            stage: "transaction",
            facts: { kind: "task-live-flow", ...params, createdAt: task.createdAt },
          });
          admitted = true;
        });
        const outcome: TaskLiveFlowSyncOutcome = {
          kind: "result",
          result: { ok: true, flow: synced.flow },
        };
        deferSqlitePostCommitPublication(db, () => {
          committed = outcome;
        });
        return outcome;
      },
      { database, path: database.path, env: getSqliteWorkerStateContext().environment },
      { operationLabel: "task.flow.live-sync" },
    );
  } catch (error) {
    if (committed) {
      log.warn("Live task-flow sync committed before cleanup failed", { ...params, error });
      return committed;
    }
    if (error instanceof AggregateError) {
      throw error;
    }
    if (!admitted && isSqliteLockError(error) && database.db.isOpen && !database.db.isTransaction) {
      // The backend settlement check still vetoes a poisoned native handle.
      return { kind: "retry", reason: "storage_contention" };
    }
    // A refused grant or uncertain transport is not a persistence retry.
    if (!admitted || !current) {
      throw error;
    }
    log.warn("Failed to persist live task-flow sync", { ...params, error });
    return { kind: "result", result: { ok: false, reason: "persist_failed", current } };
  }
}
