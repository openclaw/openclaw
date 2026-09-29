import type { DeferredCronNotifications } from "../service/state.js";
import type { CronJob, CronStoreFile } from "../types.js";
import type { CronRunReceiptHandle, PreparedCronRunReceiptClaim } from "./run-receipt.types.js";
import type { CronRunRecoveryOutcome, CronRunRecoveryPreparation } from "./run-recovery.types.js";
import type { CronRuntimeMutationInputs } from "./runtime-worker.types.js";

type CronScheduleOwnershipFacts = {
  jobId: string;
  active: boolean;
  reservation?: { markerAtMs: number; preserveWhenDisabled: boolean };
};

export type CronRuntimeMutationContracts = {
  "cron.mutateJobs": {
    input: CronRuntimeMutationInputs["cron.mutateJobs"];
    facts: { deletionBlocked: boolean };
    preparation: { nowMs: number };
    outcome: { store: CronStoreFile; jobsFingerprint: string; runtimeFingerprint: string };
  };
  "cron.reserveRuns": {
    input: CronRuntimeMutationInputs["cron.reserveRuns"];
    facts: { receipts: CronRunReceiptHandle[] };
    preparation: {
      defaultAgentId?: string;
      claims: PreparedCronRunReceiptClaim[];
      replacements: CronRunReceiptHandle[];
    };
    outcome: {
      reservations: Array<{ job: CronJob; runReceipt: CronRunReceiptHandle }>;
      replacedReceipts: CronRunReceiptHandle[];
    };
  };
  "cron.maintainHistory": {
    input: CronRuntimeMutationInputs["cron.maintainHistory"];
    facts: { jobIds: string[]; receipts: CronRunReceiptHandle[] };
    preparation: { nowMs: number; protectedJobIds: string[] };
    outcome: { reconciled: number; pruned: number };
  };
  "cron.activateRun": {
    input: CronRuntimeMutationInputs["cron.activateRun"];
    facts: Record<string, never>;
    preparation: { markerAtMs: number; defaultAgentId?: string };
    outcome: {
      activation?: { job: CronJob; receipt: CronRunReceiptHandle; previousLastError?: string };
    };
  };
  "cron.releaseReservations": {
    input: CronRuntimeMutationInputs["cron.releaseReservations"];
    facts: { deletionBlocked: boolean };
    preparation: {
      nowMs: number;
      defaultAgentId?: string;
      reservations: Array<{
        jobId: string;
        markerAtMs: number;
        runReceipt: CronRunReceiptHandle;
        activationPreviousLastError?: { value: string | undefined };
      }>;
      deferTerminal: boolean;
    };
    outcome: {
      jobs: CronJob[];
      notifications: DeferredCronNotifications;
      logs: CronRunRecoveryOutcome["logs"];
    };
  };
  "cron.finishReceipt": {
    input: CronRuntimeMutationInputs["cron.finishReceipt"];
    facts: Record<string, never>;
    preparation: Record<string, never>;
    outcome: Record<string, never>;
  };
  "cron.finalizeRuns": {
    input: CronRuntimeMutationInputs["cron.finalizeRuns"];
    facts: {
      jobs: CronJob[];
      receipts: Array<{
        receiptId: string;
        deletionBlocked: boolean;
        triggerStateRetired: boolean;
      }>;
    };
    preparation: {
      defaultAgentId?: string;
      jobs: CronJob[];
      deletedJobIds: string[];
      deferredReceiptIds: string[];
    };
    outcome: { changed: boolean };
  };
  "cron.removeStaleFamily": {
    input: CronRuntimeMutationInputs["cron.removeStaleFamily"];
    facts: Record<string, never>;
    preparation: Record<string, never>;
    outcome: { removed: number };
  };
  "cron.repairRun": {
    input: CronRuntimeMutationInputs["cron.repairRun"];
    facts: Pick<CronJob, "id" | "delivery" | "failureAlert">;
    preparation: CronRunRecoveryPreparation;
    outcome: CronRunRecoveryOutcome;
  };
  "cron.scheduleUnowned": {
    input: CronRuntimeMutationInputs["cron.scheduleUnowned"];
    facts: { jobIds: string[] };
    preparation: { nowMs: number; ownership: CronScheduleOwnershipFacts[] };
    outcome: {
      changed: boolean;
      jobs: CronJob[];
      notifications: DeferredCronNotifications;
      logs: CronRunRecoveryOutcome["logs"];
    };
  };
  "cron.recordFailureAlertOutcome": {
    input: CronRuntimeMutationInputs["cron.recordFailureAlertOutcome"];
    facts: { ownsCycle: boolean };
    preparation: Record<string, never>;
    outcome: { job?: CronJob };
  };
};
