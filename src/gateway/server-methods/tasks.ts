import {
  mapTaskFlowDetail,
  mapTaskRunAggregateSummary,
  mapTaskRunDetail,
  mapTaskRunView,
} from "../../tasks/task-domain-views.js";
import { listTaskFlowRecords } from "../../tasks/task-flow-registry.js";
import type { TaskFlowRecord } from "../../tasks/task-flow-registry.types.js";
import type { TaskFlowStatus } from "../../tasks/task-flow-registry.types.js";
import { getTaskById, listTasksForFlowId } from "../../tasks/task-registry.js";
import {
  reconcileInspectableTasks,
  reconcileTaskLookupToken,
  reconcileTaskRecordForOperatorInspection,
} from "../../tasks/task-registry.maintenance.js";
import { summarizeTaskRecords } from "../../tasks/task-registry.summary.js";
import type { TaskRecord, TaskStatus } from "../../tasks/task-registry.types.js";
import {
  ErrorCodes,
  errorShape,
  validateTasksFlowsListParams,
  validateTasksListParams,
  validateTasksShowParams,
} from "../protocol/index.js";
import type { TasksFlowsListParams, TasksListParams } from "../protocol/schema/tasks.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

const TASK_STATUS_ORDER: Record<TaskStatus, number> = {
  running: 0,
  queued: 1,
  failed: 2,
  timed_out: 3,
  cancelled: 4,
  lost: 5,
  succeeded: 6,
};

const FLOW_STATUS_ORDER: Record<TaskFlowStatus, number> = {
  running: 0,
  queued: 1,
  blocked: 2,
  waiting: 3,
  failed: 4,
  cancelled: 5,
  lost: 6,
  succeeded: 7,
};

function normalizeQuery(query: string | undefined): string | null {
  const normalized = query?.trim().toLowerCase();
  return normalized ? normalized : null;
}

function taskSortKey(task: TaskRecord): number {
  return task.lastEventAt ?? task.startedAt ?? task.createdAt;
}

function flowSortKey(flow: TaskFlowRecord): number {
  return flow.updatedAt ?? flow.createdAt;
}

function matchesTaskQuery(task: TaskRecord, query: string | null): boolean {
  if (!query) {
    return true;
  }
  return [
    task.taskId,
    task.task,
    task.label,
    task.runId,
    task.agentId,
    task.requesterSessionKey,
    task.ownerKey,
    task.parentFlowId,
    task.progressSummary,
    task.terminalSummary,
    task.error,
  ].some((value) => typeof value === "string" && value.toLowerCase().includes(query));
}

function matchesTaskFilters(task: TaskRecord, params: TasksListParams): boolean {
  if (params.statuses && !params.statuses.includes(task.status)) {
    return false;
  }
  if (params.runtime && task.runtime !== params.runtime) {
    return false;
  }
  if (params.flowId && task.parentFlowId !== params.flowId) {
    return false;
  }
  if (params.sessionKey && task.requesterSessionKey !== params.sessionKey) {
    return false;
  }
  return matchesTaskQuery(task, normalizeQuery(params.query));
}

function matchesFlowFilters(flow: TaskFlowRecord, params: TasksFlowsListParams): boolean {
  if (params.statuses && !params.statuses.includes(flow.status)) {
    return false;
  }
  if (params.ownerKey && flow.ownerKey !== params.ownerKey) {
    return false;
  }
  const query = normalizeQuery(params.query);
  if (!query) {
    return true;
  }
  return [flow.flowId, flow.ownerKey, flow.goal, flow.currentStep, flow.blockedSummary].some(
    (value) => typeof value === "string" && value.toLowerCase().includes(query),
  );
}

function buildTaskDetail(task: TaskRecord) {
  return mapTaskRunDetail(task);
}

function buildFlowDetail(flow: TaskFlowRecord) {
  const tasks = listTasksForFlowId(flow.flowId).map((task) =>
    reconcileTaskRecordForOperatorInspection(task),
  );
  return mapTaskFlowDetail({
    flow,
    tasks,
    summary: summarizeTaskRecords(tasks),
  });
}

export const tasksHandlers: GatewayRequestHandlers = {
  "tasks.list": async ({ params, respond }) => {
    if (!assertValidParams(params, validateTasksListParams, "tasks.list", respond)) {
      return;
    }
    try {
      const tasks = reconcileInspectableTasks()
        .filter((task) => matchesTaskFilters(task, params))
        .toSorted((left, right) => {
          const statusDelta = TASK_STATUS_ORDER[left.status] - TASK_STATUS_ORDER[right.status];
          if (statusDelta !== 0) {
            return statusDelta;
          }
          return taskSortKey(right) - taskSortKey(left);
        });
      const limitedTasks = typeof params.limit === "number" ? tasks.slice(0, params.limit) : tasks;
      respond(
        true,
        {
          tasks: limitedTasks.map((task) => mapTaskRunView(task)),
          summary: mapTaskRunAggregateSummary(summarizeTaskRecords(limitedTasks)),
        },
        undefined,
      );
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(error)));
    }
  },
  "tasks.show": async ({ params, respond }) => {
    if (!assertValidParams(params, validateTasksShowParams, "tasks.show", respond)) {
      return;
    }
    try {
      const task =
        "id" in params
          ? (() => {
              const found = getTaskById(params.id);
              return found ? reconcileTaskRecordForOperatorInspection(found) : undefined;
            })()
          : reconcileTaskLookupToken(params.token);
      respond(true, { task: task ? buildTaskDetail(task) : null }, undefined);
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(error)));
    }
  },
  "tasks.flows.list": async ({ params, respond }) => {
    if (!assertValidParams(params, validateTasksFlowsListParams, "tasks.flows.list", respond)) {
      return;
    }
    try {
      const flows = listTaskFlowRecords()
        .filter((flow) => matchesFlowFilters(flow, params))
        .toSorted((left, right) => {
          const statusDelta = FLOW_STATUS_ORDER[left.status] - FLOW_STATUS_ORDER[right.status];
          if (statusDelta !== 0) {
            return statusDelta;
          }
          return flowSortKey(right) - flowSortKey(left);
        });
      const limitedFlows = typeof params.limit === "number" ? flows.slice(0, params.limit) : flows;
      respond(
        true,
        {
          flows: limitedFlows.map((flow) => buildFlowDetail(flow)),
        },
        undefined,
      );
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(error)));
    }
  },
};
