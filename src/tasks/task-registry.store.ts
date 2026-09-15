import { createSubsystemLogger } from "../logging/subsystem.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import type {
  TaskRegistryRestoreResult,
  TaskMirroredFlowSyncOutcome,
} from "./task-registry-restore.worker.js";
import { getTaskRegistryProcessState } from "./task-registry.process-state.js";
// Stores task registry records in memory and bridges persistence runtime hooks.
import {
  closeTaskRegistryDatabase,
  deleteTaskAndDeliveryStateFromSqlite,
  loadTaskRegistryStateFromSqlite,
  loadTaskRegistryMutationStateFromSqlite,
  listTaskRegistryRecordsByOwnerKeyFromSqlite,
  upsertTaskWithDeliveryStateToSqlite,
  upsertTaskDeliveryStateToSqlite,
  withTaskRegistrySqliteMutation,
} from "./task-registry.store.sqlite.js";
import type {
  TaskExecutionRestoreStore,
  TaskRegistryMutationScope,
  TaskRegistryStoreSnapshot,
} from "./task-registry.store.types.js";
import type { TaskDeliveryState, TaskRecord } from "./task-registry.types.js";

export type { TaskRegistryStoreSnapshot } from "./task-registry.store.types.js";

export type TaskRegistryStore = TaskExecutionRestoreStore & {
  withSnapshotAsync<T>(
    context: OpenClawStateWorkerContext,
    consume: (snapshot: TaskRegistryRestoreResult) => T,
  ): Promise<T>;
  syncTaskFlowAsync: (
    context: OpenClawStateWorkerContext,
    params: { taskId: string; expectedParentFlowId?: string },
  ) => Promise<TaskMirroredFlowSyncOutcome>;
  loadMutationSnapshot?: (scope: TaskRegistryMutationScope) => TaskRegistryStoreSnapshot;
  listTasksForOwnerKey?: (ownerKey: string) => Promise<TaskRecord[]>;
  deleteTaskWithDeliveryState: (taskId: string) => void;
  upsertDeliveryState: (state: TaskDeliveryState) => void;
  close?: () => void;
};

type TaskRegistryObserverRecord = Omit<TaskRecord, "detail">;

export type TaskRegistryObserverEvent =
  | {
      kind: "restored";
    }
  | {
      kind: "upserted";
      task: TaskRegistryObserverRecord;
      previous?: TaskRegistryObserverRecord;
    }
  | {
      kind: "deleted";
      taskId: string;
      previous: TaskRegistryObserverRecord;
    };

type TaskRegistryObservers = {
  // Observers are incremental/best-effort only. Persistence belongs to TaskRegistryStore.
  onEvent?: (event: TaskRegistryObserverEvent) => void;
};

const defaultTaskRegistryStore: TaskRegistryStore = {
  async withSnapshotAsync(context, consume) {
    const { runOpenClawStateWorkerOperation } =
      await import("../state/openclaw-state-worker-store.js");
    return runOpenClawStateWorkerOperation(context, async (scope) => {
      const snapshot = await scope.execute({ type: "tasks.restore", input: undefined });
      // Deliver durable settlement receipts before projection admission is rechecked.
      return consume(snapshot);
    });
  },
  async syncTaskFlowAsync(context, params) {
    const { runOpenClawStateWorkerOperation } =
      await import("../state/openclaw-state-worker-store.js");
    return runOpenClawStateWorkerOperation(context, (scope) =>
      scope.execute({ type: "flows.syncMirroredTask", input: params }),
    );
  },
  loadSnapshot: loadTaskRegistryStateFromSqlite,
  loadMutationSnapshot: loadTaskRegistryMutationStateFromSqlite,
  withMutation: withTaskRegistrySqliteMutation,
  listTasksForOwnerKey: listTaskRegistryRecordsByOwnerKeyFromSqlite,
  upsertTaskWithDeliveryState: upsertTaskWithDeliveryStateToSqlite,
  deleteTaskWithDeliveryState: deleteTaskAndDeliveryStateFromSqlite,
  upsertDeliveryState: upsertTaskDeliveryStateToSqlite,
  close: closeTaskRegistryDatabase,
};

let configuredTaskRegistryStore: TaskRegistryStore = defaultTaskRegistryStore;
let configuredTaskRegistryObservers: TaskRegistryObservers | null = null;

export function getTaskRegistryStore(): TaskRegistryStore {
  return configuredTaskRegistryStore;
}

export function getTaskRegistryObservers(): TaskRegistryObservers | null {
  return configuredTaskRegistryObservers;
}

export function configureTaskRegistryRuntime(params: {
  store?: TaskRegistryStore;
  observers?: TaskRegistryObservers | null;
}) {
  if (params.store) {
    configuredTaskRegistryStore = params.store;
  }
  if ("observers" in params) {
    configuredTaskRegistryObservers = params.observers ?? null;
  }
}

export function resetTaskRegistryRuntimeForTests() {
  configuredTaskRegistryStore.close?.();
  configuredTaskRegistryStore = defaultTaskRegistryStore;
  configuredTaskRegistryObservers = null;
}

const storeLog = createSubsystemLogger("tasks/registry");

export function deliverTaskRegistryObserverEvent(
  createEvent: () => TaskRegistryObserverEvent,
  recordPublication: (event: TaskRegistryObserverEvent) => void,
): void {
  const observers = getTaskRegistryObservers();
  const state = getTaskRegistryProcessState();
  if (
    !observers?.onEvent &&
    state.projection.pending.size === 0 &&
    state.changeListeners.size === 0
  ) {
    return;
  }
  try {
    const event = createEvent();
    recordPublication(event);
    observers?.onEvent?.(event);
  } catch (error) {
    storeLog.warn("Task registry observer failed", { event: "task-registry", error });
  } finally {
    for (const listener of state.changeListeners) {
      try {
        listener();
      } catch (error) {
        storeLog.warn("Task registry change listener failed", { error });
      }
    }
  }
}

export function tryPersistTaskUpsert(
  task: TaskRecord,
  operation: string,
  pendingDeliveryState?: TaskDeliveryState,
): boolean {
  try {
    const deliveryState =
      pendingDeliveryState ?? getTaskRegistryProcessState().taskDeliveryStates.get(task.taskId);
    getTaskRegistryStore().upsertTaskWithDeliveryState({
      task,
      ...(deliveryState ? { deliveryState } : {}),
    });
    return true;
  } catch (error) {
    storeLog.warn("Failed to persist task registry upsert", {
      operation,
      taskId: task.taskId,
      runId: task.runId,
      error,
    });
    return false;
  }
}

export function tryPersistTaskDelete(taskId: string): boolean {
  try {
    getTaskRegistryStore().deleteTaskWithDeliveryState(taskId);
    return true;
  } catch (error) {
    storeLog.warn("Failed to persist task registry delete", {
      taskId,
      error,
    });
    return false;
  }
}

export function tryPersistTaskDeliveryStateUpsert(state: TaskDeliveryState): boolean {
  try {
    getTaskRegistryStore().upsertDeliveryState(state);
    return true;
  } catch (error) {
    storeLog.warn("Failed to persist task delivery state", {
      taskId: state.taskId,
      error,
    });
    return false;
  }
}
