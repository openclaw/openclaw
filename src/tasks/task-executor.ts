import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  cancelTaskById,
  createTaskRecord,
  findLatestTaskForFlowId,
  findTaskByRunId,
  isParentFlowLinkError,
  linkTaskToFlowById,
  listTasksForFlowId,
  markTaskLostById,
  markTaskRunningByRunId,
  markTaskTerminalByRunId,
  recordTaskProgressByRunId,
  setTaskRunDeliveryStatusByRunId,
} from "./runtime-internal.js";
import { getTaskFlowByIdForOwner } from "./task-flow-owner-access.js";
import type { JsonValue, TaskFlowRecord } from "./task-flow-registry.types.js";
import {
  createTaskFlowForTask,
  deleteTaskFlowRecordById,
  getTaskFlowById,
  requestFlowCancel,
  updateFlowRecordByIdExpectedRevision,
} from "./task-flow-runtime-internal.js";
import { summarizeTaskRecords } from "./task-registry.summary.js";
import type {
  TaskDeliveryState,
  TaskDeliveryStatus,
  TaskNotifyPolicy,
  TaskRecord,
  TaskRegistrySummary,
  TaskRuntime,
  TaskScopeKind,
  TaskStatus,
  TaskTerminalOutcome,
} from "./task-registry.types.js";

const log = createSubsystemLogger("tasks/executor");

function isOneTaskFlowEligible(task: TaskRecord): boolean {
  if (task.parentFlowId?.trim() || task.scopeKind !== "session") {
    return false;
  }
  if (task.deliveryStatus === "not_applicable") {
    return false;
  }
  return task.runtime === "acp" || task.runtime === "subagent";
}

function ensureSingleTaskFlow(params: {
  task: TaskRecord;
  requesterOrigin?: TaskDeliveryState["requesterOrigin"];
}): TaskRecord {
  if (!isOneTaskFlowEligible(params.task)) {
    return params.task;
  }
  try {
    const flow = createTaskFlowForTask({
      task: params.task,
      requesterOrigin: params.requesterOrigin,
    });
    const linked = linkTaskToFlowById({
      taskId: params.task.taskId,
      flowId: flow.flowId,
    });
    if (!linked) {
      deleteTaskFlowRecordById(flow.flowId);
      return params.task;
    }
    if (linked.parentFlowId !== flow.flowId) {
      deleteTaskFlowRecordById(flow.flowId);
      return linked;
    }
    return linked;
  } catch (error) {
    log.warn("Failed to create one-task flow for detached run", {
      taskId: params.task.taskId,
      runId: params.task.runId,
      error,
    });
    return params.task;
  }
}

export function createQueuedTaskRun(params: {
  runtime: TaskRuntime;
  sourceId?: string;
  requesterSessionKey?: string;
  ownerKey?: string;
  scopeKind?: TaskScopeKind;
  requesterOrigin?: TaskDeliveryState["requesterOrigin"];
  parentFlowId?: string;
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
  const task = createTaskRecord({
    ...params,
    status: "queued",
  });
  return ensureSingleTaskFlow({
    task,
    requesterOrigin: params.requesterOrigin,
  });
}

export function getFlowTaskSummary(flowId: string): TaskRegistrySummary {
  return summarizeTaskRecords(listTasksForFlowId(flowId));
}

export function createRunningTaskRun(params: {
  runtime: TaskRuntime;
  sourceId?: string;
  requesterSessionKey?: string;
  ownerKey?: string;
  scopeKind?: TaskScopeKind;
  requesterOrigin?: TaskDeliveryState["requesterOrigin"];
  parentFlowId?: string;
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
  const task = createTaskRecord({
    ...params,
    status: "running",
  });
  return ensureSingleTaskFlow({
    task,
    requesterOrigin: params.requesterOrigin,
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

type RetryBlockedFlowResult = {
  found: boolean;
  retried: boolean;
  reason?: string;
  previousTask?: TaskRecord;
  task?: TaskRecord;
};

type RetryBlockedFlowParams = {
  flowId: string;
  sourceId?: string;
  requesterOrigin?: TaskDeliveryState["requesterOrigin"];
  childSessionKey?: string;
  agentId?: string;
  runId?: string;
  label?: string;
  task?: string;
  preferMetadata?: boolean;
  notifyPolicy?: TaskNotifyPolicy;
  deliveryStatus?: TaskDeliveryStatus;
  status: "queued" | "running";
  startedAt?: number;
  lastEventAt?: number;
  progressSummary?: string | null;
};

type RetryManagedChildTaskFlowResult = {
  found: boolean;
  retried: boolean;
  reason?: string;
  flow?: TaskFlowRecord;
  previousTask?: TaskRecord;
  task?: TaskRecord;
};

type ManagedChildTaskRetryLaunch = {
  runtime: Extract<TaskRuntime, "acp" | "subagent">;
  task: string;
  label?: string;
  agentId?: string;
  model?: string;
  thinking?: string;
  runTimeoutSeconds?: number;
  thread?: boolean;
  mode?: "run" | "session";
  cleanup?: "delete" | "keep";
  sandbox?: "inherit" | "require";
  cwd?: string;
  resumeSessionId?: string;
};

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function readTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function readManagedChildTaskRetryLaunch(params: {
  flow: TaskFlowRecord;
  latestTask?: TaskRecord;
}): ManagedChildTaskRetryLaunch | null {
  const state = isJsonObject(params.flow.stateJson) ? params.flow.stateJson : undefined;
  const launch = isJsonObject(state?.launch) ? state.launch : undefined;
  const runtimeRaw =
    readTrimmedString(launch?.runtime) ??
    readTrimmedString(state?.runtime) ??
    readTrimmedString(params.latestTask?.runtime);
  const runtime = runtimeRaw === "acp" || runtimeRaw === "subagent" ? runtimeRaw : undefined;
  const task =
    readTrimmedString(launch?.task) ??
    readTrimmedString(state?.task) ??
    readTrimmedString(params.latestTask?.task);
  if (!runtime || !task) {
    return null;
  }
  const label =
    readTrimmedString(launch?.label) ??
    readTrimmedString(state?.label) ??
    readTrimmedString(params.latestTask?.label);
  const agentId =
    readTrimmedString(launch?.agentId) ?? readTrimmedString(params.latestTask?.agentId);
  const model = readTrimmedString(launch?.model);
  const thinking = readTrimmedString(launch?.thinking);
  const runTimeoutSeconds = readNonNegativeNumber(launch?.runTimeoutSeconds);
  const thread = readBoolean(launch?.thread);
  const cwd = readTrimmedString(launch?.cwd);
  const resumeSessionId = readTrimmedString(launch?.resumeSessionId);
  return {
    runtime,
    task,
    ...(label ? { label } : {}),
    ...(agentId ? { agentId } : {}),
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
    ...(runTimeoutSeconds !== undefined ? { runTimeoutSeconds } : {}),
    ...(thread !== undefined ? { thread } : {}),
    ...(launch?.mode === "run" || launch?.mode === "session" ? { mode: launch.mode } : {}),
    ...(launch?.cleanup === "delete" || launch?.cleanup === "keep"
      ? { cleanup: launch.cleanup }
      : {}),
    ...(launch?.sandbox === "inherit" || launch?.sandbox === "require"
      ? { sandbox: launch.sandbox }
      : {}),
    ...(cwd ? { cwd } : {}),
    ...(resumeSessionId ? { resumeSessionId } : {}),
  };
}

function buildManagedChildTaskRetryState(params: {
  flow: TaskFlowRecord;
  launch: ManagedChildTaskRetryLaunch;
  childSessionKey?: string;
  runId?: string;
}): Record<string, JsonValue> {
  const current = isJsonObject(params.flow.stateJson)
    ? ({ ...params.flow.stateJson } as Record<string, JsonValue>)
    : {};
  delete current.completion;
  delete current.progressSummary;
  delete current.error;
  return {
    ...current,
    task: params.launch.task,
    runtime: params.launch.runtime,
    label: params.launch.label ?? null,
    childSessionKey: params.childSessionKey ?? null,
    runId: params.runId ?? null,
    launch: {
      kind: "sessions_spawn_child",
      runtime: params.launch.runtime,
      task: params.launch.task,
      ...(params.launch.label ? { label: params.launch.label } : {}),
      ...(params.launch.agentId ? { agentId: params.launch.agentId } : {}),
      ...(params.launch.model ? { model: params.launch.model } : {}),
      ...(params.launch.thinking ? { thinking: params.launch.thinking } : {}),
      ...(params.launch.runTimeoutSeconds !== undefined
        ? { runTimeoutSeconds: params.launch.runTimeoutSeconds }
        : {}),
      ...(params.launch.thread !== undefined ? { thread: params.launch.thread } : {}),
      ...(params.launch.mode ? { mode: params.launch.mode } : {}),
      ...(params.launch.cleanup ? { cleanup: params.launch.cleanup } : {}),
      ...(params.launch.sandbox ? { sandbox: params.launch.sandbox } : {}),
      ...(params.launch.cwd ? { cwd: params.launch.cwd } : {}),
      ...(params.launch.resumeSessionId ? { resumeSessionId: params.launch.resumeSessionId } : {}),
    },
  };
}

function resolveRetryableManagedChildTaskFlow(flowId: string): {
  flowFound: boolean;
  retryable: boolean;
  flow?: TaskFlowRecord;
  latestTask?: TaskRecord;
  launch?: ManagedChildTaskRetryLaunch;
  reason?: string;
} {
  const flow = getTaskFlowById(flowId);
  if (!flow) {
    return {
      flowFound: false,
      retryable: false,
      reason: "Flow not found.",
    };
  }
  if (flow.syncMode !== "managed") {
    return {
      flowFound: true,
      retryable: false,
      flow,
      reason: "Flow does not accept managed child-task retries.",
    };
  }
  if (flow.cancelRequestedAt != null) {
    return {
      flowFound: true,
      retryable: false,
      flow,
      reason: "Flow cancellation has already been requested.",
    };
  }
  if (flow.status !== "blocked" && flow.status !== "failed" && flow.status !== "lost") {
    return {
      flowFound: true,
      retryable: false,
      flow,
      reason: `Flow is not retryable from status ${flow.status}.`,
    };
  }
  const tasks = listTasksForFlowId(flowId);
  if (tasks.some((task) => isActiveTaskStatus(task.status))) {
    return {
      flowFound: true,
      retryable: false,
      flow,
      reason: "Flow already has an active child task.",
    };
  }
  const latestTask = findLatestTaskForFlowId(flowId);
  const launch = readManagedChildTaskRetryLaunch({ flow, latestTask: latestTask ?? undefined });
  if (!launch) {
    return {
      flowFound: true,
      retryable: false,
      flow,
      latestTask,
      reason: "Flow has no stored child-task launch details.",
    };
  }
  return {
    flowFound: true,
    retryable: true,
    flow,
    latestTask,
    launch,
  };
}

async function retryManagedChildTaskFlowUnchecked(params: {
  flowId: string;
}): Promise<RetryManagedChildTaskFlowResult> {
  const resolved = resolveRetryableManagedChildTaskFlow(params.flowId);
  if (!resolved.retryable || !resolved.flow || !resolved.launch) {
    return {
      found: resolved.flowFound,
      retried: false,
      reason: resolved.reason,
      ...(resolved.flow ? { flow: resolved.flow } : {}),
      ...(resolved.latestTask ? { previousTask: resolved.latestTask } : {}),
    };
  }

  const flow = resolved.flow;
  const launch = resolved.launch;
  const updatedAt = Date.now();

  if (launch.runtime === "subagent") {
    const { spawnSubagentDirect } = await import("../agents/subagent-spawn.js");
    const result = await spawnSubagentDirect(
      {
        task: launch.task,
        ...(launch.label ? { label: launch.label } : {}),
        ...(launch.agentId ? { agentId: launch.agentId } : {}),
        ...(launch.model ? { model: launch.model } : {}),
        ...(launch.thinking ? { thinking: launch.thinking } : {}),
        ...(launch.runTimeoutSeconds !== undefined
          ? { runTimeoutSeconds: launch.runTimeoutSeconds }
          : {}),
        ...(launch.thread !== undefined ? { thread: launch.thread } : {}),
        ...(launch.mode ? { mode: launch.mode } : {}),
        ...(launch.cleanup ? { cleanup: launch.cleanup } : {}),
        ...(launch.sandbox ? { sandbox: launch.sandbox } : {}),
        parentFlowId: flow.flowId,
        expectsCompletionMessage: true,
      },
      {
        agentSessionKey: flow.ownerKey,
      },
    );
    if (result.status !== "accepted") {
      return {
        found: true,
        retried: false,
        reason: result.error ?? "Spawn failed.",
        flow,
        ...(resolved.latestTask ? { previousTask: resolved.latestTask } : {}),
      };
    }
    const refreshed = getTaskFlowById(flow.flowId) ?? flow;
    const waitPatch = updateFlowRecordByIdExpectedRevision({
      flowId: refreshed.flowId,
      expectedRevision: refreshed.revision,
      patch: {
        status: "waiting",
        currentStep: "wait_worker",
        stateJson: buildManagedChildTaskRetryState({
          flow: refreshed,
          launch,
          childSessionKey: result.childSessionKey?.trim(),
          runId: result.runId?.trim(),
        }),
        waitJson: {
          kind: "child_task",
          runtime: launch.runtime,
          ...(result.childSessionKey?.trim() ? { childSessionKey: result.childSessionKey } : {}),
          ...(result.runId?.trim() ? { runId: result.runId } : {}),
        },
        blockedTaskId: null,
        blockedSummary: null,
        endedAt: null,
        updatedAt,
      },
    });
    const task = result.runId
      ? findTaskByRunId(result.runId)
      : findLatestTaskForFlowId(flow.flowId);
    return {
      found: true,
      retried: waitPatch.applied,
      ...(waitPatch.applied ? {} : { reason: "Flow changed while retry was starting." }),
      flow: waitPatch.applied ? waitPatch.flow : (waitPatch.current ?? refreshed),
      ...(resolved.latestTask ? { previousTask: resolved.latestTask } : {}),
      ...(task ? { task } : {}),
    };
  }

  const { spawnAcpDirect } = await import("../agents/acp-spawn.js");
  const result = await spawnAcpDirect(
    {
      task: launch.task,
      ...(launch.label ? { label: launch.label } : {}),
      ...(launch.agentId ? { agentId: launch.agentId } : {}),
      ...(launch.resumeSessionId ? { resumeSessionId: launch.resumeSessionId } : {}),
      ...(launch.cwd ? { cwd: launch.cwd } : {}),
      ...(launch.mode ? { mode: launch.mode } : {}),
      ...(launch.thread !== undefined ? { thread: launch.thread } : {}),
      ...(launch.sandbox ? { sandbox: launch.sandbox } : {}),
    },
    {
      agentSessionKey: flow.ownerKey,
      agentChannel: flow.requesterOrigin?.channel,
      agentAccountId: flow.requesterOrigin?.accountId,
      agentTo: flow.requesterOrigin?.to,
      agentThreadId: flow.requesterOrigin?.threadId,
    },
  );
  if (result.status !== "accepted") {
    return {
      found: true,
      retried: false,
      reason: result.error ?? "Spawn failed.",
      flow,
      ...(resolved.latestTask ? { previousTask: resolved.latestTask } : {}),
    };
  }
  const spawnedTask = result.runId ? findTaskByRunId(result.runId) : undefined;
  const linkedTask =
    spawnedTask && !spawnedTask.parentFlowId?.trim()
      ? (linkTaskToFlowById({ taskId: spawnedTask.taskId, flowId: flow.flowId }) ?? spawnedTask)
      : spawnedTask;
  const refreshed = getTaskFlowById(flow.flowId) ?? flow;
  const waitPatch = updateFlowRecordByIdExpectedRevision({
    flowId: refreshed.flowId,
    expectedRevision: refreshed.revision,
    patch: {
      status: "waiting",
      currentStep: "wait_worker",
      stateJson: buildManagedChildTaskRetryState({
        flow: refreshed,
        launch,
        childSessionKey: result.childSessionKey?.trim(),
        runId: result.runId?.trim(),
      }),
      waitJson: {
        kind: "child_task",
        runtime: launch.runtime,
        ...(result.childSessionKey?.trim() ? { childSessionKey: result.childSessionKey } : {}),
        ...(result.runId?.trim() ? { runId: result.runId } : {}),
      },
      blockedTaskId: null,
      blockedSummary: null,
      endedAt: null,
      updatedAt,
    },
  });
  return {
    found: true,
    retried: waitPatch.applied,
    ...(waitPatch.applied ? {} : { reason: "Flow changed while retry was starting." }),
    flow: waitPatch.applied ? waitPatch.flow : (waitPatch.current ?? refreshed),
    ...(resolved.latestTask ? { previousTask: resolved.latestTask } : {}),
    ...(linkedTask ? { task: linkedTask } : {}),
  };
}

export async function retryManagedChildTaskFlow(params: {
  flowId: string;
  cfg?: OpenClawConfig;
}): Promise<RetryManagedChildTaskFlowResult> {
  return await retryManagedChildTaskFlowUnchecked({
    flowId: params.flowId,
  });
}

export async function retryManagedChildTaskFlowForOwner(params: {
  flowId: string;
  callerOwnerKey: string;
  cfg?: OpenClawConfig;
}): Promise<RetryManagedChildTaskFlowResult> {
  const flow = getTaskFlowByIdForOwner({
    flowId: params.flowId,
    callerOwnerKey: params.callerOwnerKey,
  });
  if (!flow) {
    return {
      found: false,
      retried: false,
      reason: "Flow not found.",
    };
  }
  return await retryManagedChildTaskFlowUnchecked({
    flowId: flow.flowId,
  });
}

function resolveRetryableBlockedFlowTask(flowId: string): {
  flowFound: boolean;
  retryable: boolean;
  latestTask?: TaskRecord;
  reason?: string;
} {
  const flow = getTaskFlowById(flowId);
  if (!flow) {
    return {
      flowFound: false,
      retryable: false,
      reason: "Flow not found.",
    };
  }
  const latestTask = findLatestTaskForFlowId(flowId);
  if (!latestTask) {
    return {
      flowFound: true,
      retryable: false,
      reason: "Flow has no retryable task.",
    };
  }
  if (flow.status !== "blocked") {
    return {
      flowFound: true,
      retryable: false,
      latestTask,
      reason: "Flow is not blocked.",
    };
  }
  if (latestTask.status !== "succeeded" || latestTask.terminalOutcome !== "blocked") {
    return {
      flowFound: true,
      retryable: false,
      latestTask,
      reason: "Latest TaskFlow task is not blocked.",
    };
  }
  return {
    flowFound: true,
    retryable: true,
    latestTask,
  };
}

function retryBlockedFlowTask(params: RetryBlockedFlowParams): RetryBlockedFlowResult {
  const resolved = resolveRetryableBlockedFlowTask(params.flowId);
  if (!resolved.retryable || !resolved.latestTask) {
    return {
      found: resolved.flowFound,
      retried: false,
      reason: resolved.reason,
    };
  }
  const flow = getTaskFlowById(params.flowId);
  if (!flow) {
    return {
      found: false,
      retried: false,
      reason: "Flow not found.",
      previousTask: resolved.latestTask,
    };
  }
  const task = createTaskRecord({
    runtime: resolved.latestTask.runtime,
    sourceId: params.sourceId ?? resolved.latestTask.sourceId,
    ownerKey: flow.ownerKey,
    scopeKind: "session",
    requesterOrigin: params.requesterOrigin ?? flow.requesterOrigin,
    parentFlowId: flow.flowId,
    childSessionKey: params.childSessionKey,
    parentTaskId: resolved.latestTask.taskId,
    agentId: params.agentId ?? resolved.latestTask.agentId,
    runId: params.runId,
    label: params.label ?? resolved.latestTask.label,
    task: params.task ?? resolved.latestTask.task,
    preferMetadata: params.preferMetadata,
    notifyPolicy: params.notifyPolicy ?? resolved.latestTask.notifyPolicy,
    deliveryStatus: params.deliveryStatus ?? "pending",
    status: params.status,
    startedAt: params.startedAt,
    lastEventAt: params.lastEventAt,
    progressSummary: params.progressSummary,
  });
  return {
    found: true,
    retried: true,
    previousTask: resolved.latestTask,
    task,
  };
}

export function retryBlockedFlowAsQueuedTaskRun(
  params: Omit<RetryBlockedFlowParams, "status" | "startedAt" | "lastEventAt" | "progressSummary">,
): RetryBlockedFlowResult {
  return retryBlockedFlowTask({
    ...params,
    status: "queued",
  });
}

export function retryBlockedFlowAsRunningTaskRun(
  params: Omit<RetryBlockedFlowParams, "status">,
): RetryBlockedFlowResult {
  return retryBlockedFlowTask({
    ...params,
    status: "running",
  });
}

type CancelFlowResult = {
  found: boolean;
  cancelled: boolean;
  reason?: string;
  flow?: TaskFlowRecord;
  tasks?: TaskRecord[];
};

type RunTaskInFlowResult = {
  found: boolean;
  created: boolean;
  reason?: string;
  flow?: TaskFlowRecord;
  task?: TaskRecord;
};

function isActiveTaskStatus(status: TaskStatus): boolean {
  return status === "queued" || status === "running";
}

function isTerminalFlowStatus(status: TaskFlowRecord["status"]): boolean {
  return (
    status === "succeeded" || status === "failed" || status === "cancelled" || status === "lost"
  );
}

function markFlowCancelRequested(flow: TaskFlowRecord): TaskFlowRecord | FlowUpdateFailure {
  if (flow.cancelRequestedAt != null) {
    return flow;
  }
  const result = requestFlowCancel({
    flowId: flow.flowId,
    expectedRevision: flow.revision,
  });
  if (result.applied) {
    return result.flow;
  }
  return {
    reason:
      result.reason === "revision_conflict"
        ? "Flow changed while cancellation was in progress."
        : "Flow not found.",
    flow: result.current ?? getTaskFlowById(flow.flowId),
  };
}

type FlowUpdateFailure = {
  reason: string;
  flow?: TaskFlowRecord;
};

function cancelManagedFlowAfterChildrenSettle(
  flow: TaskFlowRecord,
  endedAt: number,
): TaskFlowRecord | FlowUpdateFailure {
  const result = updateFlowRecordByIdExpectedRevision({
    flowId: flow.flowId,
    expectedRevision: flow.revision,
    patch: {
      status: "cancelled",
      blockedTaskId: null,
      blockedSummary: null,
      waitJson: null,
      endedAt,
      updatedAt: endedAt,
    },
  });
  if (result.applied) {
    return result.flow;
  }
  return {
    reason:
      result.reason === "revision_conflict"
        ? "Flow changed while cancellation was in progress."
        : "Flow not found.",
    flow: result.current ?? getTaskFlowById(flow.flowId),
  };
}

function mapRunTaskInFlowCreateError(params: {
  error: unknown;
  flowId: string;
}): RunTaskInFlowResult {
  const flow = getTaskFlowById(params.flowId);
  if (isParentFlowLinkError(params.error)) {
    if (params.error.code === "cancel_requested") {
      return {
        found: true,
        created: false,
        reason: "Flow cancellation has already been requested.",
        ...(flow ? { flow } : {}),
      };
    }
    if (params.error.code === "terminal") {
      const terminalStatus = flow?.status ?? params.error.details?.status ?? "terminal";
      return {
        found: true,
        created: false,
        reason: `Flow is already ${terminalStatus}.`,
        ...(flow ? { flow } : {}),
      };
    }
    if (params.error.code === "parent_flow_not_found") {
      return {
        found: false,
        created: false,
        reason: "Flow not found.",
      };
    }
  }
  throw params.error;
}

export function runTaskInFlow(params: {
  flowId: string;
  runtime: TaskRuntime;
  sourceId?: string;
  childSessionKey?: string;
  parentTaskId?: string;
  agentId?: string;
  runId?: string;
  label?: string;
  task: string;
  preferMetadata?: boolean;
  notifyPolicy?: TaskNotifyPolicy;
  deliveryStatus?: TaskDeliveryStatus;
  status?: "queued" | "running";
  startedAt?: number;
  lastEventAt?: number;
  progressSummary?: string | null;
}): RunTaskInFlowResult {
  const flow = getTaskFlowById(params.flowId);
  if (!flow) {
    return {
      found: false,
      created: false,
      reason: "Flow not found.",
    };
  }
  if (flow.syncMode !== "managed") {
    return {
      found: true,
      created: false,
      reason: "Flow does not accept managed child tasks.",
      flow,
    };
  }
  if (flow.cancelRequestedAt != null) {
    return {
      found: true,
      created: false,
      reason: "Flow cancellation has already been requested.",
      flow,
    };
  }
  if (isTerminalFlowStatus(flow.status)) {
    return {
      found: true,
      created: false,
      reason: `Flow is already ${flow.status}.`,
      flow,
    };
  }

  const common = {
    runtime: params.runtime,
    sourceId: params.sourceId,
    ownerKey: flow.ownerKey,
    scopeKind: "session" as const,
    requesterOrigin: flow.requesterOrigin,
    parentFlowId: flow.flowId,
    childSessionKey: params.childSessionKey,
    parentTaskId: params.parentTaskId,
    agentId: params.agentId,
    runId: params.runId,
    label: params.label,
    task: params.task,
    preferMetadata: params.preferMetadata,
    notifyPolicy: params.notifyPolicy,
    deliveryStatus: params.deliveryStatus ?? "pending",
  };
  let task: TaskRecord;
  try {
    task =
      params.status === "running"
        ? createRunningTaskRun({
            ...common,
            startedAt: params.startedAt,
            lastEventAt: params.lastEventAt,
            progressSummary: params.progressSummary,
          })
        : createQueuedTaskRun(common);
  } catch (error) {
    return mapRunTaskInFlowCreateError({
      error,
      flowId: flow.flowId,
    });
  }

  return {
    found: true,
    created: true,
    flow: getTaskFlowById(flow.flowId) ?? flow,
    task,
  };
}

export function runTaskInFlowForOwner(params: {
  flowId: string;
  callerOwnerKey: string;
  runtime: TaskRuntime;
  sourceId?: string;
  childSessionKey?: string;
  parentTaskId?: string;
  agentId?: string;
  runId?: string;
  label?: string;
  task: string;
  preferMetadata?: boolean;
  notifyPolicy?: TaskNotifyPolicy;
  deliveryStatus?: TaskDeliveryStatus;
  status?: "queued" | "running";
  startedAt?: number;
  lastEventAt?: number;
  progressSummary?: string | null;
}): RunTaskInFlowResult {
  const flow = getTaskFlowByIdForOwner({
    flowId: params.flowId,
    callerOwnerKey: params.callerOwnerKey,
  });
  if (!flow) {
    return {
      found: false,
      created: false,
      reason: "Flow not found.",
    };
  }
  return runTaskInFlow({
    flowId: flow.flowId,
    runtime: params.runtime,
    sourceId: params.sourceId,
    childSessionKey: params.childSessionKey,
    parentTaskId: params.parentTaskId,
    agentId: params.agentId,
    runId: params.runId,
    label: params.label,
    task: params.task,
    preferMetadata: params.preferMetadata,
    notifyPolicy: params.notifyPolicy,
    deliveryStatus: params.deliveryStatus,
    status: params.status,
    startedAt: params.startedAt,
    lastEventAt: params.lastEventAt,
    progressSummary: params.progressSummary,
  });
}

export async function cancelFlowById(params: {
  cfg: OpenClawConfig;
  flowId: string;
}): Promise<CancelFlowResult> {
  const flow = getTaskFlowById(params.flowId);
  if (!flow) {
    return {
      found: false,
      cancelled: false,
      reason: "Flow not found.",
    };
  }
  if (isTerminalFlowStatus(flow.status)) {
    return {
      found: true,
      cancelled: false,
      reason: `Flow is already ${flow.status}.`,
      flow,
      tasks: listTasksForFlowId(flow.flowId),
    };
  }
  const cancelRequestedFlow = markFlowCancelRequested(flow);
  if ("reason" in cancelRequestedFlow) {
    return {
      found: true,
      cancelled: false,
      reason: cancelRequestedFlow.reason,
      flow: cancelRequestedFlow.flow,
      tasks: listTasksForFlowId(flow.flowId),
    };
  }
  const linkedTasks = listTasksForFlowId(flow.flowId);
  const activeTasks = linkedTasks.filter((task) => isActiveTaskStatus(task.status));
  for (const task of activeTasks) {
    await cancelTaskById({
      cfg: params.cfg,
      taskId: task.taskId,
    });
  }
  const refreshedTasks = listTasksForFlowId(flow.flowId);
  const remainingActive = refreshedTasks.filter((task) => isActiveTaskStatus(task.status));
  if (remainingActive.length > 0) {
    return {
      found: true,
      cancelled: false,
      reason: "One or more child tasks are still active.",
      flow: getTaskFlowById(flow.flowId) ?? cancelRequestedFlow,
      tasks: refreshedTasks,
    };
  }
  const now = Date.now();
  const refreshedFlow = getTaskFlowById(flow.flowId) ?? cancelRequestedFlow;
  if (isTerminalFlowStatus(refreshedFlow.status)) {
    return {
      found: true,
      cancelled: refreshedFlow.status === "cancelled",
      reason:
        refreshedFlow.status === "cancelled"
          ? undefined
          : `Flow is already ${refreshedFlow.status}.`,
      flow: refreshedFlow,
      tasks: refreshedTasks,
    };
  }
  const updatedFlow = cancelManagedFlowAfterChildrenSettle(refreshedFlow, now);
  if ("reason" in updatedFlow) {
    return {
      found: true,
      cancelled: false,
      reason: updatedFlow.reason,
      flow: updatedFlow.flow,
      tasks: refreshedTasks,
    };
  }
  return {
    found: true,
    cancelled: true,
    flow: updatedFlow,
    tasks: refreshedTasks,
  };
}

export async function cancelFlowByIdForOwner(params: {
  cfg: OpenClawConfig;
  flowId: string;
  callerOwnerKey: string;
}): Promise<CancelFlowResult> {
  const flow = getTaskFlowByIdForOwner({
    flowId: params.flowId,
    callerOwnerKey: params.callerOwnerKey,
  });
  if (!flow) {
    return {
      found: false,
      cancelled: false,
      reason: "Flow not found.",
    };
  }
  return cancelFlowById({
    cfg: params.cfg,
    flowId: flow.flowId,
  });
}

export async function cancelDetachedTaskRunById(params: { cfg: OpenClawConfig; taskId: string }) {
  return cancelTaskById(params);
}
