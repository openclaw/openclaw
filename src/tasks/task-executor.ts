import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type {
  DetachedRunningTaskCreateParams,
  DetachedTaskCompleteParams,
  DetachedTaskCreateParams,
  DetachedTaskFailParams,
  DetachedTaskFinalizeParams,
} from "./detached-task-runtime-contract.js";
import {
  createTaskRecord,
  getTaskById,
  isParentFlowLinkError,
  linkTaskToFlowById,
  listTasksForFlowId,
  finalizeTaskRecordByRunId,
} from "./runtime-internal.js";
import {
  hasAuthoritativeTaskBacking,
  resolveManagedTaskBackingDetail,
} from "./task-backing-authority.js";
import { readManagedTaskBacking, sameTaskBackingInstance } from "./task-backing-records.js";
import {
  isProvisionalSubagentKillTask,
  isTaskFlowCancellationPending,
} from "./task-cancellation-state.js";
// Executes task records through configured runtimes and updates registry state.
import type {
  RunTaskInFlowParams,
  RunTaskInFlowResult,
} from "./task-flow-managed-run-task.types.js";
import { getTaskFlowByIdForOwner } from "./task-flow-owner-access.js";
import { isTerminalTaskFlow, type TaskFlowRecord } from "./task-flow-registry.types.js";
import {
  createTaskFlowForTask,
  deleteTaskFlowRecordById,
  getTaskFlowById,
  requestFlowCancel,
  updateFlowRecordByIdExpectedRevision,
} from "./task-flow-runtime-internal.js";
import { isOneTaskFlowEligible } from "./task-initial-flow.rules.js";
import { summarizeTaskRecords } from "./task-registry.summary.js";
import { isTerminalTaskStatus } from "./task-registry.types.js";
import type { TaskDeliveryState, TaskRecord, TaskRegistrySummary } from "./task-registry.types.js";

export {
  findTaskByRunId,
  markTaskRunningByRunId as startTaskRunByRunIdCore,
  markTaskTerminalById as finalizeTaskRunById,
  recordTaskProgressByRunId as recordTaskRunProgressByRunIdCore,
  setTaskRunDeliveryStatusByRunId as setDetachedTaskDeliveryStatusByRunIdCore,
} from "./runtime-internal.js";

const log = createSubsystemLogger("tasks/executor");

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
    if (!flow) {
      return params.task;
    }
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

export function createQueuedTaskRunCore(params: DetachedTaskCreateParams): TaskRecord | null {
  const task = createTaskRecord({
    ...params,
    status: "queued",
  });
  if (!task) {
    return null;
  }
  return ensureSingleTaskFlow({
    task,
    requesterOrigin: params.requesterOrigin,
  });
}

export function getFlowTaskSummary(flowId: string): TaskRegistrySummary {
  return summarizeTaskRecords(listTasksForFlowId(flowId));
}

export function createRunningTaskRunCore(
  params: DetachedRunningTaskCreateParams,
): TaskRecord | null {
  const task = createTaskRecord({
    ...params,
    status: "running",
  });
  if (!task) {
    return null;
  }
  return ensureSingleTaskFlow({
    task,
    requesterOrigin: params.requesterOrigin,
  });
}

export function completeTaskRunByRunIdCore(params: DetachedTaskCompleteParams) {
  return finalizeTaskRunByRunIdCore({
    ...params,
    status: "succeeded",
  });
}

export function finalizeTaskRunByRunIdCore(params: DetachedTaskFinalizeParams) {
  return finalizeTaskRecordByRunId(params);
}

export function failTaskRunByRunIdCore(params: DetachedTaskFailParams) {
  return finalizeTaskRunByRunIdCore({
    ...params,
    status: params.status ?? "failed",
  });
}

type CancelFlowResult = {
  found: boolean;
  cancelled: boolean;
  reason?: string;
  flow?: TaskFlowRecord;
  tasks?: TaskRecord[];
};

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
    reason: describeFlowUpdateFailure(result.reason),
    flow: result.current ?? getTaskFlowById(flow.flowId),
  };
}

type FlowUpdateFailure = {
  reason: string;
  flow?: TaskFlowRecord;
};

function describeFlowUpdateFailure(
  reason: Exclude<ReturnType<typeof requestFlowCancel>, { applied: true }>["reason"],
): string {
  switch (reason) {
    case "revision_conflict":
      return "Flow changed while cancellation was in progress.";
    case "persist_failed":
      return "Flow persistence failed.";
    case "not_found":
      return "Flow not found.";
    default:
      return "Flow mutation failed.";
  }
}

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
    reason: describeFlowUpdateFailure(result.reason),
    flow: result.current ?? getTaskFlowById(flow.flowId),
  };
}

class ManagedTaskCreationRefused extends Error {
  constructor(readonly result: RunTaskInFlowResult) {
    super(result.reason);
  }
}

function mapRunTaskInFlowCreateError(params: {
  error: unknown;
  flowId: string;
}): RunTaskInFlowResult {
  if (params.error instanceof ManagedTaskCreationRefused) {
    return params.error.result;
  }
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

export function runTaskInFlowForOwner(
  params: RunTaskInFlowParams & { callerOwnerKey: string },
): RunTaskInFlowResult {
  const readManagedFlow = (): { flow: TaskFlowRecord } | { refusal: RunTaskInFlowResult } => {
    const flow = getTaskFlowByIdForOwner(params);
    if (!flow) {
      return { refusal: { found: false, created: false, reason: "Flow not found." } };
    }
    const reason =
      flow.syncMode !== "managed"
        ? "Flow does not accept managed child tasks."
        : flow.cancelRequestedAt != null
          ? "Flow cancellation has already been requested."
          : isTerminalTaskFlow(flow)
            ? `Flow is already ${flow.status}.`
            : undefined;
    return reason ? { refusal: { found: true, created: false, reason, flow } } : { flow };
  };
  const selected = readManagedFlow();
  if ("refusal" in selected) {
    return selected.refusal;
  }
  let { flow } = selected;

  const childSessionKey = params.childSessionKey?.trim();
  const runId = params.runId?.trim();
  const readBackingDetail = () =>
    childSessionKey && runId && (params.runtime === "acp" || params.runtime === "subagent")
      ? resolveManagedTaskBackingDetail({
          runtime: params.runtime,
          scopeKind: "session",
          ownerKey: flow.ownerKey,
          childSessionKey,
          runId,
        })
      : undefined;
  const managedBackingDetail = readBackingDetail();
  const selectedBacking = readManagedTaskBacking(managedBackingDetail);
  if (
    childSessionKey &&
    (params.runtime === "acp" || params.runtime === "subagent") &&
    !managedBackingDetail
  ) {
    return {
      found: true,
      created: false,
      reason: "Task backing ownership could not be verified.",
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
    ...(managedBackingDetail !== undefined ? { detail: managedBackingDetail } : {}),
  };
  let task: TaskRecord | null;
  try {
    task = createTaskRecord(
      {
        ...common,
        status: params.status === "running" ? "running" : "queued",
        ...(params.status === "running"
          ? {
              startedAt: params.startedAt,
              lastEventAt: params.lastEventAt,
              progressSummary: params.progressSummary,
            }
          : {}),
      },
      (existing) => {
        const currentFlow = readManagedFlow();
        if ("refusal" in currentFlow) {
          throw new ManagedTaskCreationRefused(currentFlow.refusal);
        }
        flow = currentFlow.flow;
        if (selectedBacking) {
          const currentBacking = readManagedTaskBacking(readBackingDetail());
          const currentTask = currentBacking && getTaskById(currentBacking.taskId);
          if (
            !currentBacking ||
            !currentTask ||
            currentBacking.taskId !== selectedBacking.taskId ||
            !sameTaskBackingInstance(currentBacking.instance, selectedBacking.instance) ||
            (isTerminalTaskStatus(currentTask.status) &&
              (!existing || !isTerminalTaskStatus(existing.status)))
          ) {
            throw new ManagedTaskCreationRefused({
              found: true,
              created: false,
              reason: "Task backing ownership could not be verified.",
              flow: currentFlow.flow,
            });
          }
        }
      },
    );
  } catch (error) {
    return mapRunTaskInFlowCreateError({
      error,
      flowId: flow.flowId,
    });
  }
  if (!task) {
    return {
      found: true,
      created: false,
      reason: "Task persistence failed.",
      flow: getTaskFlowById(flow.flowId) ?? flow,
    };
  }
  const registeredTask = getTaskById(task.taskId);
  if (!registeredTask) {
    return {
      found: true,
      created: false,
      reason: "Task persistence failed.",
      flow: getTaskFlowById(flow.flowId) ?? flow,
    };
  }

  return {
    found: true,
    created: true,
    flow: getTaskFlowById(flow.flowId) ?? flow,
    task: registeredTask,
  };
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
  if (isTerminalTaskFlow(flow)) {
    const provisionalTasks = listTasksForFlowId(flow.flowId).filter(isProvisionalSubagentKillTask);
    if (flow.status === "cancelled" && provisionalTasks.length > 0) {
      for (const task of provisionalTasks) {
        await cancelDetachedTaskRunById({ cfg: params.cfg, taskId: task.taskId });
      }
      const tasks = listTasksForFlowId(flow.flowId);
      if (tasks.some(isProvisionalSubagentKillTask)) {
        return {
          found: true,
          cancelled: false,
          reason: "One or more child tasks remain provisionally cancelled.",
          flow: getTaskFlowById(flow.flowId) ?? flow,
          tasks,
        };
      }
      const refreshedFlow = getTaskFlowById(flow.flowId) ?? flow;
      return {
        found: true,
        cancelled: refreshedFlow.status === "cancelled",
        reason:
          refreshedFlow.status === "cancelled"
            ? undefined
            : `Flow is already ${refreshedFlow.status}.`,
        flow: refreshedFlow,
        tasks,
      };
    }
    return {
      found: true,
      cancelled: false,
      reason: `Flow is already ${flow.status}.`,
      flow,
      tasks: listTasksForFlowId(flow.flowId),
    };
  }
  const linkedTasks = listTasksForFlowId(flow.flowId);
  const activeTasks = linkedTasks.filter(isTaskFlowCancellationPending);
  if (activeTasks.some((task) => !hasAuthoritativeTaskBacking(task))) {
    return {
      found: true,
      cancelled: false,
      reason: "Child task ownership could not be verified; no cancellation was performed.",
      flow,
      tasks: linkedTasks,
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
  for (const task of activeTasks) {
    await cancelDetachedTaskRunById({
      cfg: params.cfg,
      taskId: task.taskId,
    });
  }
  const refreshedTasks = listTasksForFlowId(flow.flowId);
  const remainingActive = refreshedTasks.filter(isTaskFlowCancellationPending);
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
  if (isTerminalTaskFlow(refreshedFlow)) {
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

export async function cancelDetachedTaskRunById(params: {
  cfg: OpenClawConfig;
  taskId: string;
  reason?: string;
}) {
  const runtime = await import("./task-executor-cancel.runtime.js");
  return runtime.cancelDetachedTaskRunByIdCore(params);
}
