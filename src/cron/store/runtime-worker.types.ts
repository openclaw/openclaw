import type { CronConfig } from "../../config/types.cron.js";
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
  CronStoreFile,
} from "../types.js";
import type { CronJobMutation, CronJobMutationSnapshot } from "./job-mutations.types.js";
import type { CronJobFamilyIdentity } from "./row-codec.js";
import type { CronRunReceiptHandle } from "./run-receipt.types.js";
import type { CronRunRecoveryOutcome } from "./run-recovery.types.js";
import type { CronScheduleMaintenanceOptions } from "./scheduler-actor.types.js";
export type { CronScheduleMaintenanceOptions } from "./scheduler-actor.types.js";

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

export type CronJobMutationRefusal = { kind: "store-changed" };

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
  "cron.mutateExternalState": {
    storeKey: string;
    jobId: string;
    change: CronExternalStateChange;
  };
  "cron.writeScratch": CronJobScratchWriteInput & { createdAtMsFallback?: number };
  "cron.mutateJobs": {
    storeKey: string;
    jobMutation: CronJobMutation;
    expectedJob?: { id: string; configRevision: string };
    preconditionJob?: CronJob;
    receiptMutation?: {
      jobId: string;
      triggerStateChanged: boolean;
      scheduleChanged: boolean;
    };
    agentId?: string;
  };
  "cron.maintainHistory": Record<string, never>;

  "cron.markDeliveryStarted": {
    storeKey: string;
    handle: CronRunReceiptHandle;
  };
  "cron.finalizeRuns": {
    storeKey: string;
  };
  "cron.removeStaleFamily": {
    storeKey: string;
    family: CronJobFamilyIdentity;
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
  "cron.recordFailureRepairSettlement": {
    storeKey: string;
    jobId: string;
    repairAtMs: number;
    repairId: string;
    settledAtMs: number;
  };
};

/** Completed run facts sent to the worker; live execution owners stay on the host. */
export type CronRunFinalizationOutcome = CronJobExecutionResult & {
  jobId: string;
  job: CronJob;
  taskRunId?: string;
  completionStatus: CronCompletionStatus;
  deliveryState: CronResolvedDeliveryState;
  startedAt: number;
  endedAt: number;
  runReceipt?: CronRunReceiptHandle;
  activeJobMarker?: { jobRemoved?: true; scheduleMutated?: true; triggerMutated?: true };
  request?: {
    runId?: string;
    preserveCadence: boolean;
    scheduleOwnershipAtMs: number;
    onExitWatcherCompletion?: boolean;
  };
};

type CronScheduleOwnershipFacts = {
  jobId: string;
  active: boolean;
};

export type CronRuntimeMutationContracts = {
  "cron.recordSkippedRuns": {
    input: CronRuntimeMutationInputs["cron.recordSkippedRuns"];
    snapshot: {
      nowMs: number;
      defaultAgentId?: string;
      notificationRouting: CronNotificationRouting;
      cronConfig?: CronConfig;
      failureRepairTimeoutMs?: number;
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

  "cron.mutateExternalState": {
    input: CronRuntimeMutationInputs["cron.mutateExternalState"];
    snapshot: { nowMs: number; cronConfig?: CronConfig };
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
    snapshot: CronJobMutationSnapshot;
    outcome: {
      store: CronStoreFile;
      names: Map<string, string | undefined>;
      changed: boolean;
      notifications: CronNotificationIntent[];
      logs: CronRunRecoveryOutcome["logs"];
    };
  };
  "cron.maintainHistory": {
    input: CronRuntimeMutationInputs["cron.maintainHistory"];
    snapshot: { nowMs: number; protectedJobIds: string[] };
    outcome: { reconciled: number; pruned: number; nextSweepAtMs: number | null };
  };

  "cron.markDeliveryStarted": {
    input: CronRuntimeMutationInputs["cron.markDeliveryStarted"];
    snapshot: Record<string, never>;
    outcome: Record<string, never>;
  };
  "cron.finalizeRuns": {
    input: CronRuntimeMutationInputs["cron.finalizeRuns"];
    snapshot: {
      nowMs: number;
      defaultAgentId?: string;
      cronConfig?: CronConfig;
      failureRepairTimeoutMs?: number;
      outcomes: CronRunFinalizationOutcome[];
    };
    outcome: {
      changed: boolean;
      upsertedJobs: CronJob[];
      removedJobs: CronJob[];
      eventPlans: Array<{ outcomeIndex: number; job: CronJob }>;
      notifications: CronNotificationIntent[];
      logs: CronRunRecoveryOutcome["logs"];
    };
  };
  "cron.removeStaleFamily": {
    input: CronRuntimeMutationInputs["cron.removeStaleFamily"];
    snapshot: Record<string, never>;
    outcome: { removed: number };
  };
  "cron.scheduleUnowned": {
    input: CronRuntimeMutationInputs["cron.scheduleUnowned"];
    snapshot: { nowMs: number };
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
  "cron.recordFailureRepairSettlement": {
    input: CronRuntimeMutationInputs["cron.recordFailureRepairSettlement"];
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
      | (Type extends "cron.mutateJobs"
          ? {
              mutationRefusal: CronJobMutationRefusal;
            }
          : never);
  };
};
