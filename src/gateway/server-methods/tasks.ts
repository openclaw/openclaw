import type { ErrorObject } from "ajv";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { getTaskById, listTaskRecords } from "../../tasks/runtime-internal.js";
import { cancelDetachedTaskRunById } from "../../tasks/task-executor.js";
import type { TaskRecord, TaskStatus } from "../../tasks/task-registry.types.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  type TasksCancelResult,
  type TasksGetResult,
  type TasksListResult,
  validateTasksCancelParams,
  validateTasksGetParams,
  validateTasksListParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

function invalidParams(method: string, errors: ErrorObject[] | null | undefined) {
  return errorShape(
    ErrorCodes.INVALID_REQUEST,
    `invalid ${method} params: ${formatValidationErrors(errors)}`,
  );
}

function normalizeStatusFilter(status: TaskStatus | TaskStatus[] | undefined): Set<TaskStatus> {
  return new Set(Array.isArray(status) ? status : status ? [status] : []);
}

function matchesSessionKey(task: TaskRecord, sessionKey: string | undefined): boolean {
  if (!sessionKey) {
    return true;
  }
  return (
    task.requesterSessionKey === sessionKey ||
    task.ownerKey === sessionKey ||
    task.childSessionKey === sessionKey
  );
}

function filterTaskRecords(
  tasks: TaskRecord[],
  params: {
    status?: TaskStatus | TaskStatus[];
    agentId?: string;
    sessionKey?: string;
    limit?: number;
  },
): TaskRecord[] {
  const statuses = normalizeStatusFilter(params.status);
  const agentId = normalizeOptionalString(params.agentId);
  const sessionKey = normalizeOptionalString(params.sessionKey);
  const filtered = tasks.filter((task) => {
    if (statuses.size > 0 && !statuses.has(task.status)) {
      return false;
    }
    if (agentId && task.agentId !== agentId) {
      return false;
    }
    return matchesSessionKey(task, sessionKey);
  });
  return params.limit ? filtered.slice(0, params.limit) : filtered;
}

function normalizeTaskId(taskId: string): string | null {
  return normalizeOptionalString(taskId) ?? null;
}

export const tasksHandlers: GatewayRequestHandlers = {
  "tasks.list": ({ params, respond }) => {
    if (!validateTasksListParams(params)) {
      respond(false, undefined, invalidParams("tasks.list", validateTasksListParams.errors));
      return;
    }
    const tasks = filterTaskRecords(listTaskRecords(), params);
    const result: TasksListResult = {
      count: tasks.length,
      tasks,
    };
    respond(true, result, undefined);
  },
  "tasks.get": ({ params, respond }) => {
    if (!validateTasksGetParams(params)) {
      respond(false, undefined, invalidParams("tasks.get", validateTasksGetParams.errors));
      return;
    }
    const taskId = normalizeTaskId(params.taskId);
    if (!taskId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid tasks.get params: taskId is required"),
      );
      return;
    }
    const task = getTaskById(taskId);
    const result: TasksGetResult = task ? { found: true, task } : { found: false };
    respond(true, result, undefined);
  },
  "tasks.cancel": async ({ params, respond, context }) => {
    if (!validateTasksCancelParams(params)) {
      respond(false, undefined, invalidParams("tasks.cancel", validateTasksCancelParams.errors));
      return;
    }
    const taskId = normalizeTaskId(params.taskId);
    if (!taskId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid tasks.cancel params: taskId is required"),
      );
      return;
    }
    const result: TasksCancelResult = await cancelDetachedTaskRunById({
      cfg: context.getRuntimeConfig(),
      taskId,
    });
    respond(true, result, undefined);
  },
};
