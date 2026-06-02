import type { JsonValue } from "../../tasks/task-flow-registry.types.js";
import type {
  TaskDeliveryStatus,
  TaskNotifyPolicy,
  TaskRuntime,
  TaskScopeKind,
  TaskRuntimeCounts,
  TaskStatus,
  TaskStatusCounts,
  TaskTerminalOutcome,
} from "../../tasks/task-registry.types.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";

/** Aggregated task counts exposed with TaskFlow details. */
export type TaskRunAggregateSummary = {
  total: number;
  active: number;
  terminal: number;
  failures: number;
  byStatus: TaskStatusCounts;
  byRuntime: TaskRuntimeCounts;
};

/** Public task-run DTO returned by the plugin runtime task APIs. */
export type TaskRunView = {
  id: string;
  runtime: TaskRuntime;
  /** Runtime-specific source identifier, such as a plugin or gateway method. */
  sourceId?: string;
  /** Session that owns visibility and cancellation access for this task. */
  sessionKey: string;
  /** Registry owner key derived from the session and request origin. */
  ownerKey: string;
  scope: TaskScopeKind;
  /** Child session created for work that continues outside the parent turn. */
  childSessionKey?: string;
  /** Parent TaskFlow this run belongs to, when spawned from a managed flow. */
  flowId?: string;
  parentTaskId?: string;
  agentId?: string;
  runId?: string;
  label?: string;
  title: string;
  status: TaskStatus;
  deliveryStatus: TaskDeliveryStatus;
  notifyPolicy: TaskNotifyPolicy;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  /** Last observed progress or lifecycle event timestamp for stale-run checks. */
  lastEventAt?: number;
  /** Optional retention deadline after terminal cleanup is allowed. */
  cleanupAfter?: number;
  error?: string;
  progressSummary?: string;
  terminalSummary?: string;
  terminalOutcome?: TaskTerminalOutcome;
};

/** Full task-run DTO; currently equal to the list view shape. */
export type TaskRunDetail = TaskRunView;

/** Result of a task cancellation request scoped through the runtime API. */
export type TaskRunCancelResult = {
  found: boolean;
  cancelled: boolean;
  reason?: string;
  task?: TaskRunDetail;
};

/** Public TaskFlow DTO returned by list and summary APIs. */
export type TaskFlowView = {
  id: string;
  ownerKey: string;
  /** Origin that participates in owner scoping for channel-delivered work. */
  requesterOrigin?: DeliveryContext;
  status: import("../../tasks/task-flow-registry.types.js").TaskFlowStatus;
  notifyPolicy: TaskNotifyPolicy;
  goal: string;
  currentStep?: string;
  /** Set when cancellation was requested but child task cleanup is still pending. */
  cancelRequestedAt?: number;
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
};

/** Full TaskFlow DTO with controller state, wait payload, children, and counts. */
export type TaskFlowDetail = TaskFlowView & {
  state?: JsonValue;
  wait?: JsonValue;
  blocked?: {
    taskId?: string;
    summary?: string;
  };
  tasks: TaskRunView[];
  taskSummary: TaskRunAggregateSummary;
};
