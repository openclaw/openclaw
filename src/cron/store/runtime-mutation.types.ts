import type { CronJobScratchWriteOutcome } from "../scratch-contract.js";
import type {
  CronNotificationRouting,
  ResolvedFailureAlert,
} from "../service/notification-intents.js";
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
  "cron.recordSkippedRuns": {
    input: CronRuntimeMutationInputs["cron.recordSkippedRuns"];
    facts: { jobs: Array<Pick<CronJob, "id" | "delivery" | "failureAlert">> };
    preparation: {
      nowMs: number;
      defaultAgentId?: string;
      notificationRouting: CronNotificationRouting;
      cronConfig?: CronRunRecoveryPreparation["cronConfig"];
      ownership: CronScheduleOwnershipFacts[];
      failureAlerts: Array<{ jobId: string; value: ResolvedFailureAlert | null }>;
    };
    outcome: {
      jobs: CronJob[];
      rejected: CronJob[];
      nowMs: number;
      notifications: DeferredCronNotifications;
      logs: CronRunRecoveryOutcome["logs"];
    };
  };
  "cron.planStartup": {
    input: CronRuntimeMutationInputs["cron.planStartup"];
    facts: { jobIds: string[]; notificationNeedsDefault: boolean };
    preparation: {
      nowMs: number;
      skipMissedJobs: boolean;
      notificationRouting: CronNotificationRouting;
      ownership: CronScheduleOwnershipFacts[];
    };
    outcome: {
      jobs: CronJob[];
      missed: CronJob[];
      skippedJobIds: string[];
      notifications: DeferredCronNotifications;
      logs: CronRunRecoveryOutcome["logs"];
    };
  };
  "cron.mutateExternalState": {
    input: CronRuntimeMutationInputs["cron.mutateExternalState"];
    facts: Pick<CronJob, "id" | "delivery" | "failureAlert">;
    preparation: Pick<CronRunRecoveryPreparation, "nowMs" | "cronConfig" | "failureAlert">;
    outcome: {
      job?: CronJob;
      nowMs: number;
      notifications: DeferredCronNotifications;
      logs: CronRunRecoveryOutcome["logs"];
    };
  };
  "cron.writeScratch": {
    input: CronRuntimeMutationInputs["cron.writeScratch"];
    facts: { configRevision?: string };
    preparation: Record<string, never>;
    outcome: CronJobScratchWriteOutcome;
  };
  "cron.mutateJobs": {
    input: CronRuntimeMutationInputs["cron.mutateJobs"];
    facts: { deletionBlocked: boolean };
    preparation: { nowMs: number };
    outcome: {
      store: CronStoreFile;
      names: Map<string, string | undefined>;
      jobsFingerprint: string;
      runtimeFingerprint: string;
    };
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
    facts: { deletionBlocked: boolean; notificationNeedsDefault: boolean };
    preparation: {
      nowMs: number;
      defaultAgentId?: string;
      notificationRouting: CronNotificationRouting;
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
  "cron.markDeliveryStarted": {
    input: CronRuntimeMutationInputs["cron.markDeliveryStarted"];
    facts: { deletionBlocked: boolean };
    preparation: { allowMissingJob: boolean; defaultAgentId?: string };
    outcome: { job?: CronJob };
  };
  "cron.releaseDeliveryAdmission": {
    input: CronRuntimeMutationInputs["cron.releaseDeliveryAdmission"];
    facts: Record<string, never>;
    preparation: Record<string, never>;
    outcome: { job?: CronJob };
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
