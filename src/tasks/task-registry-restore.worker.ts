import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { getSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { serializeAgentSchemaInspectionError } from "../state/openclaw-agent-schema-inspection-response.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import {
  restoreTaskExecutionSnapshot,
  type TaskExecutionRestoreResult,
} from "./task-execution-owner.js";
import {
  isTaskMirroredFlowSyncUnchanged,
  normalizeRestoredFlowRecord,
  prepareTaskMirroredFlowSyncFromCurrent,
} from "./task-flow-registry.records.js";
import {
  bindTaskFlowRecord,
  readTaskFlowRecord,
  upsertTaskFlowRowInDatabase,
} from "./task-flow-registry.store.kernel.js";
import type { TaskFlowRecord, TaskFlowSyncResult } from "./task-flow-registry.types.js";
import { findLatestTaskForFlowInSnapshot } from "./task-registry-records.js";
import {
  readTaskRegistryMutationSnapshotInDatabase,
  readTaskRegistrySnapshot,
  upsertTaskWithDeliveryStateInDatabase,
} from "./task-registry.store.kernel.js";

export type TaskMirroredFlowSyncOutcome = {
  taskId: string;
  flowId?: string;
} & (
  | { kind: "result"; result: TaskFlowSyncResult }
  | { kind: "error"; error: ReturnType<typeof serializeAgentSchemaInspectionError> }
);

export type TaskRegistryRestoreResult = TaskExecutionRestoreResult & {
  flowSyncs: TaskMirroredFlowSyncOutcome[];
};

const log = createSubsystemLogger("tasks/task-flow-registry");

export function syncTaskMirroredFlowInDatabase(
  database: OpenClawStateDatabase,
  params: { taskId: string; expectedParentFlowId?: string },
): TaskMirroredFlowSyncOutcome {
  let flowId = params.expectedParentFlowId?.trim();
  let committedFlow: TaskFlowRecord | undefined;
  let attemptedCurrent: TaskFlowRecord | undefined;
  const outcome = (result: TaskFlowSyncResult): TaskMirroredFlowSyncOutcome => ({
    taskId: params.taskId,
    ...(flowId ? { flowId } : {}),
    kind: "result",
    result,
  });
  try {
    return runOpenClawStateWriteTransaction(
      ({ db }) => {
        const snapshot = readTaskRegistrySnapshot(database);
        const task = snapshot.tasks.get(params.taskId);
        const currentParentFlowId = task?.parentFlowId?.trim();
        if (
          !task ||
          !currentParentFlowId ||
          (params.expectedParentFlowId !== undefined && currentParentFlowId !== flowId)
        ) {
          return outcome({ ok: true, flow: null });
        }
        flowId = currentParentFlowId;
        const latest = findLatestTaskForFlowInSnapshot(snapshot.tasks, flowId);
        if (latest?.taskId !== task.taskId) {
          return outcome({ ok: true, flow: null });
        }
        const stored = readTaskFlowRecord(database.db, flowId);
        if (!stored) {
          return outcome({ ok: true, flow: null });
        }
        const current = normalizeRestoredFlowRecord(stored);
        if (current.syncMode !== "task_mirrored") {
          return outcome({ ok: true, flow: current });
        }
        const prepared = prepareTaskMirroredFlowSyncFromCurrent(task, current);
        if (isTaskMirroredFlowSyncUnchanged(prepared)) {
          return outcome({ ok: true, flow: current });
        }
        attemptedCurrent = current;
        requestSqliteWorkerOperationAdmission({
          stage: "transaction",
          facts: { kind: "task-restored-flow", taskId: task.taskId, flowId },
        });
        upsertTaskFlowRowInDatabase(db, bindTaskFlowRecord(prepared.next));
        deferSqlitePostCommitPublication(db, () => {
          committedFlow = prepared.next;
        });
        return outcome({ ok: true, flow: prepared.next });
      },
      { database, path: database.path, env: getSqliteWorkerStateContext().environment },
      { operationLabel: "task.flow.sync" },
    );
  } catch (error) {
    if (committedFlow) {
      log.warn("Task-mirrored flow sync committed before cleanup failed", {
        taskId: params.taskId,
        flowId,
        error,
      });
      return outcome({ ok: true, flow: committedFlow });
    }
    if (attemptedCurrent) {
      log.warn("Failed to persist task-mirrored flow sync", {
        taskId: params.taskId,
        flowId,
        error,
      });
      return outcome({ ok: false, reason: "persist_failed", current: attemptedCurrent });
    }
    return {
      taskId: params.taskId,
      ...(flowId ? { flowId } : {}),
      kind: "error",
      error: serializeAgentSchemaInspectionError(error),
    };
  }
}

/** Keep task settlement and best-effort parent-flow updates in their separate transactions. */
export function restoreTaskRegistryInDatabase(
  database: OpenClawStateDatabase,
): TaskRegistryRestoreResult {
  const restored = restoreTaskExecutionSnapshot({
    loadSnapshot: () => readTaskRegistrySnapshot(database),
    loadMutationSnapshot: (scopes) =>
      readTaskRegistryMutationSnapshotInDatabase(database.db, scopes),
    withMutation: (operation) =>
      runOpenClawStateWriteTransaction(
        operation,
        { database, path: database.path, env: getSqliteWorkerStateContext().environment },
        { operationLabel: "task.mutation" },
      ),
    upsertTaskWithDeliveryState: (params) =>
      upsertTaskWithDeliveryStateInDatabase(database, params),
  });
  const flowSyncs = restored.settledTasks.flatMap((task) => {
    const flowId = task.parentFlowId?.trim();
    return flowId
      ? [
          syncTaskMirroredFlowInDatabase(database, {
            taskId: task.taskId,
            expectedParentFlowId: flowId,
          }),
        ]
      : [];
  });
  return { ...restored, flowSyncs };
}
