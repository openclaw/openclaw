// Task gateway methods expose detached task list/get/cancel operations with
// bounded public summaries over the runtime task registry and task-flow status.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  type TaskFlowDetail,
  type TaskFlowsListParams,
  type TaskSummary,
  type TasksListParams,
  validateTaskFlowsCancelParams,
  validateTaskFlowsCreateParams,
  validateTaskFlowsGetParams,
  validateTaskFlowsListParams,
  validateTasksCancelParams,
  validateTasksGetParams,
  validateTasksListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { cancelDetachedTaskRunById } from "../../tasks/detached-task-runtime.js";
import { getTaskById, listTaskRecords, listTasksForFlowId } from "../../tasks/runtime-internal.js";
import { cancelFlowById } from "../../tasks/task-executor.js";
import type { TaskFlowRecord, TaskFlowStatus } from "../../tasks/task-flow-registry.types.js";
import {
  createManagedTaskFlow,
  getTaskFlowById,
  listTaskFlowRecords,
} from "../../tasks/task-flow-runtime-internal.js";
import type { TaskRecord, TaskStatus } from "../../tasks/task-registry.types.js";
import {
  TASK_STATUS_DETAIL_MAX_CHARS,
  formatTaskStatusTitle,
  sanitizeTaskStatusText,
} from "../../tasks/task-status.js";
import type { GatewayRequestHandlers } from "./types.js";

const DEFAULT_TASKS_LIST_LIMIT = 100;
const MAX_TASKS_LIST_LIMIT = 500;
const DEFAULT_TASK_FLOWS_LIST_LIMIT = 50;
const MAX_TASK_FLOWS_LIST_LIMIT = 500;
const CHAT_GOAL_CONTROLLER_ID = "control-ui-chat";

type TaskLedgerStatus = TaskSummary["status"];

// Gateway task APIs preserve the older ledger status vocabulary while the
// runtime registry tracks finer-grained task states such as `lost`.
const TASK_STATUS_TO_LEDGER_STATUS: Record<TaskStatus, TaskLedgerStatus> = {
  queued: "queued",
  running: "running",
  succeeded: "completed",
  failed: "failed",
  timed_out: "timed_out",
  cancelled: "cancelled",
  lost: "failed",
};

const LEDGER_STATUS_TO_TASK_STATUSES: Record<TaskLedgerStatus, TaskStatus[]> = {
  queued: ["queued"],
  running: ["running"],
  completed: ["succeeded"],
  failed: ["failed", "lost"],
  timed_out: ["timed_out"],
  cancelled: ["cancelled"],
};

function taskUpdatedAt(task: TaskRecord): number {
  return task.lastEventAt ?? task.endedAt ?? task.startedAt ?? task.createdAt;
}

// Status text can originate from providers, shells, and subprocesses. Keep the
// public task shape bounded before it reaches control-plane clients.
function sanitizeOptionalTaskText(
  value: unknown,
  opts?: { errorContext?: boolean },
): string | undefined {
  const sanitized = sanitizeTaskStatusText(value, {
    errorContext: opts?.errorContext,
    maxChars: TASK_STATUS_DETAIL_MAX_CHARS,
  });
  return sanitized || undefined;
}

function mapTaskSummary(task: TaskRecord): TaskSummary {
  const progressSummary = sanitizeOptionalTaskText(task.progressSummary);
  const terminalSummary = sanitizeOptionalTaskText(task.terminalSummary, { errorContext: true });
  const error = sanitizeOptionalTaskText(task.error, { errorContext: true });
  return {
    id: task.taskId,
    taskId: task.taskId,
    kind: task.taskKind ?? task.runtime,
    runtime: task.runtime,
    status: TASK_STATUS_TO_LEDGER_STATUS[task.status],
    title: formatTaskStatusTitle(task),
    ...(task.agentId ? { agentId: task.agentId } : {}),
    sessionKey: task.requesterSessionKey,
    ...(task.childSessionKey ? { childSessionKey: task.childSessionKey } : {}),
    ownerKey: task.ownerKey,
    ...(task.runId ? { runId: task.runId } : {}),
    ...(task.parentFlowId ? { flowId: task.parentFlowId } : {}),
    ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
    ...(task.sourceId ? { sourceId: task.sourceId } : {}),
    createdAt: task.createdAt,
    updatedAt: taskUpdatedAt(task),
    ...(task.startedAt !== undefined ? { startedAt: task.startedAt } : {}),
    ...(task.endedAt !== undefined ? { endedAt: task.endedAt } : {}),
    ...(progressSummary ? { progressSummary } : {}),
    ...(terminalSummary ? { terminalSummary } : {}),
    ...(error ? { error } : {}),
  };
}

function isActiveTaskStatus(status: TaskRecord["status"]): boolean {
  return status === "queued" || status === "running";
}

function isTerminalTaskStatus(status: TaskRecord["status"]): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "timed_out" ||
    status === "cancelled" ||
    status === "lost"
  );
}

function summarizeTaskFlowTasks(tasks: TaskRecord[]): TaskFlowDetail["taskSummary"] {
  let active = 0;
  let terminal = 0;
  let failures = 0;
  for (const task of tasks) {
    if (isActiveTaskStatus(task.status)) {
      active += 1;
    }
    if (isTerminalTaskStatus(task.status)) {
      terminal += 1;
    }
    if (task.status === "failed" || task.status === "timed_out" || task.status === "lost") {
      failures += 1;
    }
  }
  return {
    total: tasks.length,
    active,
    terminal,
    failures,
  };
}

function mapTaskFlowDetail(flow: TaskFlowRecord): TaskFlowDetail {
  const tasks = listTasksForFlowId(flow.flowId);
  return {
    id: flow.flowId,
    flowId: flow.flowId,
    ownerKey: flow.ownerKey,
    ...(flow.requesterOrigin ? { requesterOrigin: flow.requesterOrigin } : {}),
    status: flow.status,
    notifyPolicy: flow.notifyPolicy,
    goal: sanitizeTaskStatusText(flow.goal, { maxChars: TASK_STATUS_DETAIL_MAX_CHARS }),
    ...(flow.currentStep
      ? {
          currentStep: sanitizeTaskStatusText(flow.currentStep, {
            maxChars: TASK_STATUS_DETAIL_MAX_CHARS,
          }),
        }
      : {}),
    ...(flow.blockedTaskId ? { blockedTaskId: flow.blockedTaskId } : {}),
    ...(flow.blockedSummary
      ? {
          blockedSummary: sanitizeTaskStatusText(flow.blockedSummary, {
            errorContext: true,
            maxChars: TASK_STATUS_DETAIL_MAX_CHARS,
          }),
        }
      : {}),
    ...(flow.cancelRequestedAt !== undefined ? { cancelRequestedAt: flow.cancelRequestedAt } : {}),
    createdAt: flow.createdAt,
    updatedAt: flow.updatedAt,
    ...(flow.endedAt !== undefined ? { endedAt: flow.endedAt } : {}),
    tasks: tasks.map((task) => mapTaskSummary(task)),
    taskSummary: summarizeTaskFlowTasks(tasks),
  };
}

function normalizeTaskStatusFilter(status: TasksListParams["status"]): Set<TaskStatus> | null {
  if (!status) {
    return null;
  }
  const statuses = Array.isArray(status) ? status : [status];
  return new Set(statuses.flatMap((value) => LEDGER_STATUS_TO_TASK_STATUSES[value] ?? []));
}

// Session filtering needs all ownership keys because detached child runs may be
// queried from the requester, child session, or owner/control-plane view.
function taskMatchesSession(task: TaskRecord, sessionKey: string | undefined): boolean {
  const normalized = normalizeOptionalString(sessionKey);
  if (!normalized) {
    return true;
  }
  return [task.requesterSessionKey, task.childSessionKey, task.ownerKey].some(
    (candidate) => normalizeOptionalString(candidate) === normalized,
  );
}

// Explicit `task.agentId` is authoritative: a task that records its own agent
// must not also match other agents through the session-key fallback. Only
// records that predate a direct `agentId` recover the owning agent from
// session-style keys instead of being hidden.
function taskMatchesAgent(task: TaskRecord, agentId: string | undefined): boolean {
  const normalized = normalizeOptionalString(agentId);
  if (!normalized) {
    return true;
  }
  const explicitAgentId = normalizeOptionalString(task.agentId);
  if (explicitAgentId) {
    return explicitAgentId === normalized;
  }
  return [task.requesterSessionKey, task.childSessionKey, task.ownerKey].some(
    (candidate) => parseAgentSessionKey(candidate)?.agentId === normalized,
  );
}

function flowMatchesOwner(
  flow: TaskFlowRecord,
  params: { ownerKey?: string; sessionKey?: string },
) {
  const ownerKey = normalizeOptionalString(params.ownerKey ?? params.sessionKey);
  if (!ownerKey) {
    return true;
  }
  return normalizeOptionalString(flow.ownerKey) === ownerKey;
}

function flowMatchesStatusFilter(
  flow: TaskFlowRecord,
  status: TaskFlowsListParams["status"],
): boolean {
  if (!status) {
    return true;
  }
  const statuses = Array.isArray(status) ? status : [status];
  return new Set<TaskFlowStatus>(statuses).has(flow.status);
}

// Cursor strings are offsets, not opaque tokens; reject malformed values so a
// client cannot silently restart pagination at the first page.
function parseCursor(cursor: string | undefined): number | null {
  if (!cursor) {
    return 0;
  }
  if (!/^\d+$/.test(cursor.trim())) {
    return null;
  }
  const parsed = Number(cursor);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

// Control UI task methods expose the stable gateway protocol shape; helpers
// above keep runtime registry details out of the wire result.
export const tasksHandlers: GatewayRequestHandlers = {
  "taskFlows.list": ({ params, respond }) => {
    if (!validateTaskFlowsListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid taskFlows.list params: ${formatValidationErrors(validateTaskFlowsListParams.errors)}`,
        ),
      );
      return;
    }
    const cursor = parseCursor(params.cursor);
    if (cursor === null) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid taskFlows.list cursor"),
      );
      return;
    }
    const limit = Math.min(
      params.limit ?? DEFAULT_TASK_FLOWS_LIST_LIMIT,
      MAX_TASK_FLOWS_LIST_LIMIT,
    );
    const filtered = listTaskFlowRecords().filter(
      (flow) => flowMatchesOwner(flow, params) && flowMatchesStatusFilter(flow, params.status),
    );
    const page = filtered.slice(cursor, cursor + limit);
    const nextOffset = cursor + page.length;
    respond(true, {
      flows: page.map((flow) => mapTaskFlowDetail(flow)),
      ...(nextOffset < filtered.length ? { nextCursor: String(nextOffset) } : {}),
    });
  },
  "taskFlows.get": ({ params, respond }) => {
    if (!validateTaskFlowsGetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid taskFlows.get params: ${formatValidationErrors(validateTaskFlowsGetParams.errors)}`,
        ),
      );
      return;
    }
    const flow = getTaskFlowById(params.flowId);
    if (!flow || !flowMatchesOwner(flow, { sessionKey: params.sessionKey })) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `task flow not found: ${params.flowId}`),
      );
      return;
    }
    respond(true, { flow: mapTaskFlowDetail(flow) });
  },
  "taskFlows.create": ({ params, respond }) => {
    if (!validateTaskFlowsCreateParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid taskFlows.create params: ${formatValidationErrors(validateTaskFlowsCreateParams.errors)}`,
        ),
      );
      return;
    }
    const sessionKey = params.sessionKey.trim();
    const goal = sanitizeTaskStatusText(params.goal, { maxChars: TASK_STATUS_DETAIL_MAX_CHARS });
    if (!sessionKey || !goal) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "sessionKey and goal are required"),
      );
      return;
    }
    const flow = createManagedTaskFlow({
      ownerKey: sessionKey,
      controllerId: CHAT_GOAL_CONTROLLER_ID,
      requesterOrigin: { channel: "webchat", to: sessionKey },
      status: "running",
      notifyPolicy: "silent",
      goal,
      currentStep: normalizeOptionalString(params.currentStep) ?? "Goal accepted from Chat.",
    });
    if (!flow) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "task flow store is unavailable", { retryable: true }),
      );
      return;
    }
    respond(true, { flow: mapTaskFlowDetail(flow) });
  },
  "taskFlows.cancel": async ({ params, respond, context }) => {
    if (!validateTaskFlowsCancelParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid taskFlows.cancel params: ${formatValidationErrors(validateTaskFlowsCancelParams.errors)}`,
        ),
      );
      return;
    }
    const flow = getTaskFlowById(params.flowId);
    if (!flow || !flowMatchesOwner(flow, { sessionKey: params.sessionKey })) {
      respond(true, { found: false, cancelled: false, reason: "Flow not found." });
      return;
    }
    const result = await cancelFlowById({
      cfg: context.getRuntimeConfig(),
      flowId: flow.flowId,
    });
    respond(true, {
      found: result.found,
      cancelled: result.cancelled,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.flow ? { flow: mapTaskFlowDetail(result.flow) } : {}),
    });
  },
  "tasks.list": ({ params, respond }) => {
    if (!validateTasksListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid tasks.list params: ${formatValidationErrors(validateTasksListParams.errors)}`,
        ),
      );
      return;
    }
    const cursor = parseCursor(params.cursor);
    if (cursor === null) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid tasks.list cursor"),
      );
      return;
    }
    const statusFilter = normalizeTaskStatusFilter(params.status);
    const limit = Math.min(params.limit ?? DEFAULT_TASKS_LIST_LIMIT, MAX_TASKS_LIST_LIMIT);
    const filtered = listTaskRecords().filter((task) => {
      if (statusFilter && !statusFilter.has(task.status)) {
        return false;
      }
      return taskMatchesAgent(task, params.agentId) && taskMatchesSession(task, params.sessionKey);
    });
    const page = filtered.slice(cursor, cursor + limit);
    const nextOffset = cursor + page.length;
    respond(true, {
      tasks: page.map((task) => mapTaskSummary(task)),
      ...(nextOffset < filtered.length ? { nextCursor: String(nextOffset) } : {}),
    });
  },
  "tasks.get": ({ params, respond }) => {
    if (!validateTasksGetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid tasks.get params: ${formatValidationErrors(validateTasksGetParams.errors)}`,
        ),
      );
      return;
    }
    const taskId = params.taskId;
    const task = getTaskById(taskId);
    if (!task) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `task not found: ${taskId}`),
      );
      return;
    }
    respond(true, { task: mapTaskSummary(task) });
  },
  "tasks.cancel": async ({ params, respond, context }) => {
    if (!validateTasksCancelParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid tasks.cancel params: ${formatValidationErrors(validateTasksCancelParams.errors)}`,
        ),
      );
      return;
    }
    const taskId = params.taskId;
    const reason = normalizeOptionalString(params.reason);
    const result = await cancelDetachedTaskRunById({
      cfg: context.getRuntimeConfig(),
      taskId,
      ...(reason ? { reason } : {}),
    });
    respond(true, {
      found: result.found,
      cancelled: result.cancelled,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.task ? { task: mapTaskSummary(result.task) } : {}),
    });
  },
};

export const testApi = {
  mapTaskSummary,
};
export { testApi as __test };
