import type { DeliveryContext } from "../utils/delivery-context.types.js";

/** Runtime family that owns execution and cancellation semantics for a task. */
export type TaskRuntime = "subagent" | "acp" | "cli" | "cron";

/** Persisted lifecycle state for detached/background task records. */
export type TaskStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "lost";

/** Delivery state for notifying the requester about task progress or completion. */
export type TaskDeliveryStatus =
  | "pending"
  | "delivered"
  | "session_queued"
  | "failed"
  | "parent_missing"
  | "not_applicable";

/** Notification policy applied when task state changes or reaches terminal state. */
export type TaskNotifyPolicy = "done_only" | "state_changes" | "silent";

/** Terminal outcome layered on top of a succeeded status for retryable blocks. */
export type TaskTerminalOutcome = "succeeded" | "blocked";
/** Visibility class for owner-scoped session tasks versus internal system tasks. */
export type TaskScopeKind = "session" | "system";

export type TaskStatusCounts = Record<TaskStatus, number>;
export type TaskRuntimeCounts = Record<TaskRuntime, number>;

const TASK_RUNTIMES = new Set<TaskRuntime>(["subagent", "acp", "cli", "cron"]);
const TASK_STATUSES = new Set<TaskStatus>([
  "queued",
  "running",
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "lost",
]);
const TASK_DELIVERY_STATUSES = new Set<TaskDeliveryStatus>([
  "pending",
  "delivered",
  "session_queued",
  "failed",
  "parent_missing",
  "not_applicable",
]);
const TASK_NOTIFY_POLICIES = new Set<TaskNotifyPolicy>(["done_only", "state_changes", "silent"]);
const TASK_TERMINAL_OUTCOMES = new Set<TaskTerminalOutcome>(["succeeded", "blocked"]);
const TASK_SCOPE_KINDS = new Set<TaskScopeKind>(["session", "system"]);

function parsePersistedTaskValue<T extends string>(
  value: unknown,
  values: ReadonlySet<T>,
  label: string,
): T {
  if (typeof value === "string" && values.has(value as T)) {
    return value as T;
  }
  throw new Error(`Invalid persisted task ${label}: ${JSON.stringify(value)}`);
}

/** Parses and validates a persisted task runtime enum value. */
export function parseTaskRuntime(value: unknown): TaskRuntime {
  return parsePersistedTaskValue(value, TASK_RUNTIMES, "runtime");
}

/** Parses and validates a persisted task status enum value. */
export function parseTaskStatus(value: unknown): TaskStatus {
  return parsePersistedTaskValue(value, TASK_STATUSES, "status");
}

/** Parses and validates a persisted task delivery status enum value. */
export function parseTaskDeliveryStatus(value: unknown): TaskDeliveryStatus {
  return parsePersistedTaskValue(value, TASK_DELIVERY_STATUSES, "delivery status");
}

/** Parses and validates a persisted task notification policy enum value. */
export function parseTaskNotifyPolicy(value: unknown): TaskNotifyPolicy {
  return parsePersistedTaskValue(value, TASK_NOTIFY_POLICIES, "notify policy");
}

/** Parses and validates a persisted task scope kind enum value. */
export function parseTaskScopeKind(value: unknown): TaskScopeKind {
  return parsePersistedTaskValue(value, TASK_SCOPE_KINDS, "scope kind");
}

/** Parses an optional persisted terminal outcome, treating blanks as absent. */
export function parseOptionalTaskTerminalOutcome(value: unknown): TaskTerminalOutcome | undefined {
  if (value == null || value === "") {
    return undefined;
  }
  return parsePersistedTaskValue(value, TASK_TERMINAL_OUTCOMES, "terminal outcome");
}

export type TaskRegistrySummary = {
  total: number;
  active: number;
  terminal: number;
  failures: number;
  byStatus: TaskStatusCounts;
  byRuntime: TaskRuntimeCounts;
};

/** Persisted event kind for lifecycle transitions and progress-only updates. */
export type TaskEventKind = TaskStatus | "progress";

export type TaskEventRecord = {
  at: number;
  kind: TaskEventKind;
  summary?: string;
};

export type TaskDeliveryState = {
  taskId: string;
  /** Original requester origin used for notification routing. */
  requesterOrigin?: DeliveryContext;
  /** Last event timestamp that produced a notification, for dedupe. */
  lastNotifiedEventAt?: number;
};

/** Canonical persisted task record stored by the detached task registry. */
export type TaskRecord = {
  taskId: string;
  runtime: TaskRuntime;
  taskKind?: string;
  sourceId?: string;
  /** Session that requested the task, used for related-session lookups. */
  requesterSessionKey: string;
  /** Owner boundary used by runtime APIs before exposing task state. */
  ownerKey: string;
  scopeKind: TaskScopeKind;
  /** Backing child session when the work runs outside the requester turn. */
  childSessionKey?: string;
  parentFlowId?: string;
  parentTaskId?: string;
  agentId?: string;
  runId?: string;
  label?: string;
  task: string;
  status: TaskStatus;
  deliveryStatus: TaskDeliveryStatus;
  notifyPolicy: TaskNotifyPolicy;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  lastEventAt?: number;
  cleanupAfter?: number;
  error?: string;
  progressSummary?: string;
  terminalSummary?: string;
  terminalOutcome?: TaskTerminalOutcome;
};

/** Persisted task registry snapshot loaded from durable storage. */
export type TaskRegistrySnapshot = {
  tasks: TaskRecord[];
  deliveryStates: TaskDeliveryState[];
};
