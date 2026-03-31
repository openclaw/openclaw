import type { DeliveryContext } from "../utils/delivery-context.js";
import type { TaskNotifyPolicy } from "./task-registry.types.js";

export type FlowShape = "single_task" | "linear";

export type FlowOutputValue =
  | null
  | boolean
  | number
  | string
  | FlowOutputValue[]
  | { [key: string]: FlowOutputValue };

export type FlowOutputBag = Record<string, FlowOutputValue>;

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
  waitingOnTaskId?: string;
  outputs?: FlowOutputBag;
  blockedTaskId?: string;
  blockedSummary?: string;
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
};
