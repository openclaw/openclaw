import type { DeliveryContext } from "../utils/delivery-context.js";

export type TaskRuntime = "subagent" | "acp" | "cli";

export type TaskStatus =
  | "accepted"
  | "running"
  | "done"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "lost";

export type TaskDeliveryStatus =
  | "pending"
  | "delivered"
  | "session_queued"
  | "failed"
  | "parent_missing"
  | "not_applicable";

export type TaskNotifyPolicy = "done_only" | "state_changes" | "silent";

export type TaskBindingTargetKind = "subagent" | "session";

export type TaskSource = "sessions_spawn" | "background_cli" | "unknown";

export type TaskEventKind = TaskStatus | "progress";

export type TaskEventRecord = {
  at: number;
  kind: TaskEventKind;
  summary?: string;
};

export type TaskRecord = {
  taskId: string;
  source: TaskSource;
  runtime: TaskRuntime;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  childSessionKey?: string;
  runId?: string;
  bindingTargetKind?: TaskBindingTargetKind;
  label?: string;
  task: string;
  status: TaskStatus;
  deliveryStatus: TaskDeliveryStatus;
  notifyPolicy: TaskNotifyPolicy;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  lastEventAt?: number;
  error?: string;
  progressSummary?: string;
  terminalSummary?: string;
  recentEvents?: TaskEventRecord[];
  lastNotifiedEventAt?: number;
  transcriptPath?: string;
  streamLogPath?: string;
  backend?: string;
  agentSessionId?: string;
  backendSessionId?: string;
};

export type TaskRegistrySnapshot = {
  tasks: TaskRecord[];
};
