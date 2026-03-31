import type { DeliveryContext } from "../utils/delivery-context.js";
import type { TaskNotifyPolicy } from "./task-registry.types.js";

export type FlowShape = "single_task" | "linear";

export type FlowStatus =
  | "queued"
  | "running"
  | "waiting"
  | "blocked"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "lost";

export type FlowRecord = {
  flowId: string;
  shape: FlowShape;
  ownerSessionKey: string;
  requesterOrigin?: DeliveryContext;
  status: FlowStatus;
  notifyPolicy: TaskNotifyPolicy;
  goal: string;
  currentStep?: string;
  blockedTaskId?: string;
  blockedSummary?: string;
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
};
