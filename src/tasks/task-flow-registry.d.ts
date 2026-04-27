import type { TaskFlowRecord, TaskFlowStatus, TaskFlowSyncMode, JsonValue } from "./task-flow-registry.types.js";
import type { TaskNotifyPolicy, TaskRecord } from "./task-registry.types.js";
type FlowRecordPatch = Omit<Partial<Pick<TaskFlowRecord, "status" | "notifyPolicy" | "goal" | "currentStep" | "blockedTaskId" | "blockedSummary" | "controllerId" | "stateJson" | "waitJson" | "cancelRequestedAt" | "updatedAt" | "endedAt">>, "currentStep" | "blockedTaskId" | "blockedSummary" | "controllerId" | "stateJson" | "waitJson" | "cancelRequestedAt" | "endedAt"> & {
    currentStep?: string | null;
    blockedTaskId?: string | null;
    blockedSummary?: string | null;
    controllerId?: string | null;
    stateJson?: JsonValue | null;
    waitJson?: JsonValue | null;
    cancelRequestedAt?: number | null;
    endedAt?: number | null;
};
type FlowRecordCreateFields = {
    ownerKey: string;
    requesterOrigin?: TaskFlowRecord["requesterOrigin"];
    status?: TaskFlowStatus;
    notifyPolicy?: TaskNotifyPolicy;
    goal: string;
    currentStep?: string | null;
    blockedTaskId?: string | null;
    blockedSummary?: string | null;
    stateJson?: JsonValue | null;
    waitJson?: JsonValue | null;
    cancelRequestedAt?: number | null;
    createdAt?: number;
    updatedAt?: number;
    endedAt?: number | null;
};
export type CreateFlowRecordParams = FlowRecordCreateFields & {
    syncMode?: TaskFlowSyncMode;
    controllerId?: string | null;
    revision?: number;
};
export type TaskFlowUpdateResult = {
    applied: true;
    flow: TaskFlowRecord;
} | {
    applied: false;
    reason: "not_found" | "revision_conflict";
    current?: TaskFlowRecord;
};
export declare function deriveTaskFlowStatusFromTask(task: Pick<TaskRecord, "status" | "terminalOutcome">): TaskFlowStatus;
export declare function getTaskFlowRegistryRestoreFailure(): string | null;
export declare function createFlowRecord(params: CreateFlowRecordParams): TaskFlowRecord;
export declare function createManagedTaskFlow(params: FlowRecordCreateFields & {
    controllerId: string;
}): TaskFlowRecord;
export declare function createTaskFlowForTask(params: {
    task: Pick<TaskRecord, "ownerKey" | "taskId" | "notifyPolicy" | "status" | "terminalOutcome" | "label" | "task" | "createdAt" | "lastEventAt" | "endedAt" | "terminalSummary" | "progressSummary">;
    requesterOrigin?: TaskFlowRecord["requesterOrigin"];
}): TaskFlowRecord;
export declare function updateFlowRecordByIdExpectedRevision(params: {
    flowId: string;
    expectedRevision: number;
    patch: FlowRecordPatch;
}): TaskFlowUpdateResult;
export declare function setFlowWaiting(params: {
    flowId: string;
    expectedRevision: number;
    currentStep?: string | null;
    stateJson?: JsonValue | null;
    waitJson?: JsonValue | null;
    blockedTaskId?: string | null;
    blockedSummary?: string | null;
    updatedAt?: number;
}): TaskFlowUpdateResult;
export declare function resumeFlow(params: {
    flowId: string;
    expectedRevision: number;
    status?: Extract<TaskFlowStatus, "queued" | "running">;
    currentStep?: string | null;
    stateJson?: JsonValue | null;
    updatedAt?: number;
}): TaskFlowUpdateResult;
export declare function finishFlow(params: {
    flowId: string;
    expectedRevision: number;
    currentStep?: string | null;
    stateJson?: JsonValue | null;
    updatedAt?: number;
    endedAt?: number;
}): TaskFlowUpdateResult;
export declare function failFlow(params: {
    flowId: string;
    expectedRevision: number;
    currentStep?: string | null;
    stateJson?: JsonValue | null;
    blockedTaskId?: string | null;
    blockedSummary?: string | null;
    updatedAt?: number;
    endedAt?: number;
}): TaskFlowUpdateResult;
export declare function requestFlowCancel(params: {
    flowId: string;
    expectedRevision: number;
    cancelRequestedAt?: number;
    updatedAt?: number;
}): TaskFlowUpdateResult;
export declare function syncFlowFromTask(task: Pick<TaskRecord, "parentFlowId" | "status" | "terminalOutcome" | "notifyPolicy" | "label" | "task" | "lastEventAt" | "endedAt" | "taskId" | "terminalSummary" | "progressSummary">): TaskFlowRecord | null;
export declare function getTaskFlowById(flowId: string): TaskFlowRecord | undefined;
export declare function listTaskFlowsForOwnerKey(ownerKey: string): TaskFlowRecord[];
export declare function findLatestTaskFlowForOwnerKey(ownerKey: string): TaskFlowRecord | undefined;
export declare function resolveTaskFlowForLookupToken(token: string): TaskFlowRecord | undefined;
export declare function listTaskFlowRecords(): TaskFlowRecord[];
export declare function deleteTaskFlowRecordById(flowId: string): boolean;
export declare function resetTaskFlowRegistryForTests(opts?: {
    persist?: boolean;
}): void;
export {};
