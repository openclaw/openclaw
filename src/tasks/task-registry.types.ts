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
  | "failed"
  | "parent_missing"
  | "not_applicable";

export type TaskBindingTargetKind = "subagent" | "session";

export type TaskSource = "sessions_spawn" | "background_cli" | "unknown";

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
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  lastEventAt?: number;
  error?: string;
  resultPreview?: string;
  transcriptPath?: string;
  streamLogPath?: string;
  backend?: string;
  agentSessionId?: string;
  backendSessionId?: string;
};

export type TaskRegistrySnapshot = {
  tasks: TaskRecord[];
};
