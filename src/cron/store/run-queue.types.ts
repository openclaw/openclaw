import type { CronJob } from "../types.js";
import type { CronRunReceiptHandle } from "./run-receipt.types.js";

export type CronRunRequestContext = {
  receiptId: string;
  mode: "scheduled" | "force" | "if-enabled" | "on-exit";
  onExitSchedule?: { kind: "on-exit"; command: string; cwd?: string };
};

export type CronQueuedRun = { job: CronJob; runReceipt: CronRunReceiptHandle };
export type CronSkippedRequest = {
  job?: CronJob;
  runReceipt: CronRunReceiptHandle;
  error: string;
};

export type CronRunQueueOperations = {
  "cron.requestRuns": {
    input: {
      storeKey: string;
      nowMs: number;
      defaultAgentId?: string;
      requests: Array<
        CronRunRequestContext & {
          jobId: string;
          configRevision: string;
          scheduledSlotMs?: number;
          preserveSchedule?: boolean;
          scheduleOwnershipAtMs?: number;
          requestRunId?: string;
        }
      >;
    };
    output: {
      accepted: CronQueuedRun[];
      rejected: Array<{ jobId: string; receiptId: string; reason: string }>;
    };
  };
  "cron.drainQueue": {
    input: {
      storeKey: string;
      nowMs: number;
      defaultAgentId?: string;
      maxConcurrentRuns: number;
      requests: CronRunRequestContext[];
    };
    output: { launches: CronQueuedRun[]; skipped: CronSkippedRequest[] };
  };
  "cron.cancelRequests": {
    input: {
      storeKey: string;
      receiptIds: string[];
      nowMs: number;
      reason: string;
      status?: "skipped" | "superseded";
    };
    output: { skipped: CronSkippedRequest[] };
  };
};
