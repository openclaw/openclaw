import type { AgentDeletionRecoveryHoldPredicate } from "../../state/agent-deletion-journal.types.js";
import type { CronJobScratchWriteInput } from "../scratch-contract.js";
import type {
  CronFailureNotificationDelivery,
  CronJob,
  CronRunDiagnostics,
  CronRunStatus,
  CronStoreFile,
  CronStoredJob,
} from "../types.js";
import type { CronJobFamilyIdentity } from "./row-codec.js";
import type {
  CronRunReceipt,
  CronRunReceiptHandle,
  CronRunReceiptStatus,
  PreparedCronRunReceiptAdjudication,
} from "./run-receipt.types.js";
import type { CronRunRecoveryProposal } from "./run-recovery-read.types.js";
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

export type CronReservationReleasePolicy =
  | {
      kind: "general";
      restoreLastError: boolean;
      recompute: boolean;
      terminal?: CronReceiptTerminal;
      requireCurrentReceipt?: boolean;
    }
  | { kind: "manual-abandon" }
  | { kind: "scheduled-ineligible" }
  | { kind: "startup-settlement"; deferredJobs: StartupDeferredJob[]; staggerMs: number };

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
  "cron.provisionDefaultProactive": {
    storePath: string | undefined;
    agentId: string;
    planned: CronStoredJob;
    recoveryHoldPredicate?: AgentDeletionRecoveryHoldPredicate;
  };
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
    policy: CronReservationReleasePolicy;
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

export type CronRuntimeMutationType = keyof CronRuntimeMutationInputs;
export type CronRuntimeWorkerOperations = {
  [Type in CronRuntimeMutationType]: {
    input: CronRuntimeMutationInputs[Type] & { nonce: string };
    output:
      | { nonce: string }
      | (Type extends "cron.reserveRuns" ? { nonce: string; conflict: CronRunReceipt } : never)
      | (Type extends "cron.finalizeRuns"
          ? { nonce: string; receiptRevision: CronReceiptRevisionRefusal }
          : never)
      | (Type extends "cron.mutateJobs"
          ? {
              nonce: string;
              mutationRefusal: CronJobMutationRefusal;
            }
          : never);
  };
};
