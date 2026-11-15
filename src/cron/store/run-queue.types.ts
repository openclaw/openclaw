import type { CronEventAdmission } from "../event-source.js";
import type { PluginCommandScheduleHost } from "../plugin-command-schedule.types.js";
import type { CronJob, CronStoredJob } from "../types.js";
import type { CronRunReceiptHandle } from "./run-receipt.types.js";

export type CronRunRequestContext = {
  receiptId: string;
  mode: "scheduled" | "force" | "if-enabled" | "on-exit";
  onExitSchedule?: { kind: "on-exit"; command: string; cwd?: string };
  event?: CronEventAdmission;
  /** Set when a manual or stream run still evaluates the job's condition before its payload. */
  evaluateTrigger?: boolean;
};

export type CronQueuedRun = {
  job: CronStoredJob;
  runReceipt: CronRunReceiptHandle;
  migrationPending?: boolean;
};
export type CronSkippedRequest = {
  job?: CronJob;
  runReceipt: CronRunReceiptHandle;
  error: string;
  eventInvalidated?: true;
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
      schedulingPaused?: boolean;
      preparingAgentIds?: string[];
      /** Jobs continuing a conversation that is busy now; their timed occurrences stay queued. */
      busyConversationJobIds?: string[];
      /**
       * The draining Gateway process. Private command schedules from another process, or a
       * drain without this identity, retire before spending an attempt.
       */
      hostProcessId?: string;
      /**
       * Plugin instances loaded in the draining process that can serve command schedules. A
       * restartable schedule from an earlier process re-arms onto a matching one in the claim.
       */
      pluginCommandHosts?: PluginCommandScheduleHost[];
    };
    output: {
      launches: CronQueuedRun[];
      preparing: CronQueuedRun[];
      skipped: CronSkippedRequest[];
    };
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
  /**
   * A fired condition stops counting as a check. A timed check then waits, holding neither a
   * check nor a run slot, until the queue drain hands it a slot in due order; `runSlot` is false
   * until then, and the host asks again each time the queue moves.
   */
  "cron.settleConditionCheck": {
    input: { storeKey: string; jobId: string; receiptId: string };
    /** `stale`: the receipt no longer owns the job's running marker. */
    output: { job?: CronStoredJob; runSlot: boolean; stale?: true };
  };
};
