// Defines storage contracts for managed task-flow records.
import type { TaskFlowRecord } from "./task-flow-registry.types.js";

/** Full task-flow registry snapshot used for persistence restore and replacement writes. */
export type TaskFlowRegistryStoreSnapshot = {
  flows: Map<string, TaskFlowRecord>;
};

type TaskFlowRegistryAtomicChange = {
  flow: TaskFlowRecord;
  expectedRevision?: number;
};

export type TaskFlowRegistryAtomicOwnerCondition = {
  ownerKey: string;
  controllerId: string;
  statuses: readonly TaskFlowRecord["status"][];
  expectedFlows: ReadonlyArray<Pick<TaskFlowRecord, "flowId" | "revision" | "status">>;
  excludeCancelRequested?: boolean;
};

export type TaskFlowRegistryAtomicWrite = {
  changes: readonly TaskFlowRegistryAtomicChange[];
  ownerCondition?: TaskFlowRegistryAtomicOwnerCondition;
};
