// Task gateway methods expose detached task list/get/cancel operations with
// bounded public summaries over the runtime task registry.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  type TaskSummary,
  type TasksListParams,
  validateTasksCancelParams,
  validateTasksGetParams,
  validateTasksListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { cancelDetachedTaskRunById } from "../../tasks/detached-task-runtime.js";
import { reconcileInspectableTasks } from "../../tasks/task-registry.reconcile.js";
import type {
  TaskMetadata,
  TaskMetadataValue,
  TaskRecord,
  TaskStatus,
} from "../../tasks/task-registry.types.js";
import {
  TASK_STATUS_DETAIL_MAX_CHARS,
  formatTaskStatusTitle,
  sanitizeTaskStatusText,
} from "../../tasks/task-status.js";
import type { GatewayRequestHandlers } from "./types.js";

const DEFAULT_TASKS_LIST_LIMIT = 100;
const MAX_TASKS_LIST_LIMIT = 500;
const TASK_METADATA_KEY_MAX_CHARS = 80;

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

function sanitizeTaskMetadataValue(value: TaskMetadataValue): TaskMetadataValue | undefined {
  if (typeof value !== "string") {
    return value;
  }
  return sanitizeOptionalTaskText(value, { errorContext: true });
}

function sanitizeTaskMetadata(metadata: TaskMetadata | undefined): TaskMetadata | undefined {
  if (!metadata) {
    return undefined;
  }
  const sanitized: TaskMetadata = {};
  for (const [rawKey, rawValue] of Object.entries(metadata)) {
    const key = sanitizeTaskStatusText(rawKey, {
      maxChars: TASK_METADATA_KEY_MAX_CHARS,
    });
    const value = sanitizeTaskMetadataValue(rawValue);
    if (key && value !== undefined) {
      sanitized[key] = value;
    }
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function mapTaskSummary(task: TaskRecord): TaskSummary {
  const progressSummary = sanitizeOptionalTaskText(task.progressSummary);
  const terminalSummary = sanitizeOptionalTaskText(task.terminalSummary, { errorContext: true });
  const error = sanitizeOptionalTaskText(task.error, { errorContext: true });
  const metadata = sanitizeTaskMetadata(task.metadata);
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
    ...(metadata ? { metadata } : {}),
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

function taskMatchesMetadata(task: TaskRecord, metadata: TasksListParams["metadata"]): boolean {
  if (!metadata || Object.keys(metadata).length === 0) {
    return true;
  }
  if (!task.metadata) {
    return false;
  }
  return Object.entries(metadata).every(([key, value]) => task.metadata?.[key] === value);
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
    const filtered = reconcileInspectableTasks().filter((task) => {
      if (statusFilter && !statusFilter.has(task.status)) {
        return false;
      }
      return (
        taskMatchesAgent(task, params.agentId) &&
        taskMatchesSession(task, params.sessionKey) &&
        taskMatchesMetadata(task, params.metadata)
      );
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
    const task = reconcileInspectableTasks().find((entry) => entry.taskId === taskId);
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
