import type { DeliveryContext } from "../utils/delivery-context.types.js";
import type { JsonValue } from "./task-flow-registry.types.js";

export type DurableJobStatus =
  | "planned"
  | "scheduled"
  | "running"
  | "waiting"
  | "blocked"
  | "completed"
  | "cancelled"
  | "superseded";

export type DurableJobJsonObject = {
  [key: string]: JsonValue | undefined;
};

export type DurableJobStopCondition = DurableJobJsonObject & {
  kind: string;
  details?: string;
};

export type DurableJobNotifyPolicy = DurableJobJsonObject & {
  kind: string;
};

export type DurableJobSource = DurableJobJsonObject & {
  kind: string;
  messageText?: string;
};

export type DurableJobTransitionDisposition = DurableJobJsonObject & {
  kind: string;
};

export type DurableJobBacking = {
  taskFlowId?: string;
  cronJobIds?: string[];
  childTaskIds?: string[];
  childSessionKeys?: string[];
};

export type DurableJobAudit = {
  createdAt: number;
  updatedAt: number;
  createdBy?: string;
  revision: number;
};

export type DurableJobRecord = {
  jobId: string;
  title: string;
  goal: string;
  ownerSessionKey: string;
  requesterOrigin?: DeliveryContext;
  source?: DurableJobSource;
  status: DurableJobStatus;
  stopCondition: DurableJobStopCondition;
  notifyPolicy: DurableJobNotifyPolicy;
  currentStep?: string;
  summary?: string;
  nextWakeAt?: number;
  lastUserUpdateAt?: number;
  backing: DurableJobBacking;
  audit: DurableJobAudit;
};

export type DurableJobTransitionRecord = {
  transitionId: string;
  jobId: string;
  from?: DurableJobStatus;
  to: DurableJobStatus;
  reason?: string;
  at: number;
  actor?: string;
  disposition?: DurableJobTransitionDisposition;
  revision?: number;
};

export type DurableJobCreateInput = {
  jobId?: string;
  title: string;
  goal: string;
  ownerSessionKey: string;
  requesterOrigin?: DeliveryContext;
  source?: DurableJobSource;
  status?: DurableJobStatus;
  stopCondition: DurableJobStopCondition;
  notifyPolicy: DurableJobNotifyPolicy;
  currentStep?: string | null;
  summary?: string | null;
  nextWakeAt?: number | null;
  lastUserUpdateAt?: number | null;
  backing?: DurableJobBacking;
  createdAt?: number;
  updatedAt?: number;
  createdBy?: string;
  revision?: number;
};

export type DurableJobUpdateInput = Partial<
  Pick<
    DurableJobRecord,
    | "title"
    | "goal"
    | "status"
    | "stopCondition"
    | "notifyPolicy"
    | "requesterOrigin"
    | "source"
  >
> & {
  currentStep?: string | null;
  summary?: string | null;
  nextWakeAt?: number | null;
  lastUserUpdateAt?: number | null;
  backing?: DurableJobBacking;
};

export type DurableJobTransitionInput = {
  transitionId?: string;
  jobId: string;
  from?: DurableJobStatus;
  to: DurableJobStatus;
  reason?: string | null;
  at?: number;
  actor?: string | null;
  disposition?: DurableJobTransitionDisposition;
  revision?: number;
};
