import { createSubsystemLogger } from "../logging/subsystem.js";
import { getRegisteredDetachedTaskLifecycleRuntime } from "./detached-task-runtime-state.js";
import { cancelTaskById, createTaskRecord, findLatestTaskForFlowId, getTaskById, isParentFlowLinkError, linkTaskToFlowById, listTasksForFlowId, markTaskLostById, markTaskRunningByRunId, markTaskTerminalByRunId, recordTaskProgressByRunId, setTaskRunDeliveryStatusByRunId, } from "./runtime-internal.js";
import { getTaskFlowByIdForOwner } from "./task-flow-owner-access.js";
import { createTaskFlowForTask, deleteTaskFlowRecordById, getTaskFlowById, requestFlowCancel, updateFlowRecordByIdExpectedRevision, } from "./task-flow-runtime-internal.js";
import { summarizeTaskRecords } from "./task-registry.summary.js";
const log = createSubsystemLogger("tasks/executor");
function isOneTaskFlowEligible(task) {
    if (task.parentFlowId?.trim() || task.scopeKind !== "session") {
        return false;
    }
    if (task.deliveryStatus === "not_applicable") {
        return false;
    }
    return task.runtime === "acp" || task.runtime === "subagent";
}
function ensureSingleTaskFlow(params) {
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
    }
    catch (error) {
        log.warn("Failed to create one-task flow for detached run", {
            taskId: params.task.taskId,
            runId: params.task.runId,
            error,
        });
        return params.task;
    }
}
export function createQueuedTaskRun(params) {
    const task = createTaskRecord({
        ...params,
        status: "queued",
    });
    return ensureSingleTaskFlow({
        task,
        requesterOrigin: params.requesterOrigin,
    });
}
export function getFlowTaskSummary(flowId) {
    return summarizeTaskRecords(listTasksForFlowId(flowId));
}
export function createRunningTaskRun(params) {
    const task = createTaskRecord({
        ...params,
        status: "running",
    });
    return ensureSingleTaskFlow({
        task,
        requesterOrigin: params.requesterOrigin,
    });
}
export function startTaskRunByRunId(params) {
    return markTaskRunningByRunId(params);
}
export function recordTaskRunProgressByRunId(params) {
    return recordTaskProgressByRunId(params);
}
export function completeTaskRunByRunId(params) {
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
export function failTaskRunByRunId(params) {
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
export function markTaskRunLostById(params) {
    return markTaskLostById(params);
}
export function setDetachedTaskDeliveryStatusByRunId(params) {
    return setTaskRunDeliveryStatusByRunId(params);
}
function resolveRetryableBlockedFlowTask(flowId) {
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
function retryBlockedFlowTask(params) {
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
export function retryBlockedFlowAsQueuedTaskRun(params) {
    return retryBlockedFlowTask({
        ...params,
        status: "queued",
    });
}
export function retryBlockedFlowAsRunningTaskRun(params) {
    return retryBlockedFlowTask({
        ...params,
        status: "running",
    });
}
function isActiveTaskStatus(status) {
    return status === "queued" || status === "running";
}
function isTerminalFlowStatus(status) {
    return (status === "succeeded" || status === "failed" || status === "cancelled" || status === "lost");
}
function markFlowCancelRequested(flow) {
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
        reason: result.reason === "revision_conflict"
            ? "Flow changed while cancellation was in progress."
            : "Flow not found.",
        flow: result.current ?? getTaskFlowById(flow.flowId),
    };
}
function cancelManagedFlowAfterChildrenSettle(flow, endedAt) {
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
        reason: result.reason === "revision_conflict"
            ? "Flow changed while cancellation was in progress."
            : "Flow not found.",
        flow: result.current ?? getTaskFlowById(flow.flowId),
    };
}
function mapRunTaskInFlowCreateError(params) {
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
export function runTaskInFlow(params) {
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
        scopeKind: "session",
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
    let task;
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
    }
    catch (error) {
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
export function runTaskInFlowForOwner(params) {
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
export async function cancelFlowById(params) {
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
        await cancelDetachedTaskRunById({
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
            reason: refreshedFlow.status === "cancelled"
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
export async function cancelFlowByIdForOwner(params) {
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
export async function cancelDetachedTaskRunById(params) {
    const task = getTaskById(params.taskId);
    if (!task) {
        return cancelTaskById(params);
    }
    const registeredRuntime = getRegisteredDetachedTaskLifecycleRuntime();
    if (registeredRuntime) {
        const cancelled = await registeredRuntime.cancelDetachedTaskRunById(params);
        if (cancelled.found) {
            return cancelled;
        }
    }
    return cancelTaskById(params);
}
