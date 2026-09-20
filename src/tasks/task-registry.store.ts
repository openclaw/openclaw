import { createSqliteLifecycleAggregateError } from "../infra/sqlite-coordinator.js";
import type { SqliteWorkerNativeSettlementOwner } from "../infra/sqlite-worker-operation-settlement.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import type { TaskInitialWorkerOperations } from "./task-initial-worker.types.js";
import type {
  TaskAgentEventInput,
  TaskAgentEventReceipt,
} from "./task-registry-agent-event.operation.js";
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
  upsertTaskWithDeliveryStateToSqlite,
  upsertTaskDeliveryStateToSqlite,
  withTaskRegistrySqliteMutation,
  settleTaskRegistrySqliteWrites,
} from "./task-registry.store.sqlite.js";
import type {
  TaskExecutionRestoreStore,
  TaskLiveFlowAuthority,
  TaskLiveFlowSyncOutcome,
  TaskRegistryMutationScope,
  TaskRegistryStoreSnapshot,
  TaskRegistryObserverEvent,
} from "./task-registry.store.types.js";
import type { TaskDeliveryState, TaskRecord } from "./task-registry.types.js";

export type { TaskRegistryStoreSnapshot } from "./task-registry.store.types.js";

export type TaskRegistryStore = TaskExecutionRestoreStore & {
  runAgentEventMutationAsync(
    context: OpenClawStateWorkerContext,
    input: TaskAgentEventInput,
    assertCurrent: () => void,
    onGranted: (owner: SqliteWorkerNativeSettlementOwner) => void,
  ): Promise<TaskAgentEventReceipt | null>;
  settleAgentEventWrites(join: (deadlineMs: number) => void): void;
  runInitialMutationAsync<Key extends keyof TaskInitialWorkerOperations>(
    context: OpenClawStateWorkerContext,
    command: { type: Key; input: TaskInitialWorkerOperations[Key]["input"] },
    assertCurrent: () => void,
    onGranted?: (owner: SqliteWorkerNativeSettlementOwner) => void,
  ): Promise<TaskInitialWorkerOperations[Key]["output"]>;
  syncLiveTaskFlowAsync(
    context: OpenClawStateWorkerContext,
    params: { taskId: string; flowId: string },
    authority: TaskLiveFlowAuthority,
  ): Promise<TaskLiveFlowSyncOutcome>;
  withSnapshotAsync<T>(
    context: OpenClawStateWorkerContext,
    consume: (snapshot: TaskRegistryRestoreResult) => T,
  ): Promise<T>;
  syncTaskFlowAsync: (
    context: OpenClawStateWorkerContext,
    params: { taskId: string; expectedParentFlowId?: string },
  ) => Promise<TaskMirroredFlowSyncOutcome>;
  loadMutationSnapshotAsync: (
    context: OpenClawStateWorkerContext,
    scope?: TaskRegistryMutationScope,
  ) => Promise<TaskRegistryStoreSnapshot>;
  loadMutationSnapshot?: (scope: TaskRegistryMutationScope) => TaskRegistryStoreSnapshot;
  listTasksForOwnerKey?: (ownerKey: string) => Promise<TaskRecord[]>;
  deleteTaskWithDeliveryState: (taskId: string) => void;
  upsertDeliveryState: (state: TaskDeliveryState) => void;
  close?: () => void;
};

type TaskRegistryObservers = {
  // Observers are incremental/best-effort only. Persistence belongs to TaskRegistryStore.
  onEvent?: (event: TaskRegistryObserverEvent) => void;
};

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
  async loadMutationSnapshotAsync(context, scope) {
    const { executeOpenClawStateWorker } = await import("../state/openclaw-state-worker-store.js");
    return executeOpenClawStateWorker(context, { type: "tasks.mutationSnapshot", input: scope });
  },
  loadMutationSnapshot: loadTaskRegistryMutationStateFromSqlite,
  withMutation: withTaskRegistrySqliteMutation,
  async listTasksForOwnerKey(ownerKey) {
    const context = captureOpenClawStateWorkerContext();
    const { executeOpenClawStateWorker } = await import("../state/openclaw-state-worker-store.js");
    return executeOpenClawStateWorker(context, { type: "tasks.ownerRecords", input: { ownerKey } });
  },
  upsertTaskWithDeliveryState: upsertTaskWithDeliveryStateToSqlite,
  deleteTaskWithDeliveryState: deleteTaskAndDeliveryStateFromSqlite,
  upsertDeliveryState: upsertTaskDeliveryStateToSqlite,
  close: closeTaskRegistryDatabase,
};

let configuredTaskRegistryStore: TaskRegistryStore = defaultTaskRegistryStore;
let configuredTaskRegistryObservers: TaskRegistryObservers | null = null;

export async function loadTaskRegistryMutationSnapshots(
  context: OpenClawStateWorkerContext,
  store: TaskRegistryStore,
  scopes: ReadonlyArray<TaskRegistryMutationScope | undefined>,
): Promise<
  Array<{ scope: TaskRegistryMutationScope | undefined; snapshot: TaskRegistryStoreSnapshot }>
> {
  const snapshotReads = scopes.map(async (scope) => ({
    scope,
    snapshot: await store.loadMutationSnapshotAsync(context, scope),
  }));
  return Promise.all(snapshotReads).catch(async (error: unknown) => {
    // Each read owns a worker scope; join its siblings before releasing this owner.
    const settled = await Promise.allSettled(snapshotReads);
    const errors = settled.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length > 1) {
      throw createSqliteLifecycleAggregateError(
        errors,
        "Task registry projection reads failed",
        error,
      );
    }
    throw error;
  });
}

export function getTaskRegistryStore(): TaskRegistryStore {
  return configuredTaskRegistryStore;
}

export function getTaskRegistryObservers(): TaskRegistryObservers | null {
  return configuredTaskRegistryObservers;
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
