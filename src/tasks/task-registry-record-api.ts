import { normalizeTaskSummary, resolveTaskTerminalOutcome } from "./task-registry-common.js";
import { assertParentFlowLinkAllowed } from "./task-registry-flow-link.js";
import { updateTask } from "./task-registry-mutation.js";
import { cloneTaskRecord } from "./task-registry-records.js";
import { withTaskRegistryMutation, ensureTaskRegistryReady, tasks } from "./task-registry-state.js";
import { transitionTaskRecordsByRunNative } from "./task-registry-transition.native.js";
import {
  parseTaskNotifyPolicy,
  type JsonValue,
  type TaskDeliveryStatus,
  type TaskNotifyPolicy,
  type TaskRecord,
  type TaskRuntime,
  type TaskRunStateTransitionParams,
  type TaskStatus,
  type TaskTerminalOutcome,
} from "./task-registry.types.js";

export function markTaskTerminalById(params: {
  taskId: string;
  status: Extract<TaskStatus, "succeeded" | "failed" | "timed_out" | "cancelled">;
  childSessionKey?: string | null;
  endedAt: number;
  lastEventAt?: number;
  error?: string;
  terminalSummary?: string | null;
  preserveTerminalSummary?: boolean;
  terminalOutcome?: TaskTerminalOutcome | null;
  detail?: JsonValue;
}): TaskRecord | null {
  ensureTaskRegistryReady();
  const patch: Partial<TaskRecord> = {
    status: params.status,
    ...(params.childSessionKey !== undefined
      ? { childSessionKey: params.childSessionKey?.trim() || undefined }
      : {}),
    endedAt: params.endedAt,
    lastEventAt: params.lastEventAt ?? params.endedAt,
    ...(params.terminalSummary !== undefined
      ? {
          terminalSummary: params.preserveTerminalSummary
            ? (params.terminalSummary ?? undefined)
            : normalizeTaskSummary(params.terminalSummary),
        }
      : {}),
    ...(params.terminalOutcome !== undefined
      ? {
          terminalOutcome: resolveTaskTerminalOutcome({
            status: params.status,
            terminalOutcome: params.terminalOutcome,
          }),
        }
      : {}),
    ...(params.detail !== undefined ? { detail: structuredClone(params.detail) } : {}),
  };
  if (Object.hasOwn(params, "error")) {
    patch.error = params.error;
  }
  return updateTask(params.taskId, patch);
}

export function markTaskLostById(params: {
  taskId: string;
  endedAt: number;
  lastEventAt?: number;
  error?: string;
  cleanupAfter?: number;
}): TaskRecord | null {
  ensureTaskRegistryReady();
  return updateTask(params.taskId, {
    status: "lost",
    endedAt: params.endedAt,
    lastEventAt: params.lastEventAt ?? params.endedAt,
    ...(params.error !== undefined ? { error: params.error } : {}),
    ...(params.cleanupAfter !== undefined ? { cleanupAfter: params.cleanupAfter } : {}),
  });
}

export { createTaskRecord } from "./task-registry-create.native.js";

function updateTaskStateByRunId(params: TaskRunStateTransitionParams): TaskRecord[] {
  return transitionTaskRecordsByRunNative({ kind: "state", params });
}

function updateTaskDeliveryByRunId(params: {
  runId: string;
  runtime?: TaskRuntime;
  sessionKey?: string;
  deliveryStatus: TaskDeliveryStatus;
  error?: string;
}) {
  return transitionTaskRecordsByRunNative({ kind: "delivery", params });
}

export function markTaskRunningByRunId(params: {
  runId: string;
  taskId?: string;
  runtime?: TaskRuntime;
  sessionKey?: string;
  startedAt?: number;
  lastEventAt?: number;
  progressSummary?: string | null;
  eventSummary?: string | null;
}) {
  return updateTaskStateByRunId({
    runId: params.runId,
    taskId: params.taskId,
    runtime: params.runtime,
    sessionKey: params.sessionKey,
    status: "running",
    startedAt: params.startedAt,
    lastEventAt: params.lastEventAt,
    progressSummary: params.progressSummary,
    eventSummary: params.eventSummary,
  });
}

export function recordTaskProgressByRunId(params: {
  runId: string;
  taskId?: string;
  runtime?: TaskRuntime;
  sessionKey?: string;
  childSessionKey?: string | null;
  lastEventAt?: number;
  progressSummary?: string | null;
  eventSummary?: string | null;
  detail?: JsonValue;
}) {
  return updateTaskStateByRunId({
    runId: params.runId,
    taskId: params.taskId,
    runtime: params.runtime,
    sessionKey: params.sessionKey,
    childSessionKey: params.childSessionKey,
    detail: params.detail,
    lastEventAt: params.lastEventAt,
    progressSummary: params.progressSummary,
    eventSummary: params.eventSummary,
  });
}

export function finalizeTaskRecordByRunId(params: {
  runId: string;
  taskId?: string;
  runtime?: TaskRuntime;
  sessionKey?: string;
  childSessionKey?: string | null;
  status: Extract<TaskStatus, "succeeded" | "failed" | "timed_out" | "cancelled">;
  startedAt?: number;
  endedAt: number;
  lastEventAt?: number;
  error?: string;
  clearError?: boolean;
  progressSummary?: string | null;
  terminalSummary?: string | null;
  preserveTerminalSummary?: boolean;
  terminalOutcome?: TaskTerminalOutcome | null;
  detail?: JsonValue;
  suppressDelivery?: boolean;
}) {
  return updateTaskStateByRunId({
    runId: params.runId,
    taskId: params.taskId,
    runtime: params.runtime,
    sessionKey: params.sessionKey,
    childSessionKey: params.childSessionKey,
    status: params.status,
    startedAt: params.startedAt,
    endedAt: params.endedAt,
    lastEventAt: params.lastEventAt,
    error: params.error,
    clearError: params.clearError,
    progressSummary: params.progressSummary,
    terminalSummary: params.terminalSummary,
    preserveTerminalSummary: params.preserveTerminalSummary,
    terminalOutcome: params.terminalOutcome,
    detail: params.detail,
    suppressDelivery: params.suppressDelivery,
  });
}

export function setTaskRunDeliveryStatusByRunId(params: {
  runId: string;
  runtime?: TaskRuntime;
  sessionKey?: string;
  deliveryStatus: TaskDeliveryStatus;
  error?: string;
}) {
  return updateTaskDeliveryByRunId(params);
}

export function updateTaskNotifyPolicyById(params: {
  taskId: string;
  notifyPolicy: TaskNotifyPolicy;
}): TaskRecord | null {
  const notifyPolicy = parseTaskNotifyPolicy(params.notifyPolicy);
  ensureTaskRegistryReady();
  return updateTask(params.taskId, {
    notifyPolicy,
    lastEventAt: Date.now(),
  });
}

export function linkTaskToFlowById(params: { taskId: string; flowId: string }): TaskRecord | null {
  return withTaskRegistryMutation(
    () => {
      ensureTaskRegistryReady();
      const flowId = params.flowId.trim();
      if (!flowId) {
        return null;
      }
      const current = tasks.get(params.taskId);
      if (!current) {
        return null;
      }
      if (current.parentFlowId?.trim()) {
        return cloneTaskRecord(current);
      }
      assertParentFlowLinkAllowed({
        ownerKey: current.ownerKey,
        scopeKind: current.scopeKind,
        parentFlowId: flowId,
      });
      return updateTask(params.taskId, {
        parentFlowId: flowId,
      });
    },
    () => null,
  );
}
