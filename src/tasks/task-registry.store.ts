import { createSubsystemLogger } from "../logging/subsystem.js";
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
  TaskRegistryMutationScope,
  TaskRegistryStoreSnapshot,
} from "./task-registry.store.types.js";
import type { TaskDeliveryState, TaskRecord } from "./task-registry.types.js";

export type { TaskRegistryStoreSnapshot } from "./task-registry.store.types.js";

export type TaskRegistryStore = {
  loadSnapshot: () => TaskRegistryStoreSnapshot;
  loadMutationSnapshot?: (scope: TaskRegistryMutationScope) => TaskRegistryStoreSnapshot;
  withMutation?: <T>(operation: () => T) => T;
  listTasksForOwnerKey?: (ownerKey: string) => Promise<TaskRecord[]>;
  upsertTaskWithDeliveryState: (params: {
    task: TaskRecord;
    deliveryState?: TaskDeliveryState;
  }) => void;
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
