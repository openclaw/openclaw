import type { CronJobScratchWriteOutcome } from "../scratch-contract.js";
import type {
  CronNotificationRouting,
  PreparedCronFailureAlertPolicy,
} from "../service/notification-intents.js";
import type { DeferredCronNotifications } from "../service/state.js";
import type { CronFinalizationOutcome } from "../service/timer-execution-timeout.js";
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
    preparation: {
      nowMs: number;
      defaultAgentId?: string;
      notificationRouting: CronNotificationRouting;
      cronConfig?: CronRunRecoveryPreparation["cronConfig"];
      ownership: CronScheduleOwnershipFacts[];
      failureAlerts: PreparedCronFailureAlertPolicy[];
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
    preparation: Pick<CronRunRecoveryPreparation, "nowMs" | "cronConfig"> & {
      failureAlerts: PreparedCronFailureAlertPolicy[];
    };
    outcome: {
      job?: CronJob;
      nowMs: number;
      notifications: DeferredCronNotifications;
      logs: CronRunRecoveryOutcome["logs"];
    };
  };
  "cron.writeScratch": {
    input: CronRuntimeMutationInputs["cron.writeScratch"];
    preparation: { expectedConfigRevision?: string };
    outcome: CronJobScratchWriteOutcome | { jobChanged: true };
  };
  "cron.mutateJobs": {
    input: CronRuntimeMutationInputs["cron.mutateJobs"];
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
    preparation: {
      defaultAgentId?: string;
      claims: PreparedCronRunReceiptClaim[];
      replacements: CronRunReceiptHandle[];
      localReceiptIds: string[];
    };
    outcome: {
      reservations: Array<{ job: CronJob; runReceipt: CronRunReceiptHandle }>;
      replacedReceipts: CronRunReceiptHandle[];
      liveness: Array<{ receipt: CronRunReceiptHandle; stale: boolean }>;
    };
  };
  "cron.maintainHistory": {
    input: CronRuntimeMutationInputs["cron.maintainHistory"];
    preparation: { nowMs: number; activeJobIds: string[]; localReceiptIds: string[] };
    outcome: {
      reconciled: number;
      pruned: number;
      liveness: Array<{ receipt: CronRunReceiptHandle; stale: boolean }>;
    };
  };
  "cron.activateRun": {
    input: CronRuntimeMutationInputs["cron.activateRun"];
    preparation: { markerAtMs: number; defaultAgentId?: string };
    outcome: {
      activation?: { job: CronJob; receipt: CronRunReceiptHandle; previousLastError?: string };
    };
  };
  "cron.releaseReservations": {
    input: CronRuntimeMutationInputs["cron.releaseReservations"];
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
    preparation: { allowMissingJob: boolean; defaultAgentId?: string };
    outcome: Record<string, never>;
  };
  "cron.finishReceipt": {
    input: CronRuntimeMutationInputs["cron.finishReceipt"];
    preparation: Record<string, never>;
    outcome: Record<string, never>;
  };
  "cron.finalizeRuns": {
    input: CronRuntimeMutationInputs["cron.finalizeRuns"];
    preparation: {
      defaultAgentId?: string;
      outcomes: CronFinalizationOutcome[];
      failureAlerts: PreparedCronFailureAlertPolicy[];
      cronConfig?: CronRunRecoveryPreparation["cronConfig"];
      nowMs: number;
      deferredReceiptIds: string[];
    };
    outcome: {
      changed: boolean;
      upsertedJobs: CronJob[];
      removedJobs: CronJob[];
      eventJobs: Array<CronJob | undefined>;
      notifications: DeferredCronNotifications;
      logs: CronRunRecoveryOutcome["logs"];
    };
  };
  "cron.removeStaleFamily": {
    input: CronRuntimeMutationInputs["cron.removeStaleFamily"];
    preparation: Record<string, never>;
    outcome: { removed: number };
  };
  "cron.repairRun": {
    input: CronRuntimeMutationInputs["cron.repairRun"];
    preparation: Omit<CronRunRecoveryPreparation, "failureAlert"> & {
      failureAlerts: PreparedCronFailureAlertPolicy[];
    };
    outcome: CronRunRecoveryOutcome;
  };
  "cron.scheduleUnowned": {
    input: CronRuntimeMutationInputs["cron.scheduleUnowned"];
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
    preparation: Record<string, never>;
    outcome: { job?: CronJob };
  };
};
