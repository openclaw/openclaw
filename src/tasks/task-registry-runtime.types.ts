import type { SqliteWorkerNativeSettlementOwner } from "../infra/sqlite-worker-operation-settlement.js";
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
import type {
  TaskExecutionRestoreStore,
  TaskLiveFlowAuthority,
  TaskLiveFlowSyncOutcome,
  TaskRegistryMutationScope,
  TaskRegistryStoreSnapshot,
} from "./task-registry.store.types.js";
import type { TaskDeliveryState, TaskRecord } from "./task-registry.types.js";

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
    consume: (snapshot: TaskRegistryRestoreResult, reconcileFlows: () => Promise<void>) => T,
  ): Promise<T>;
  syncTaskFlowAsync: (
    context: OpenClawStateWorkerContext,
    params: { taskId: string; expectedParentFlowId?: string },
  ) => Promise<TaskMirroredFlowSyncOutcome>;
  loadMutationSnapshotAsync: (
    context: OpenClawStateWorkerContext,
    scope?: TaskRegistryMutationScope | readonly TaskRegistryMutationScope[],
  ) => Promise<TaskRegistryStoreSnapshot>;
  loadMutationSnapshot?: (
    scopes: readonly TaskRegistryMutationScope[],
  ) => TaskRegistryStoreSnapshot;
  listTasksForOwnerKey?: (
    context: OpenClawStateWorkerContext,
    ownerKey: string,
    assertCurrent: () => void,
  ) => Promise<TaskRecord[]>;
  deleteTaskWithDeliveryState: (taskId: string) => void;
  upsertDeliveryState: (state: TaskDeliveryState) => void;
  close?: () => void;
};

export type { TaskRegistryObservers } from "./task-registry.store.types.js";
