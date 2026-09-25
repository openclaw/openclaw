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

export type CronRunReceiptOwnerObservation = Pick<
  CronRunReceipt,
  "receiptId" | "ownerPid" | "ownerStartTime" | "startedAtMs"
>;
