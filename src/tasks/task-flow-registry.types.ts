import type { DeliveryContext } from "../utils/delivery-context.types.js";
import type { TaskNotifyPolicy } from "./task-registry.types.js";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type TaskFlowSyncMode = "task_mirrored" | "managed";

export type TaskFlowStatus =
  | "queued"
  | "running"
  | "waiting"
  | "blocked"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "lost";

export type TaskFlowRecord = {
  flowId: string;
  syncMode: TaskFlowSyncMode;
  ownerKey: string;
  /**
   * Originating continuation chain id.
   *
   * Set-once at create-time; subsequent hops within the same chain do NOT
   * update this column (UPDATE-on-hop deferred-by-design). Audit walks key
   * off this field as the chain-of-origin correlation id.
   */
  chainId?: string;
  requesterOrigin?: DeliveryContext;
  controllerId?: string;
  revision: number;
  status: TaskFlowStatus;
  notifyPolicy: TaskNotifyPolicy;
  goal: string;
  currentStep?: string;
  blockedTaskId?: string;
  blockedSummary?: string;
  stateJson?: JsonValue;
  waitJson?: JsonValue;
  cancelRequestedAt?: number;
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
};
