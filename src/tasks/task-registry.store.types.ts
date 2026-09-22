// Defines storage contracts for task registry records and observer events.
import type { TaskDeliveryState, TaskRecord } from "./task-registry.types.js";

/** Full task registry snapshot used for persistence restore and replacement writes. */
export type TaskRegistryStoreSnapshot = {
  tasks: Map<string, TaskRecord>;
  deliveryStates: Map<string, TaskDeliveryState>;
};

export type TaskRegistryMutationScope = {
  taskId: string;
  flowId: string;
  runId?: string;
  childSessionKey?: string;
};
