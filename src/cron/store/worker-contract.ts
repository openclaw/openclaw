import type { CronStoreWorkerOperations } from "./load-worker.types.js";
import type { CronQuarantineRegistration } from "./quarantine.kernel.js";
import type { CronRunHistoryWorkerOperations } from "./run-history.types.js";
import type { CronRunQueueOperations } from "./run-queue.types.js";
import type { CronRunRecoveryInput, CronRunRecoveryOutcome } from "./run-recovery.types.js";
import type { CronRuntimeWorkerOperations } from "./runtime-worker.types.js";
import type { CronStoreSaveWorkerOperations } from "./save-worker.types.js";
import type { CronSchedulerOperations } from "./scheduler-actor.types.js";

export type CronStateWorkerOperations = CronRunHistoryWorkerOperations &
  CronStoreWorkerOperations &
  CronRuntimeWorkerOperations &
  CronRunQueueOperations &
  CronSchedulerOperations &
  CronStoreSaveWorkerOperations & {
    "cron.bindReceiptExecution": {
      input: { receiptId: string; binding: { contextId: string; executionId: string } };
      output: boolean;
    };
    "cron.registerQuarantine": {
      input: CronQuarantineRegistration;
      output: void;
    };
    "cron.initializeRunReceipts": {
      input: Record<string, never>;
      output: void;
    };
    "cron.recoverRuns": {
      input: CronRunRecoveryInput;
      output: CronRunRecoveryOutcome;
    };
  };
