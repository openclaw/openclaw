import type { CronAgentScope } from "../types-shared.js";

export type CronRunReceiptStatus =
  | "running"
  | "ok"
  | "error"
  | "skipped"
  | "interrupted"
  | "superseded";

export type CronRunReceipt = {
  receiptId: string;
  storeKey: string;
  jobId: string;
  configRevision: string;
  agentId: string;
  requestRunId?: string;
  status: CronRunReceiptStatus;
  ownerPid: number;
  ownerStartTime: number | null;
  startedAtMs: number;
  finishedAtMs: number | null;
  error?: string;
};

export type CronRunReceiptHandle = Pick<
  CronRunReceipt,
  | "agentId"
  | "configRevision"
  | "jobId"
  | "ownerPid"
  | "ownerStartTime"
  | "receiptId"
  | "startedAtMs"
  | "storeKey"
>;
export type CronRunReceiptRecoveryCandidate = CronRunReceiptHandle;

export type CronRunReceiptCurrentReadCommand = {
  type: "cron.currentReceipt";
  handle: Pick<
    CronRunReceiptHandle,
    "receiptId" | "storeKey" | "jobId" | "agentId" | "ownerPid" | "ownerStartTime"
  >;
  includeJob: boolean;
  includeAvailability: boolean;
};

export type CronRunReceiptCurrentFacts = {
  receipt: CronRunReceiptHandle | undefined;
  job: CronAgentScope | undefined;
  deletionBlocked: boolean;
};

export type CronRunReceiptOwnerObservation = Pick<
  CronRunReceipt,
  "receiptId" | "ownerPid" | "ownerStartTime" | "startedAtMs"
>;

export type PreparedCronRunReceiptAdjudication = {
  storeKey: string;
  observed?: CronRunReceiptOwnerObservation;
  observedStale: boolean;
};

export type PreparedCronRunReceiptClaim = PreparedCronRunReceiptAdjudication & {
  handle: CronRunReceiptHandle;
  requestRunId?: string;
};
