import { serializeAgentSchemaInspectionError } from "../state/openclaw-agent-schema-inspection-response.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { restoreTaskExecutionSnapshot } from "../tasks/task-execution-owner.js";
import {
  applyFlowPatch,
  isTaskMirroredFlowSyncUnchanged,
  normalizeRestoredFlowRecord,
  prepareTaskMirroredFlowSyncFromCurrent,
} from "../tasks/task-flow-registry.records.js";
import type { getTaskFlowRegistryStore } from "../tasks/task-flow-registry.store.js";
import type {
  TaskFlowRegistryMirroredSync,
  TaskFlowRegistryObservedUpdate,
  TaskFlowRegistryStoreSnapshot,
} from "../tasks/task-flow-registry.store.types.js";
import { findLatestTaskForFlowInSnapshot } from "../tasks/task-registry-records.js";
import type {
  TaskMirroredFlowSyncOutcome,
  TaskRegistryRestoreResult,
} from "../tasks/task-registry-restore.worker.js";
import type { TaskRegistryStore, TaskRegistryStoreSnapshot } from "../tasks/task-registry.store.js";
import type { TaskRegistryMutationScope } from "../tasks/task-registry.store.types.js";

type TaskFlowRegistryStore = ReturnType<typeof getTaskFlowRegistryStore>;

function syncRestoredTaskFlow(
  taskStore: TaskRegistryStore,
  flowStore: TaskFlowRegistryStore,
  params: { taskId: string; expectedParentFlowId?: string },
): TaskMirroredFlowSyncOutcome {
  const { taskId } = params;
  let flowId = params.expectedParentFlowId?.trim();
  try {
    const snapshot = taskStore.loadSnapshot();
    const task = snapshot.tasks.get(taskId);
    const currentParentFlowId = task?.parentFlowId?.trim();
    if (
      !task ||
      !currentParentFlowId ||
      (params.expectedParentFlowId !== undefined && currentParentFlowId !== flowId)
    ) {
      return { taskId, flowId, kind: "result", result: { ok: true, flow: null } };
    }
    flowId = currentParentFlowId;
    if (findLatestTaskForFlowInSnapshot(snapshot.tasks, flowId)?.taskId !== taskId) {
      return { taskId, flowId, kind: "result", result: { ok: true, flow: null } };
    }
    const stored = flowStore.loadSnapshot().flows.get(flowId);
    if (!stored) {
      return { taskId, flowId, kind: "result", result: { ok: true, flow: null } };
    }
    const current = normalizeRestoredFlowRecord(stored);
    if (current.syncMode !== "task_mirrored") {
      return { taskId, flowId, kind: "result", result: { ok: true, flow: current } };
    }
    const prepared = prepareTaskMirroredFlowSyncFromCurrent(task, current);
    if (isTaskMirroredFlowSyncUnchanged(prepared)) {
      return { taskId, flowId, kind: "result", result: { ok: true, flow: current } };
    }
    try {
      flowStore.upsertFlow(prepared.next);
      return { taskId, flowId, kind: "result", result: { ok: true, flow: prepared.next } };
    } catch {
      return {
        taskId,
        flowId,
        kind: "result",
        result: { ok: false, reason: "persist_failed", current },
      };
    }
  } catch (error) {
    return {
      taskId,
      flowId,
      kind: "error",
      error: serializeAgentSchemaInspectionError(error),
    };
  }
}

export function createInMemoryTaskRegistryStore(
  snapshot: TaskRegistryStoreSnapshot = { tasks: new Map(), deliveryStates: new Map() },
  flowStore?: TaskFlowRegistryStore,
): TaskRegistryStore {
  const state = structuredClone(snapshot);
  return {
    async syncLiveTaskFlowAsync(_context, params, authority) {
      if (!flowStore) {
        throw new Error(
          "In-memory live task-flow synchronization requires an explicit flow store.",
        );
      }
      authority.assertCurrent();
      const task = structuredClone(state.tasks.get(params.taskId));
      if (
        !task ||
        task.parentFlowId?.trim() !== params.flowId ||
        !authority.isSelected({ ...params, createdAt: task.createdAt })
      ) {
        return { kind: "not-selected" };
      }
      authority.assertCurrent();
      const current = flowStore.loadSnapshot().flows.get(params.flowId);
      try {
        const result = flowStore.syncMirroredTask(task, () => ({
          stage() {},
          rollback() {},
          commit() {},
          publish() {},
        }));
        return { kind: "result", result: { ok: true, flow: result.flow } };
      } catch (error) {
        if (!current) {
          throw error;
        }
        return { kind: "result", result: { ok: false, reason: "persist_failed", current } };
      }
    },
    async withSnapshotAsync<T>(
      this: TaskRegistryStore,
      _context: OpenClawStateWorkerContext,
      consume: (result: TaskRegistryRestoreResult) => T,
    ): Promise<T> {
      const restored = restoreTaskExecutionSnapshot(this);
      const flowSyncs = restored.settledTasks.flatMap((task) => {
        const flowId = task.parentFlowId?.trim();
        if (!flowId) {
          return [];
        }
        if (!flowStore) {
          throw new Error(
            "In-memory task restoration with linked settlements requires an explicit flow store.",
          );
        }
        return [
          syncRestoredTaskFlow(this, flowStore, {
            taskId: task.taskId,
            expectedParentFlowId: flowId,
          }),
        ];
      });
      return consume({ ...restored, flowSyncs });
    },
    async syncTaskFlowAsync(
      this: TaskRegistryStore,
      _context: OpenClawStateWorkerContext,
      params: { taskId: string; expectedParentFlowId?: string },
    ): Promise<TaskMirroredFlowSyncOutcome> {
      if (!flowStore) {
        throw new Error("In-memory task flow synchronization requires an explicit flow store.");
      }
      return syncRestoredTaskFlow(this, flowStore, params);
    },
    loadSnapshot: () => structuredClone(state),
    async loadMutationSnapshotAsync(
      this: TaskRegistryStore,
      _context: OpenClawStateWorkerContext,
      scope?: TaskRegistryMutationScope,
    ): Promise<TaskRegistryStoreSnapshot> {
      const projectionSnapshot = structuredClone(this.loadSnapshot());
      if (!scope) {
        return projectionSnapshot;
      }
      const tasks = new Map(
        [...projectionSnapshot.tasks].filter(
          ([taskId, task]) =>
            taskId === scope.taskId ||
            Boolean(scope.runId?.trim() && task.runId?.trim() === scope.runId.trim()) ||
            Boolean(
              scope.childSessionKey?.trim() &&
              task.childSessionKey?.trim() === scope.childSessionKey.trim(),
            ),
        ),
      );
      return {
        tasks,
        deliveryStates: new Map(
          [...projectionSnapshot.deliveryStates].filter(([taskId]) => tasks.has(taskId)),
        ),
      };
    },
    upsertTaskWithDeliveryState: ({ task, deliveryState }) => {
      const nextTask = structuredClone(task);
      const nextDeliveryState = deliveryState ? structuredClone(deliveryState) : undefined;
      state.tasks.set(task.taskId, nextTask);
      if (nextDeliveryState) {
        state.deliveryStates.set(task.taskId, nextDeliveryState);
      } else {
        state.deliveryStates.delete(task.taskId);
      }
    },
    deleteTaskWithDeliveryState: (taskId) => {
      state.tasks.delete(taskId);
      state.deliveryStates.delete(taskId);
    },
    upsertDeliveryState: (deliveryState) => {
      state.deliveryStates.set(deliveryState.taskId, structuredClone(deliveryState));
    },
  };
}

export function createInMemoryTaskFlowRegistryStore(
  snapshot: TaskFlowRegistryStoreSnapshot = { flows: new Map() },
): TaskFlowRegistryStore {
  const state = structuredClone(snapshot);
  return {
    withSnapshotAsync: async (_context, consume) => consume(structuredClone(state)),
    readFlowAsync: async (_context, flowId) => structuredClone(state.flows.get(flowId)),
    loadSnapshot: () => structuredClone(state),
    upsertFlow: (flow) => {
      state.flows.set(flow.flowId, structuredClone(flow));
    },
    syncMirroredTask(task, preparePublication) {
      const stored = state.flows.get(task.parentFlowId?.trim() ?? "");
      let result: TaskFlowRegistryMirroredSync = { changed: false, flow: null };
      if (stored) {
        const current = normalizeRestoredFlowRecord(stored);
        result = { changed: false, flow: current };
        if (current.syncMode === "task_mirrored") {
          const prepared = prepareTaskMirroredFlowSyncFromCurrent(task, current);
          if (!isTaskMirroredFlowSyncUnchanged(prepared)) {
            this.upsertFlow(prepared.next);
            result = { changed: true, flow: prepared.next, previous: current };
          }
        }
      }
      const publication = preparePublication(result);
      publication.stage();
      publication.commit();
      publication.publish();
      return result;
    },
    updateFlow: (params, preparePublication) => {
      const publish = (result: TaskFlowRegistryObservedUpdate) => {
        const publication = preparePublication(result);
        publication.stage();
        publication.commit();
        publication.publish();
        return result;
      };
      const stored = state.flows.get(params.flowId);
      if (!stored) {
        return publish({ applied: false, reason: "not_found" });
      }
      const current = normalizeRestoredFlowRecord(stored);
      if (current.revision !== params.expectedRevision) {
        return publish({
          applied: false,
          reason: "revision_conflict",
          current: structuredClone(current),
        });
      }
      let flow;
      try {
        flow = applyFlowPatch(current, params.patch);
      } catch (error) {
        return { applied: false, reason: "invalid_patch", error };
      }
      state.flows.set(flow.flowId, structuredClone(flow));
      return publish({ applied: true, previous: structuredClone(current), flow });
    },
    deleteFlow: (flowId) => {
      state.flows.delete(flowId);
    },
  };
}
