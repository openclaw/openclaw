import { listTasksForFlowId } from "../../tasks/runtime-internal.js";
import { mapTaskFlowDetail, mapTaskRunView } from "../../tasks/task-domain-views.js";
import {
  cancelDetachedTaskRunById,
  cancelFlowById,
  getFlowTaskSummary,
} from "../../tasks/task-executor.js";
import {
  listTaskFlowRecords,
  resolveTaskFlowForLookupToken,
} from "../../tasks/task-flow-runtime-internal.js";
import { listTaskRecords, resolveTaskForLookupToken } from "../../tasks/task-registry.js";
import {
  ErrorCodes,
  errorShape,
  validateTaskFlowsCancelParams,
  validateTaskFlowsGetParams,
  validateTaskFlowsListParams,
  validateTasksCancelParams,
  validateTasksGetParams,
  validateTasksListParams,
  type TaskFlowsListParams,
  type TasksListParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

const ACTIVE_TASK_STATUSES = new Set(["queued", "running"]);
const ACTIVE_FLOW_STATUSES = new Set(["queued", "running", "waiting"]);

function listFilteredTasks(params: TasksListParams) {
  return listTaskRecords()
    .filter((task) => !params.sessionKey || task.requesterSessionKey === params.sessionKey)
    .filter((task) => !params.ownerKey || task.ownerKey === params.ownerKey)
    .filter((task) => !params.agentId || task.agentId === params.agentId)
    .filter((task) => !params.runId || task.runId === params.runId)
    .filter((task) => !params.status || task.status === params.status)
    .filter(
      (task) =>
        params.active === undefined || ACTIVE_TASK_STATUSES.has(task.status) === params.active,
    )
    .map(mapTaskRunView);
}

function mapFlowDetail(flow: ReturnType<typeof listTaskFlowRecords>[number]) {
  const tasks = listTasksForFlowId(flow.flowId);
  return mapTaskFlowDetail({
    flow,
    tasks,
    summary: getFlowTaskSummary(flow.flowId),
  });
}

function listFilteredFlows(params: TaskFlowsListParams) {
  return listTaskFlowRecords()
    .filter((flow) => !params.ownerKey || flow.ownerKey === params.ownerKey)
    .filter((flow) => !params.status || flow.status === params.status)
    .filter(
      (flow) =>
        params.active === undefined || ACTIVE_FLOW_STATUSES.has(flow.status) === params.active,
    )
    .map(mapFlowDetail);
}

export const tasksHandlers: GatewayRequestHandlers = {
  "tasks.list": async ({ params, respond }) => {
    if (!assertValidParams(params, validateTasksListParams, "tasks.list", respond)) {
      return;
    }
    respond(true, { tasks: listFilteredTasks(params) }, undefined);
  },
  "tasks.get": async ({ params, respond }) => {
    if (!assertValidParams(params, validateTasksGetParams, "tasks.get", respond)) {
      return;
    }
    const task = resolveTaskForLookupToken(params.taskId);
    if (!task) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown taskId"));
      return;
    }
    respond(true, { task: mapTaskRunView(task) }, undefined);
  },
  "tasks.cancel": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateTasksCancelParams, "tasks.cancel", respond)) {
      return;
    }
    const result = await cancelDetachedTaskRunById({
      cfg: context.getRuntimeConfig(),
      taskId: params.taskId,
    });
    respond(
      true,
      {
        found: result.found,
        cancelled: result.cancelled,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.task ? { task: mapTaskRunView(result.task) } : {}),
      },
      undefined,
    );
  },
  "tasks.flows.list": async ({ params, respond }) => {
    if (!assertValidParams(params, validateTaskFlowsListParams, "tasks.flows.list", respond)) {
      return;
    }
    respond(true, { flows: listFilteredFlows(params) }, undefined);
  },
  "tasks.flows.get": async ({ params, respond }) => {
    if (!assertValidParams(params, validateTaskFlowsGetParams, "tasks.flows.get", respond)) {
      return;
    }
    const flow = resolveTaskFlowForLookupToken(params.flowId);
    if (!flow) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown flowId"));
      return;
    }
    respond(true, { flow: mapFlowDetail(flow) }, undefined);
  },
  "tasks.flows.cancel": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateTaskFlowsCancelParams, "tasks.flows.cancel", respond)) {
      return;
    }
    const result = await cancelFlowById({
      cfg: context.getRuntimeConfig(),
      flowId: params.flowId,
    });
    respond(
      true,
      {
        found: result.found,
        cancelled: result.cancelled,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.flow ? { flow: mapFlowDetail(result.flow) } : {}),
      },
      undefined,
    );
  },
};
