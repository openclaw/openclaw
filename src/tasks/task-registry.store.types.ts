// Defines storage contracts for task registry records and observer events.
import type { TaskFlowSyncResult } from "./task-flow-registry.types.js";
import type { TaskDeliveryState, TaskRecord } from "./task-registry.types.js";

/** Full task registry snapshot used for persistence restore and replacement writes. */
export type TaskRegistryStoreSnapshot = {
  tasks: Map<string, TaskRecord>;
  deliveryStates: Map<string, TaskDeliveryState>;
};

export type TaskExecutionRestoreStore = {
  loadSnapshot: () => TaskRegistryStoreSnapshot;
  withMutation?: <T>(operation: () => T) => T;
  upsertTaskWithDeliveryState: (params: {
    task: TaskRecord;
    deliveryState?: TaskDeliveryState;
  }) => void;
};

export type TaskRegistryMutationScope = {
  taskId: string;
  flowId?: string;
  runId?: string;
  childSessionKey?: string;
};

export type TaskLiveFlowSelection = {
  taskId: string;
  flowId: string;
  createdAt: number;
};

export type TaskLiveFlowSyncOutcome =
  | { kind: "not-selected" }
  | { kind: "retry"; reason: "storage_contention" | "projection_changed" }
  | { kind: "result"; result: TaskFlowSyncResult };

export type TaskLiveFlowAuthority = {
  assertCurrent(): void;
  isSelected(selection: TaskLiveFlowSelection): boolean;
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
