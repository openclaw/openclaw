import type { CronFailureNotificationDelivery, CronJob } from "../types.js";
import type { CronJobFamilyIdentity } from "./row-codec.js";
import type {
  CronRunReceipt,
  CronRunReceiptHandle,
  CronRunReceiptStatus,
} from "./run-receipt.types.js";
import type { CronRunRecoveryProposal } from "./run-recovery-read.types.js";

export type CronScheduleMaintenanceOptions = {
  recomputeExpired?: boolean;
  nowMs?: number;
  repairFutureCronNextRunAtMs?: boolean;
  preserveExpiredPacedNextRunJobId?: string;
  skipScheduleErrorHandling?: boolean;
};

export type CronReceiptTerminal = {
  handle: CronRunReceiptHandle;
  status: Exclude<CronRunReceiptStatus, "running">;
  finishedAtMs: number;
  error?: string;
};

export type CronRuntimeMutationInputs = {
  "cron.reserveRuns": {
    storeKey: string;
    proposals: Array<{
      jobId: string;
      enabled: boolean;
      configRevision: string;
      nextRunAtMs?: number;
      lastRunAtMs?: number;
      lastRunStatus?: CronJob["state"]["lastRunStatus"];
      immediate: boolean;
    }>;
    reservedAtMs: number;
    preserveSchedule: boolean;
    scheduleOwnershipAtMs: number;
    onExit: boolean;
  };
  "cron.maintainHistory": Record<string, never>;
  "cron.activateRun": {
    storeKey: string;
    handle: CronRunReceiptHandle;
    startedAtMs: number;
    onExitSchedule?: { kind: "on-exit"; command: string; cwd?: string };
  };
  "cron.releaseReservations": {
    storeKey: string;
    jobIds: string[];
    restoreLastError: boolean;
    recompute: boolean;
    terminal?: CronReceiptTerminal;
    requireCurrentReceipt?: boolean;
  };
  "cron.finishReceipt": {
    storeKey: string;
    terminal: CronReceiptTerminal;
  };
  "cron.removeStaleFamily": {
    storeKey: string;
    family: CronJobFamilyIdentity;
  };
  "cron.repairRun": {
    storeKey: string;
    proposal: CronRunRecoveryProposal;
    mode: "startup" | "reclaim";
  };
  "cron.scheduleUnowned": {
    storeKey: string;
    options?: CronScheduleMaintenanceOptions;
  };
  "cron.recordFailureAlertOutcome": {
    storeKey: string;
    jobId: string;
    runAtMs: number | undefined;
    alertAtMs: number | undefined;
    notificationId: string | undefined;
    outcome: CronFailureNotificationDelivery;
  };
};

export type CronRuntimeMutationType = keyof CronRuntimeMutationInputs;
export type CronRuntimeWorkerOperations = {
  [Type in CronRuntimeMutationType]: {
    input: CronRuntimeMutationInputs[Type] & { nonce: string };
    output:
      | { nonce: string }
      | (Type extends "cron.reserveRuns" ? { nonce: string; conflict: CronRunReceipt } : never);
  };
};
