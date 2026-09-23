import { createSubsystemLogger } from "../logging/subsystem.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import type { TaskRegistryObservers, TaskRegistryStore } from "./task-registry-runtime.types.js";
import { getTaskRegistryProcessState } from "./task-registry.process-state.js";
// Stores task registry records in memory and bridges persistence runtime hooks.
import {
  closeTaskRegistryDatabase,
  deleteTaskAndDeliveryStateFromSqlite,
  loadTaskRegistryStateFromSqlite,
  loadTaskRegistryMutationStateFromSqlite,
  upsertTaskWithDeliveryStateToSqlite,
  upsertTaskDeliveryStateToSqlite,
  withTaskRegistrySqliteMutation,
  settleTaskRegistrySqliteWrites,
} from "./task-registry.store.sqlite.js";
import type { TaskRegistryObserverEvent } from "./task-registry.store.types.js";
import type { TaskDeliveryState, TaskRecord } from "./task-registry.types.js";

export type { TaskRegistryObservers, TaskRegistryStore } from "./task-registry-runtime.types.js";
export type { TaskRegistryStoreSnapshot } from "./task-registry.store.types.js";

const defaultTaskRegistryStore: TaskRegistryStore = {
  async runAgentEventMutationAsync(context, input, assertCurrent, onGranted) {
    const { runTaskRegistryWorkerOperation } = await import("./task-registry-worker-operation.js");
    return runTaskRegistryWorkerOperation(
      context,
      { type: "tasks.observeAgentEvent", input },
      assertCurrent,
      onGranted,
    );
  },
  settleAgentEventWrites: settleTaskRegistrySqliteWrites,
  async runInitialMutationAsync(context, command, assertCurrent, onGranted) {
    const { runTaskRegistryWorkerOperation } = await import("./task-registry-worker-operation.js");
    return runTaskRegistryWorkerOperation(context, command, assertCurrent, onGranted);
  },
  async syncLiveTaskFlowAsync(context, params, authority) {
    const { syncLiveTaskFlowWithWorker } = await import("./task-registry-live-flow-sync.js");
    return syncLiveTaskFlowWithWorker(context, params, authority);
  },
  async withSnapshotAsync(context, consume) {
    const { runTaskFlowRestoreWorkerOperation } = await import("./task-flow-restore-store.js");
    return runTaskFlowRestoreWorkerOperation(
      context,
      { type: "tasks.restore", input: undefined },
      consume,
    );
  },
  async syncTaskFlowAsync(context, params) {
    const { runTaskFlowRestoreWorkerOperation } = await import("./task-flow-restore-store.js");
    return runTaskFlowRestoreWorkerOperation(
      context,
      { type: "flows.syncMirroredTask", input: params },
      async (result, reconcileFlows) => {
        await reconcileFlows();
        return result;
      },
    );
  },
  loadSnapshot: loadTaskRegistryStateFromSqlite,
  async loadMutationSnapshotAsync(context, scope) {
    const reply = await executeExistingOpenClawStateRead(
      { path: context.admission.databasePath, env: context.environment },
      { type: "tasks.mutationSnapshot", input: scope },
      { context },
    );
    if (!reply) {
      throw new Error("Task registry snapshot requires an admitted database");
    }
    if (!reply.ok || reply.type !== "tasks.mutationSnapshot") {
      throw new Error("Unexpected task registry snapshot result");
    }
    return reply.snapshot;
  },
  loadMutationSnapshot: loadTaskRegistryMutationStateFromSqlite,
  withMutation: withTaskRegistrySqliteMutation,
  async listTasksForOwnerKey(context, ownerKey, assertCurrent) {
    const { executeOpenClawStateWorker } = await import("../state/openclaw-state-worker-store.js");
    assertCurrent();
    const records = await executeOpenClawStateWorker(context, {
      type: "tasks.ownerRecords",
      input: { ownerKey },
    });
    assertCurrent();
    return records;
  },
  upsertTaskWithDeliveryState: upsertTaskWithDeliveryStateToSqlite,
  deleteTaskWithDeliveryState: deleteTaskAndDeliveryStateFromSqlite,
  upsertDeliveryState: upsertTaskDeliveryStateToSqlite,
  close: closeTaskRegistryDatabase,
};

const runtime = getTaskRegistryProcessState().runtime;

export function getTaskRegistryStore(): TaskRegistryStore {
  return (runtime.store ??= defaultTaskRegistryStore);
}

export function getTaskRegistryObservers(): TaskRegistryObservers | null {
  return runtime.observers;
}

/** Subscribe at the publication owner; readers recheck current task authority. */
export function onTaskRegistryChange(
  listener: (event?: TaskRegistryObserverEvent) => void,
): () => void {
  const listeners = getTaskRegistryProcessState().changeListeners;
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function configureTaskRegistryRuntime(params: {
  store?: TaskRegistryStore;
  observers?: TaskRegistryObservers | null;
}) {
  if (params.store) {
    runtime.store = params.store;
  }
  if ("observers" in params) {
    runtime.observers = params.observers ?? null;
  }
}

export function resetTaskRegistryRuntimeForTests() {
  getTaskRegistryStore().close?.();
  runtime.store = defaultTaskRegistryStore;
  runtime.observers = null;
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
  let event: TaskRegistryObserverEvent | undefined;
  try {
    event = createEvent();
    recordPublication(event);
    observers?.onEvent?.(event);
  } catch (error) {
    storeLog.warn("Task registry observer failed", { event: "task-registry", error });
  } finally {
    for (const listener of state.changeListeners) {
      try {
        listener(event);
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
