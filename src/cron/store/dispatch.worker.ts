import type {
  ExecutionOwnerBinding,
  ExecutionOwnerBindingResult,
} from "../../audit/execution-owner-binding.js";
import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import { requestSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import type { CronStoreWorkerOperations } from "./load-worker.types.js";
import { loadMutableCronStoreInWorker } from "./load.worker.js";
import {
  bindCronRunReceiptExecutionInDatabase,
  ensureCronRunReceiptSchema,
} from "./run-receipt-store.js";
import type { CronRunReceiptHandle } from "./run-receipt.types.js";
import type { CronRuntimeWorkerOperations } from "./runtime-worker.types.js";
import type { CronStoreSaveWorkerOperations } from "./save-worker.types.js";
import { executeCronStoreSaveCommand } from "./save.worker.js";

const loadRecovery = createLazyRuntimeModule(() => import("./run-recovery.worker.js"));
let recovery: typeof import("./run-recovery.worker.js") | undefined;
const loadMaintenance = createLazyRuntimeModule(() => import("./runtime-maintenance.worker.js"));
let maintenance: typeof import("./runtime-maintenance.worker.js") | undefined;

export function prepareCronStateWorkerCommand(type: PropertyKey): Promise<void> | undefined {
  if (
    (type === "cron.scheduleUnowned" || type === "cron.recordFailureAlertOutcome") &&
    !maintenance
  ) {
    return loadMaintenance().then((loaded) => {
      maintenance = loaded;
    });
  }
  if (type !== "cron.repairRun" || recovery) {
    return undefined;
  }
  return loadRecovery().then((loaded) => {
    recovery = loaded;
  });
}

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

export function isCronStateWorkerCommand(command: {
  type: string;
  input: unknown;
}): command is SqliteWorkerCommand<CronStateWorkerOperations> {
  switch (command.type) {
    case "cron.loadMutable":
    case "cron.initializeRunReceipts":
    case "cron.repairRun":
    case "cron.scheduleUnowned":
    case "cron.recordFailureAlertOutcome":
    case "cron.save":
    case "cron.saveChanges":
    case "cron.bindReceiptExecution":
      return true;
    default:
      return false;
  }
}

export function executeCronStateCommand(
  command: SqliteWorkerCommand<CronStateWorkerOperations>,
  database: OpenClawStateDatabase,
): CronStateWorkerOperations[keyof CronStateWorkerOperations]["output"] {
  switch (command.type) {
    case "cron.loadMutable":
      return loadMutableCronStoreInWorker(database, command.input.storeKey);
    case "cron.repairRun":
      if (!recovery) {
        throw new Error("Cron recovery worker is not prepared");
      }
      return recovery.repairCronRunInWorker(database, command.input);
    case "cron.scheduleUnowned":
    case "cron.recordFailureAlertOutcome":
      if (!maintenance) {
        throw new Error("Cron maintenance worker is not prepared");
      }
      return command.type === "cron.scheduleUnowned"
        ? maintenance.scheduleUnownedCronJobsInWorker(database, command.input)
        : maintenance.recordCronFailureAlertOutcomeInWorker(database, command.input);
    case "cron.initializeRunReceipts":
      return runOpenClawStateWriteTransaction(
        ({ db }) => {
          requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
          ensureCronRunReceiptSchema(db);
          requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
        },
        { database, path: database.path, env: getSqliteWorkerStateContext().environment },
        { operationLabel: "cron.run-receipt.initialize" },
      );
    case "cron.save":
    case "cron.saveChanges":
      return executeCronStoreSaveCommand(command, database);
    case "cron.bindReceiptExecution":
      return runOpenClawStateWriteTransaction(
        ({ db }) => {
          requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
          const result = bindCronRunReceiptExecutionInDatabase(
            db,
            command.input.handle,
            command.input.binding,
          );
          requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
          return result;
        },
        { database, path: database.path, env: getSqliteWorkerStateContext().environment },
        { operationLabel: "cron.run-receipt.execution-binding" },
      );
    default:
      throw new Error("Unknown Cron shared-state worker command");
  }
}
