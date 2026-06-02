import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  TaskDeliveryState,
  TaskDeliveryStatus,
  TaskNotifyPolicy,
  TaskRecord,
  TaskRuntime,
  TaskScopeKind,
  TaskStatus,
  TaskTerminalOutcome,
} from "./task-registry.types.js";

/** Input for creating a detached task record before work has started. */
export type DetachedTaskCreateParams = {
  runtime: TaskRuntime;
  taskKind?: string;
  sourceId?: string;
  requesterSessionKey?: string;
  ownerKey?: string;
  scopeKind?: TaskScopeKind;
  requesterOrigin?: TaskDeliveryState["requesterOrigin"];
  parentFlowId?: string;
  childSessionKey?: string;
  parentTaskId?: string;
  agentId?: string;
  runId?: string;
  label?: string;
  task: string;
  preferMetadata?: boolean;
  notifyPolicy?: TaskNotifyPolicy;
  deliveryStatus?: TaskDeliveryStatus;
};

/** Input for creating a detached task record that is already running. */
export type DetachedRunningTaskCreateParams = DetachedTaskCreateParams & {
  startedAt?: number;
  lastEventAt?: number;
  progressSummary?: string | null;
};

/** Input for transitioning a queued detached task to running. */
export type DetachedTaskStartParams = {
  runId: string;
  runtime?: TaskRuntime;
  sessionKey?: string;
  startedAt?: number;
  lastEventAt?: number;
  progressSummary?: string | null;
  eventSummary?: string | null;
};

/** Input for recording detached task progress without changing terminal state. */
export type DetachedTaskProgressParams = {
  runId: string;
  runtime?: TaskRuntime;
  sessionKey?: string;
  lastEventAt?: number;
  progressSummary?: string | null;
  eventSummary?: string | null;
};

/** Input for marking a detached task succeeded. */
export type DetachedTaskCompleteParams = {
  runId: string;
  runtime?: TaskRuntime;
  sessionKey?: string;
  endedAt: number;
  lastEventAt?: number;
  progressSummary?: string | null;
  terminalSummary?: string | null;
  terminalOutcome?: TaskTerminalOutcome | null;
};

/** Input for marking a detached task failed, timed out, or cancelled. */
export type DetachedTaskFailParams = {
  runId: string;
  runtime?: TaskRuntime;
  sessionKey?: string;
  status?: Extract<TaskStatus, "failed" | "timed_out" | "cancelled">;
  endedAt: number;
  lastEventAt?: number;
  error?: string;
  progressSummary?: string | null;
  terminalSummary?: string | null;
};

/** Generic terminal transition input for runtimes that support unified finalization. */
export type DetachedTaskFinalizeParams = {
  runId: string;
  runtime?: TaskRuntime;
  sessionKey?: string;
  status: Extract<TaskStatus, "succeeded" | "failed" | "timed_out" | "cancelled">;
  endedAt: number;
  lastEventAt?: number;
  error?: string;
  progressSummary?: string | null;
  terminalSummary?: string | null;
  terminalOutcome?: TaskTerminalOutcome | null;
};

/** Input for updating requester delivery status after notification attempts. */
export type DetachedTaskDeliveryStatusParams = {
  runId: string;
  runtime?: TaskRuntime;
  sessionKey?: string;
  deliveryStatus: TaskDeliveryStatus;
  error?: string;
};

/** Input for cancelling a detached task by registry id. */
export type DetachedTaskCancelParams = {
  cfg: OpenClawConfig;
  taskId: string;
  reason?: string;
};

/** Result returned by detached runtime cancellation hooks. */
export type DetachedTaskCancelResult = {
  found: boolean;
  cancelled: boolean;
  reason?: string;
  task?: TaskRecord;
};

/** Input for last-chance recovery before maintenance marks a stale task lost. */
export type DetachedTaskRecoveryAttemptParams = {
  taskId: string;
  runtime: TaskRuntime;
  task: TaskRecord;
  now: number;
};

/** Result of a stale-task recovery attempt. */
export type DetachedTaskRecoveryAttemptResult = {
  recovered: boolean;
};

/** Pluggable detached task lifecycle hooks used by core and task-owning plugins. */
export type DetachedTaskLifecycleRuntime = {
  createQueuedTaskRun: (params: DetachedTaskCreateParams) => TaskRecord | null;
  createRunningTaskRun: (params: DetachedRunningTaskCreateParams) => TaskRecord | null;
  startTaskRunByRunId: (params: DetachedTaskStartParams) => TaskRecord[];
  recordTaskRunProgressByRunId: (params: DetachedTaskProgressParams) => TaskRecord[];
  finalizeTaskRunByRunId?: (params: DetachedTaskFinalizeParams) => TaskRecord[];
  completeTaskRunByRunId: (params: DetachedTaskCompleteParams) => TaskRecord[];
  failTaskRunByRunId: (params: DetachedTaskFailParams) => TaskRecord[];
  setDetachedTaskDeliveryStatusByRunId: (params: DetachedTaskDeliveryStatusParams) => TaskRecord[];
  /**
   * Return `found: false` when this runtime does not own the task so core can
   * fall back to the legacy detached-task cancel path.
   */
  cancelDetachedTaskRunById: (
    params: DetachedTaskCancelParams,
  ) => Promise<DetachedTaskCancelResult>;
  /**
   * Give a registered detached runtime one last chance to recover a stale task
   * before core marks it lost during maintenance.
   */
  tryRecoverTaskBeforeMarkLost?: (
    params: DetachedTaskRecoveryAttemptParams,
  ) => DetachedTaskRecoveryAttemptResult | Promise<DetachedTaskRecoveryAttemptResult>;
};

/** Current detached task runtime registration and owning plugin id. */
export type DetachedTaskLifecycleRuntimeRegistration = {
  pluginId: string;
  runtime: DetachedTaskLifecycleRuntime;
};
