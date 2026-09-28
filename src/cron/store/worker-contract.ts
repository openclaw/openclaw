import type {
  ExecutionOwnerBinding,
  ExecutionOwnerBindingResult,
} from "../../audit/execution-owner-binding.js";
import type { CronStoreWorkerOperations } from "./load-worker.types.js";
import type { CronRunReceiptHandle } from "./run-receipt.types.js";
import type { CronRuntimeWorkerOperations } from "./runtime-worker.types.js";
import type { CronStoreSaveWorkerOperations } from "./save-worker.types.js";

export type CronStateWorkerOperations = CronStoreWorkerOperations &
  CronRuntimeWorkerOperations &
  CronStoreSaveWorkerOperations & {
    "cron.initializeRunReceipts": {
      input: Record<string, never>;
      output: void;
    };
    "cron.bindReceiptExecution": {
      input: { handle: CronRunReceiptHandle; binding: ExecutionOwnerBinding };
      output: ExecutionOwnerBindingResult;
    };
  };
