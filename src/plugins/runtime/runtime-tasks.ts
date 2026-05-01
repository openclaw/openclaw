import {
  createPluginTaskRecord,
  finalizeTaskRunById,
  listTasksForFlowId,
  markTaskRunningById,
  recordTaskProgressById,
} from "../../tasks/runtime-internal.js";
import {
  mapTaskFlowDetail,
  mapTaskFlowView,
  mapTaskRunAggregateSummary,
  mapTaskRunDetail,
  mapTaskRunView,
} from "../../tasks/task-domain-views.js";
import { cancelDetachedTaskRunById, getFlowTaskSummary } from "../../tasks/task-executor.js";
import {
  getTaskFlowByIdForOwner,
  listTaskFlowsForOwner,
  findLatestTaskFlowForOwner,
  resolveTaskFlowForLookupTokenForOwner,
} from "../../tasks/task-flow-owner-access.js";
import {
  findLatestTaskForRelatedSessionKeyForOwner,
  getTaskByIdForOwner,
  listTasksForRelatedSessionKeyForOwner,
  resolveTaskForLookupTokenForOwner,
} from "../../tasks/task-owner-access.js";
import { normalizeDeliveryContext } from "../../utils/delivery-context.shared.js";
import type { PluginRuntimeTaskFlow } from "./runtime-taskflow.types.js";
import type {
  BoundTaskFlowsRuntime,
  BoundTaskRunsRuntime,
  PluginRuntimeTaskFlows,
  PluginRuntimeTaskRuns,
  PluginRuntimeTasks,
  TaskFlowDetail,
  TaskRunCancelResult,
  TaskRunDetail,
  TaskRunLifecycleCreateParams,
  TaskRunLifecycleFinalizeParams,
  TaskRunLifecycleProgressParams,
  TaskRunLifecycleRuntime,
} from "./runtime-tasks.types.js";
export type {
  BoundTaskFlowsRuntime,
  BoundTaskRunsRuntime,
  PluginRuntimeTaskFlows,
  PluginRuntimeTaskRuns,
  PluginRuntimeTasks,
  TaskRunLifecycleRuntime,
} from "./runtime-tasks.types.js";

function assertSessionKey(sessionKey: string | undefined, errorMessage: string): string {
  const normalized = sessionKey?.trim();
  if (!normalized) {
    throw new Error(errorMessage);
  }
  return normalized;
}

function assertRequiredString(value: string | undefined, errorMessage: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(errorMessage);
  }
  return normalized;
}

function mapCancelledTaskResult(
  result: Awaited<ReturnType<typeof cancelDetachedTaskRunById>>,
): TaskRunCancelResult {
  return {
    found: result.found,
    cancelled: result.cancelled,
    ...(result.reason ? { reason: result.reason } : {}),
    ...(result.task ? { task: mapTaskRunDetail(result.task) } : {}),
  };
}

function findLifecycleTask(params: { ownerKey: string; taskKind: string; runId: string }) {
  return listTasksForRelatedSessionKeyForOwner({
    relatedSessionKey: params.ownerKey,
    callerOwnerKey: params.ownerKey,
  }).find(
    (task) =>
      task.runtime === "cli" && task.taskKind === params.taskKind && task.runId === params.runId,
  );
}

function createTaskRunLifecycleRuntime(params: {
  ownerKey: string;
  requesterOrigin?: import("../../tasks/task-registry.types.js").TaskDeliveryState["requesterOrigin"];
}): TaskRunLifecycleRuntime {
  const create = (input: TaskRunLifecycleCreateParams): TaskRunDetail => {
    const taskKind = assertRequiredString(
      input.taskKind,
      "Task lifecycle create requires taskKind.",
    );
    const runId = assertRequiredString(input.runId, "Task lifecycle create requires runId.");
    const title = assertRequiredString(input.title, "Task lifecycle create requires title.");
    const status = input.status ?? "running";
    const task = createPluginTaskRecord({
      runtime: "cli",
      taskKind,
      sourceId: input.sourceId,
      requesterSessionKey: params.ownerKey,
      ownerKey: params.ownerKey,
      scopeKind: "session",
      requesterOrigin: params.requesterOrigin,
      agentId: input.agentId,
      runId,
      label: input.label,
      task: title,
      preferMetadata: true,
      status,
      startedAt: status === "running" ? (input.startedAt ?? Date.now()) : input.startedAt,
      lastEventAt: input.lastEventAt,
      progressSummary: input.progressSummary,
      notifyPolicy: input.notifyPolicy,
      deliveryStatus: input.deliveryStatus,
    });
    if (status === "running" && task.status !== "running") {
      return mapTaskRunDetail(
        markTaskRunningById({
          taskId: task.taskId,
          startedAt: input.startedAt ?? Date.now(),
          lastEventAt: input.lastEventAt,
          progressSummary: input.progressSummary,
        }) ?? task,
      );
    }
    return mapTaskRunDetail(task);
  };

  const progress = (input: TaskRunLifecycleProgressParams): TaskRunDetail | undefined => {
    const taskKind = assertRequiredString(
      input.taskKind,
      "Task lifecycle progress requires taskKind.",
    );
    const runId = assertRequiredString(input.runId, "Task lifecycle progress requires runId.");
    const task = findLifecycleTask({ ownerKey: params.ownerKey, taskKind, runId });
    if (!task) {
      return undefined;
    }
    const updated = recordTaskProgressById({
      taskId: task.taskId,
      lastEventAt: input.lastEventAt,
      progressSummary: input.progressSummary,
      eventSummary: input.eventSummary,
    });
    return updated ? mapTaskRunDetail(updated) : undefined;
  };

  const finalize = (input: TaskRunLifecycleFinalizeParams): TaskRunDetail | undefined => {
    const taskKind = assertRequiredString(
      input.taskKind,
      "Task lifecycle finalize requires taskKind.",
    );
    const runId = assertRequiredString(input.runId, "Task lifecycle finalize requires runId.");
    const task = findLifecycleTask({ ownerKey: params.ownerKey, taskKind, runId });
    if (!task) {
      return undefined;
    }
    const updated = finalizeTaskRunById({
      taskId: task.taskId,
      status: input.status,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      lastEventAt: input.lastEventAt,
      error: input.error,
      progressSummary: input.progressSummary,
      terminalSummary: input.terminalSummary,
      terminalOutcome: input.terminalOutcome,
    });
    return updated ? mapTaskRunDetail(updated) : undefined;
  };

  return { create, progress, finalize };
}

function createBoundTaskRunsRuntime(params: {
  sessionKey: string;
  requesterOrigin?: import("../../tasks/task-registry.types.js").TaskDeliveryState["requesterOrigin"];
}): BoundTaskRunsRuntime {
  const ownerKey = assertSessionKey(
    params.sessionKey,
    "Tasks runtime requires a bound sessionKey.",
  );
  const requesterOrigin = params.requesterOrigin
    ? normalizeDeliveryContext(params.requesterOrigin)
    : undefined;
  return {
    sessionKey: ownerKey,
    ...(requesterOrigin ? { requesterOrigin } : {}),
    lifecycle: createTaskRunLifecycleRuntime({
      ownerKey,
      requesterOrigin,
    }),
    get: (taskId) => {
      const task = getTaskByIdForOwner({ taskId, callerOwnerKey: ownerKey });
      return task ? mapTaskRunDetail(task) : undefined;
    },
    list: () =>
      listTasksForRelatedSessionKeyForOwner({
        relatedSessionKey: ownerKey,
        callerOwnerKey: ownerKey,
      }).map((task) => mapTaskRunView(task)),
    findLatest: () => {
      const task = findLatestTaskForRelatedSessionKeyForOwner({
        relatedSessionKey: ownerKey,
        callerOwnerKey: ownerKey,
      });
      return task ? mapTaskRunDetail(task) : undefined;
    },
    resolve: (token) => {
      const task = resolveTaskForLookupTokenForOwner({
        token,
        callerOwnerKey: ownerKey,
      });
      return task ? mapTaskRunDetail(task) : undefined;
    },
    cancel: async ({ taskId, cfg }) => {
      const task = getTaskByIdForOwner({
        taskId,
        callerOwnerKey: ownerKey,
      });
      if (!task) {
        return {
          found: false,
          cancelled: false,
          reason: "Task not found.",
        };
      }
      return mapCancelledTaskResult(
        await cancelDetachedTaskRunById({
          cfg,
          taskId: task.taskId,
        }),
      );
    },
  };
}

function createBoundTaskFlowsRuntime(params: {
  sessionKey: string;
  requesterOrigin?: import("../../tasks/task-registry.types.js").TaskDeliveryState["requesterOrigin"];
}): BoundTaskFlowsRuntime {
  const ownerKey = assertSessionKey(
    params.sessionKey,
    "TaskFlow runtime requires a bound sessionKey.",
  );
  const requesterOrigin = params.requesterOrigin
    ? normalizeDeliveryContext(params.requesterOrigin)
    : undefined;

  const getDetail = (flowId: string): TaskFlowDetail | undefined => {
    const flow = getTaskFlowByIdForOwner({
      flowId,
      callerOwnerKey: ownerKey,
    });
    if (!flow) {
      return undefined;
    }
    const tasks = listTasksForFlowId(flow.flowId);
    return mapTaskFlowDetail({
      flow,
      tasks,
      summary: getFlowTaskSummary(flow.flowId),
    });
  };

  return {
    sessionKey: ownerKey,
    ...(requesterOrigin ? { requesterOrigin } : {}),
    get: (flowId) => getDetail(flowId),
    list: () =>
      listTaskFlowsForOwner({
        callerOwnerKey: ownerKey,
      }).map((flow) => mapTaskFlowView(flow)),
    findLatest: () => {
      const flow = findLatestTaskFlowForOwner({
        callerOwnerKey: ownerKey,
      });
      return flow ? getDetail(flow.flowId) : undefined;
    },
    resolve: (token) => {
      const flow = resolveTaskFlowForLookupTokenForOwner({
        token,
        callerOwnerKey: ownerKey,
      });
      return flow ? getDetail(flow.flowId) : undefined;
    },
    getTaskSummary: (flowId) => {
      const flow = getTaskFlowByIdForOwner({
        flowId,
        callerOwnerKey: ownerKey,
      });
      return flow ? mapTaskRunAggregateSummary(getFlowTaskSummary(flow.flowId)) : undefined;
    },
  };
}

export function createRuntimeTaskRuns(): PluginRuntimeTaskRuns {
  return {
    bindSession: (params) =>
      createBoundTaskRunsRuntime({
        sessionKey: params.sessionKey,
        requesterOrigin: params.requesterOrigin,
      }),
    fromToolContext: (ctx) =>
      createBoundTaskRunsRuntime({
        sessionKey: assertSessionKey(
          ctx.sessionKey,
          "Tasks runtime requires tool context with a sessionKey.",
        ),
        requesterOrigin: ctx.deliveryContext,
      }),
  };
}

export function createRuntimeTaskFlows(): PluginRuntimeTaskFlows {
  return {
    bindSession: (params) =>
      createBoundTaskFlowsRuntime({
        sessionKey: params.sessionKey,
        requesterOrigin: params.requesterOrigin,
      }),
    fromToolContext: (ctx) =>
      createBoundTaskFlowsRuntime({
        sessionKey: assertSessionKey(
          ctx.sessionKey,
          "TaskFlow runtime requires tool context with a sessionKey.",
        ),
        requesterOrigin: ctx.deliveryContext,
      }),
  };
}

export function createRuntimeTasks(params: {
  legacyTaskFlow: PluginRuntimeTaskFlow;
}): PluginRuntimeTasks {
  return {
    runs: createRuntimeTaskRuns(),
    flows: createRuntimeTaskFlows(),
    managedFlows: params.legacyTaskFlow,
    flow: params.legacyTaskFlow,
  };
}
