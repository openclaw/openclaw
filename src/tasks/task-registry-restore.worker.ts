import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import { getSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { serializeAgentSchemaInspectionError } from "../state/openclaw-agent-schema-inspection-response.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db-contract.js";
import { withSharedStateWriteCoordinator } from "../state/openclaw-state-db-write-coordination.js";
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
  const outcome = (result: TaskFlowSyncResult): TaskMirroredFlowSyncOutcome => ({
    taskId: params.taskId,
    ...(flowId ? { flowId } : {}),
    kind: "result",
    result,
  });
  try {
    return withSharedStateWriteCoordinator(
      { databasePath: database.path, existing: database.db, operationLabel: "task.flow.sync" },
      () => {
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
        try {
          runOpenClawStateWriteTransaction(
            ({ db }) => {
              upsertTaskFlowRowInDatabase(db, bindTaskFlowRecord(prepared.next));
              deferSqlitePostCommitPublication(db, () => {
                committedFlow = prepared.next;
              });
            },
            { database, path: database.path, env: getSqliteWorkerStateContext().environment },
          );
          return outcome({ ok: true, flow: prepared.next });
        } catch (error) {
          if (committedFlow) {
            log.warn("Task-mirrored flow sync committed before cleanup failed", {
              taskId: task.taskId,
              flowId,
              error,
            });
            return outcome({ ok: true, flow: committedFlow });
          }
          log.warn("Failed to persist task-mirrored flow sync", {
            taskId: task.taskId,
            flowId,
            error,
          });
          return outcome({ ok: false, reason: "persist_failed", current });
        }
      },
    );
  } catch (error) {
    // A coordinator cleanup failure must not invite replay of a committed flow update.
    if (committedFlow) {
      log.warn("Task-mirrored flow sync committed before coordinator cleanup failed", {
        taskId: params.taskId,
        flowId,
        error,
      });
      return outcome({ ok: true, flow: committedFlow });
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
    withMutation: (operation) =>
      withSharedStateWriteCoordinator(
        { databasePath: database.path, existing: database.db, operationLabel: "task.mutation" },
        operation,
      ),
    upsertTaskWithDeliveryState: (params) =>
      runOpenClawStateWriteTransaction(
        (writer) => upsertTaskWithDeliveryStateInDatabase(writer, params),
        { database, path: database.path, env: getSqliteWorkerStateContext().environment },
      ),
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
