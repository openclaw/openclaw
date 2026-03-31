import type { OpenClawConfig } from "../config/config.js";
import {
  cancelTaskById,
  createTaskRecord,
  markTaskLostById,
  markTaskRunningByRunId,
  markTaskTerminalByRunId,
  recordTaskProgressByRunId,
  setTaskRunDeliveryStatusByRunId,
} from "./runtime-internal.js";
import type {
  TaskDeliveryState,
  TaskDeliveryStatus,
  TaskNotifyPolicy,
  TaskRecord,
  TaskRuntime,
  TaskScopeKind,
  TaskStatus,
  TaskTerminalOutcome,
} from "./task-registry.types.js";

export function createQueuedTaskRun(params: {
  runtime: TaskRuntime;
  sourceId?: string;
  requesterSessionKey?: string;
  ownerKey?: string;
  scopeKind?: TaskScopeKind;
  requesterOrigin?: TaskDeliveryState["requesterOrigin"];
  childSessionKey?: string;
  parentTaskId?: string;
  agentId?: string;
  runId?: string;
  label?: string;
  task: string;
  preferMetadata?: boolean;
  notifyPolicy?: TaskNotifyPolicy;
  deliveryStatus?: TaskDeliveryStatus;
}): TaskRecord {
  return createTaskRecord({
    ...params,
    status: "queued",
  });
}

export function createRunningTaskRun(params: {
  runtime: TaskRuntime;
  sourceId?: string;
  requesterSessionKey?: string;
  ownerKey?: string;
  scopeKind?: TaskScopeKind;
  requesterOrigin?: TaskDeliveryState["requesterOrigin"];
  childSessionKey?: string;
  parentTaskId?: string;
  agentId?: string;
  runId?: string;
  label?: string;
  task: string;
  notifyPolicy?: TaskNotifyPolicy;
  deliveryStatus?: TaskDeliveryStatus;
  preferMetadata?: boolean;
  startedAt?: number;
  lastEventAt?: number;
  progressSummary?: string | null;
}): TaskRecord {
  return createTaskRecord({
    ...params,
    status: "running",
  });
}

export function startTaskRunByRunId(params: {
  runId: string;
  runtime?: TaskRuntime;
  sessionKey?: string;
  startedAt?: number;
  lastEventAt?: number;
  progressSummary?: string | null;
  eventSummary?: string | null;
}) {
  return markTaskRunningByRunId(params);
}

export function recordTaskRunProgressByRunId(params: {
  runId: string;
  runtime?: TaskRuntime;
  sessionKey?: string;
  lastEventAt?: number;
  progressSummary?: string | null;
  eventSummary?: string | null;
}) {
  return recordTaskProgressByRunId(params);
}

export function completeTaskRunByRunId(params: {
  runId: string;
  runtime?: TaskRuntime;
  sessionKey?: string;
  endedAt: number;
  lastEventAt?: number;
  progressSummary?: string | null;
  terminalSummary?: string | null;
  terminalOutcome?: TaskTerminalOutcome | null;
}) {
  return markTaskTerminalByRunId({
    runId: params.runId,
    runtime: params.runtime,
    sessionKey: params.sessionKey,
    status: "succeeded",
    endedAt: params.endedAt,
    lastEventAt: params.lastEventAt,
    progressSummary: params.progressSummary,
    terminalSummary: params.terminalSummary,
    terminalOutcome: params.terminalOutcome,
  });
}

export function failTaskRunByRunId(params: {
  runId: string;
  runtime?: TaskRuntime;
  sessionKey?: string;
  status?: Extract<TaskStatus, "failed" | "timed_out" | "cancelled">;
  endedAt: number;
  lastEventAt?: number;
  error?: string;
  progressSummary?: string | null;
  terminalSummary?: string | null;
}) {
  return markTaskTerminalByRunId({
    runId: params.runId,
    runtime: params.runtime,
    sessionKey: params.sessionKey,
    status: params.status ?? "failed",
    endedAt: params.endedAt,
    lastEventAt: params.lastEventAt,
    error: params.error,
    progressSummary: params.progressSummary,
    terminalSummary: params.terminalSummary,
  });
}

export function markTaskRunLostById(params: {
  taskId: string;
  endedAt: number;
  lastEventAt?: number;
  error?: string;
  cleanupAfter?: number;
}) {
  return markTaskLostById(params);
}

export function setDetachedTaskDeliveryStatusByRunId(params: {
  runId: string;
  runtime?: TaskRuntime;
  sessionKey?: string;
  deliveryStatus: TaskDeliveryStatus;
}) {
  return setTaskRunDeliveryStatusByRunId(params);
}

export async function cancelDetachedTaskRunById(params: { cfg: OpenClawConfig; taskId: string }) {
  return cancelTaskById(params);
}
