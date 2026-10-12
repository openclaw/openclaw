import type { CronJobScratchWriteInput, CronJobScratchWriteOutcome } from "../scratch-contract.js";
import type {
  CronNotificationIntent,
  CronNotificationRouting,
} from "../service/notification-intents.js";
import type {
  CronCompletionStatus,
  CronFailureNotificationDelivery,
  CronJobExecutionResult,
  CronResolvedDeliveryState,
  CronJob,
  CronRunDiagnostics,
  CronRunStatus,
  CronStoreFile,
} from "../types.js";
import type { CronJobFamilyIdentity } from "./row-codec.js";
import type {
  CronRunReceipt,
  CronRunReceiptHandle,
  CronRunReceiptStatus,
  PreparedCronRunReceiptAdjudication,
} from "./run-receipt.types.js";
import type { CronRunRecoveryProposal } from "./run-recovery-read.types.js";
import type { CronRunRecoveryOutcome, CronRunRecoveryPreparation } from "./run-recovery.types.js";
import type { CronStoreSaveOptions, PreparedCronStoreChanges } from "./save.types.js";

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

export type StartupDeferredJob = {
  jobId: string;
  delayMs?: number;
  scheduleIdentity: string | undefined;
  createdAtMs: number;
  payloadKind: CronJob["payload"]["kind"];
  scheduleActivatedAtMs: number | undefined;
  nextRunAtMs: number | undefined;
  lastRunAtMs: number | undefined;
  lastRunStatus: CronRunStatus | undefined;
};

type CronSkippedRunChange =
  | {
      kind: "ownerless";
      proposals: Array<{
        jobId: string;
        enabled: boolean;
        configRevision: string;
        nextRunAtMs?: number;
        lastRunAtMs?: number;
        lastRunStatus?: CronJob["state"]["lastRunStatus"];
      }>;
      scheduleMode?: "advance" | "preserve";
      scheduleOwnershipAtMs?: number;
    }
  | {
      kind: "invalid-manual";
      jobId: string;
      configRevision: string;
      error: string;
      diagnostics?: CronRunDiagnostics;
      scheduleMode: "advance" | "preserve";
    };

export type CronReceiptRevisionRefusal = {
  receiptId: string;
  message: string;
  reason: "revision-changed" | "owner-unavailable";
};

export type CronJobMutationRefusal =
  | { kind: "store-changed" }
  | { kind: "receipt-conflict"; receipt: CronRunReceipt };

type CronExternalStreamSource = { scheduleKey: string; identity: string };

export type CronExternalStateChange =
  | {
      kind: "state";
      source: CronExternalStreamSource;
      statePatch: Partial<CronJob["state"]>;
    }
  | { kind: "retire"; source: CronExternalStreamSource; nextIdentity: string }
  | {
      kind: "counters";
      counters: Pick<CronJob["state"], "streamDroppedBatches" | "streamCoalescedBatches">;
    }
  | {
      kind: "failure";
      error: string;
      statePatch: Partial<CronJob["state"]>;
      source?: CronExternalStreamSource;
    };

export type CronRuntimeMutationInputs = {
  "cron.recordSkippedRuns": { storeKey: string; change: CronSkippedRunChange };
  "cron.planStartup": { storeKey: string; jobIds: string[]; skipJobIds?: string[] };
  "cron.mutateExternalState": {
    storeKey: string;
    jobId: string;
    change: CronExternalStateChange;
  };
  "cron.writeScratch": CronJobScratchWriteInput & { createdAtMsFallback?: number };
  "cron.mutateJobs": {
    storeKey: string;
    changes: PreparedCronStoreChanges;
    replacement?: {
      store: CronStoreFile;
      jobsFingerprint: string;
      runtimeFingerprint: string;
      options?: CronStoreSaveOptions;
    };
    expectedJob?: { id: string; configRevision: string };
    preconditionJob?: CronJob;
    receiptMutation?: {
      jobId: string;
      triggerStateChanged: boolean;
      scheduleChanged: boolean;
      owner?: PreparedCronRunReceiptAdjudication;
    };
    agentId?: string;
  };
  "cron.maintainHistory": Record<string, never>;
  "cron.deferStartupJobs": {
    storeKey: string;
    deferredJobs: StartupDeferredJob[];
    staggerMs: number;
  };
  "cron.markDeliveryStarted": {
    storeKey: string;
    handle: CronRunReceiptHandle;
  };
  "cron.finishReceipt": {
    storeKey: string;
    terminal: CronReceiptTerminal;
  };
  "cron.finalizeRuns": {
    storeKey: string;
    jobIds: string[];
    receipts: Array<{
      terminal: CronReceiptTerminal;
      allowMissingJob: boolean;
      allowUnavailable: boolean;
    }>;
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

/** Completed run facts sent to the worker; live execution owners stay on the host. */
export type CronRunFinalizationOutcome = CronJobExecutionResult & {
  jobId: string;
  job: CronJob;
  completionStatus: CronCompletionStatus;
  deliveryState: CronResolvedDeliveryState;
  startedAt: number;
  endedAt: number;
  runReceipt?: CronRunReceiptHandle;
  activeJobMarker?: { jobRemoved?: true; scheduleMutated?: true; triggerMutated?: true };
  request?: { preserveCadence: boolean; scheduleOwnershipAtMs: number };
};

type CronScheduleOwnershipFacts = {
  jobId: string;
  active: boolean;
  reservation?: { markerAtMs: number; preserveWhenDisabled: boolean };
};

export type CronRuntimeMutationContracts = {
  "cron.recordSkippedRuns": {
    input: CronRuntimeMutationInputs["cron.recordSkippedRuns"];
    snapshot: {
      nowMs: number;
      defaultAgentId?: string;
      notificationRouting: CronNotificationRouting;
      cronConfig?: CronRunRecoveryPreparation["cronConfig"];
      ownership: CronScheduleOwnershipFacts[];
    };
    outcome: {
      jobs: CronJob[];
      rejected: CronJob[];
      nowMs: number;
      notifications: CronNotificationIntent[];
      logs: CronRunRecoveryOutcome["logs"];
    };
  };
  "cron.planStartup": {
    input: CronRuntimeMutationInputs["cron.planStartup"];
    snapshot: {
      nowMs: number;
      skipMissedJobs: boolean;
      notificationRouting: CronNotificationRouting;
      ownership: CronScheduleOwnershipFacts[];
    };
    outcome: {
      jobs: CronJob[];
      missed: CronJob[];
      skippedJobIds: string[];
      notifications: CronNotificationIntent[];
      logs: CronRunRecoveryOutcome["logs"];
    };
  };
  "cron.mutateExternalState": {
    input: CronRuntimeMutationInputs["cron.mutateExternalState"];
    snapshot: Pick<CronRunRecoveryPreparation, "nowMs" | "cronConfig">;
    outcome: {
      job?: CronJob;
      nowMs: number;
      notifications: CronNotificationIntent[];
      logs: CronRunRecoveryOutcome["logs"];
    };
  };
  "cron.writeScratch": {
    input: CronRuntimeMutationInputs["cron.writeScratch"];
    snapshot: { expectedConfigRevision?: string };
    outcome: CronJobScratchWriteOutcome;
  };
  "cron.mutateJobs": {
    input: CronRuntimeMutationInputs["cron.mutateJobs"];
    snapshot: { nowMs: number };
    outcome: {
      store: CronStoreFile;
      names: Map<string, string | undefined>;
      jobsFingerprint: string;
      runtimeFingerprint: string;
    };
  };
  "cron.maintainHistory": {
    input: CronRuntimeMutationInputs["cron.maintainHistory"];
    snapshot: { nowMs: number; protectedJobIds: string[]; locallyOwnedReceiptIds: string[] };
    outcome: { reconciled: number; pruned: number };
  };
  "cron.deferStartupJobs": {
    input: CronRuntimeMutationInputs["cron.deferStartupJobs"];
    snapshot: { nowMs: number; notificationRouting: CronNotificationRouting };
    outcome: {
      jobs: CronJob[];
      notifications: CronNotificationIntent[];
      logs: CronRunRecoveryOutcome["logs"];
    };
  };
  "cron.markDeliveryStarted": {
    input: CronRuntimeMutationInputs["cron.markDeliveryStarted"];
    snapshot: { allowMissingJob: boolean; defaultAgentId?: string };
    outcome: Record<string, never>;
  };
  "cron.finishReceipt": {
    input: CronRuntimeMutationInputs["cron.finishReceipt"];
    snapshot: Record<string, never>;
    outcome: Record<string, never>;
  };
  "cron.finalizeRuns": {
    input: CronRuntimeMutationInputs["cron.finalizeRuns"];
    snapshot: {
      nowMs: number;
      defaultAgentId?: string;
      cronConfig?: CronRunRecoveryPreparation["cronConfig"];
      outcomes: CronRunFinalizationOutcome[];
      deferredReceiptIds: string[];
    };
    outcome: {
      changed: boolean;
      upsertedJobs: CronJob[];
      removedJobs: CronJob[];
      eventPlans: Array<{ outcomeIndex: number; job?: CronJob }>;
      notifications: CronNotificationIntent[];
      logs: CronRunRecoveryOutcome["logs"];
    };
  };
  "cron.removeStaleFamily": {
    input: CronRuntimeMutationInputs["cron.removeStaleFamily"];
    snapshot: Record<string, never>;
    outcome: { removed: number };
  };
  "cron.repairRun": {
    input: CronRuntimeMutationInputs["cron.repairRun"];
    snapshot: Pick<CronRunRecoveryPreparation, "nowMs" | "cronConfig" | "proposedReceiptIsStale">;
    outcome: CronRunRecoveryOutcome;
  };
  "cron.scheduleUnowned": {
    input: CronRuntimeMutationInputs["cron.scheduleUnowned"];
    snapshot: { nowMs: number; ownership: CronScheduleOwnershipFacts[] };
    outcome: {
      changed: boolean;
      jobs: CronJob[];
      notifications: CronNotificationIntent[];
      logs: CronRunRecoveryOutcome["logs"];
    };
  };
  "cron.recordFailureAlertOutcome": {
    input: CronRuntimeMutationInputs["cron.recordFailureAlertOutcome"];
    snapshot: Record<string, never>;
    outcome: { job?: CronJob };
  };
};

export type CronRuntimeMutationType = keyof CronRuntimeMutationInputs;
export type CronRuntimeWorkerOperations = {
  [Type in CronRuntimeMutationType]: {
    input: CronRuntimeMutationInputs[Type] & {
      snapshot: CronRuntimeMutationContracts[Type]["snapshot"];
    };
    output:
      | { outcome: CronRuntimeMutationContracts[Type]["outcome"] }
      | (Type extends "cron.finalizeRuns" ? { receiptRevision: CronReceiptRevisionRefusal } : never)
      | (Type extends "cron.mutateJobs"
          ? {
              mutationRefusal: CronJobMutationRefusal;
            }
          : never);
  };
};
