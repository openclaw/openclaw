import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { loadMutableCronStoreInWorker } from "./load.worker.js";
import { registerCronQuarantineInDatabase } from "./quarantine.kernel.js";
import { recordCronRunInDatabase } from "./run-history.kernel.js";
import {
  bindCronRunReceiptExecutionInDatabase,
  ensureCronRunReceiptSchema,
} from "./run-receipt-store.js";
import { prepareCronRunReceiptWriteSchema } from "./run-receipt-write-admission.js";
import { executeCronStoreSaveCommand } from "./save.worker.js";
import type { CronStateWorkerOperations } from "./worker-contract.js";

const loadAdmission = createLazyRuntimeModule(() => import("./run-admission.worker.js"));
let admission: typeof import("./run-admission.worker.js") | undefined;
const loadFinalization = createLazyRuntimeModule(() => import("./run-finalization.worker.js"));
let finalization: typeof import("./run-finalization.worker.js") | undefined;

const loadRecovery = createLazyRuntimeModule(() => import("./run-recovery.worker.js"));
let recovery: typeof import("./run-recovery.worker.js") | undefined;
const loadMaintenance = createLazyRuntimeModule(() => import("./runtime-maintenance.worker.js"));
let maintenance: typeof import("./runtime-maintenance.worker.js") | undefined;
const loadMutation = createLazyRuntimeModule(() => import("./guarded-mutation.worker.js"));
let mutation: typeof import("./guarded-mutation.worker.js") | undefined;
const loadScratch = createLazyRuntimeModule(() => import("./scratch.worker.js"));
let scratch: typeof import("./scratch.worker.js") | undefined;
const loadExternalState = createLazyRuntimeModule(() => import("./external-state.worker.js"));
let externalState: typeof import("./external-state.worker.js") | undefined;
const loadScheduler = createLazyRuntimeModule(() => import("./scheduler-state.worker.js"));
let scheduler: typeof import("./scheduler-state.worker.js") | undefined;
const loadStartup = createLazyRuntimeModule(() => import("./startup-plan.worker.js"));
let startup: typeof import("./startup-plan.worker.js") | undefined;

export function prepareCronStateWorkerCommand(type: PropertyKey): Promise<void> | undefined {
  if (type === "cron.finalizeRuns" && !finalization) {
    return loadFinalization().then((loaded) => {
      finalization = loaded;
    });
  }
  if (type === "cron.planStartup" && !startup) {
    return loadStartup().then((loaded) => {
      startup = loaded;
    });
  }
  if (type === "cron.recordSkippedRuns" && !scheduler) {
    return loadScheduler().then((loaded) => {
      scheduler = loaded;
    });
  }
  if (type === "cron.mutateExternalState" && !externalState) {
    return loadExternalState().then((loaded) => {
      externalState = loaded;
    });
  }
  if (type === "cron.writeScratch" && !scratch) {
    return loadScratch().then((loaded) => {
      scratch = loaded;
    });
  }
  if (type === "cron.mutateJobs" && !mutation) {
    return loadMutation().then((loaded) => {
      mutation = loaded;
    });
  }
  if (
    [
      "cron.reserveRuns",
      "cron.activateRun",
      "cron.releaseReservations",
      "cron.markDeliveryStarted",
      "cron.finishReceipt",
      "cron.removeStaleFamily",
    ].includes(String(type)) &&
    !admission
  ) {
    return loadAdmission().then((loaded) => {
      admission = loaded;
    });
  }
  if (
    (type === "cron.scheduleUnowned" ||
      type === "cron.recordFailureAlertOutcome" ||
      type === "cron.maintainHistory") &&
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

export function isCronStateWorkerCommand(command: {
  type: string;
  input: unknown;
}): command is SqliteWorkerCommand<CronStateWorkerOperations> {
  switch (command.type) {
    case "cron.recordSkippedRuns":
    case "cron.planStartup":
    case "cron.mutateExternalState":
    case "cron.writeScratch":
    case "cron.mutateJobs":
    case "cron.reserveRuns":
    case "cron.recordRun":
    case "cron.activateRun":
    case "cron.releaseReservations":
    case "cron.markDeliveryStarted":
    case "cron.finishReceipt":
    case "cron.finalizeRuns":
    case "cron.removeStaleFamily":
    case "cron.loadMutable":
    case "cron.initializeRunReceipts":
    case "cron.repairRun":
    case "cron.scheduleUnowned":
    case "cron.maintainHistory":
    case "cron.recordFailureAlertOutcome":
    case "cron.save":
    case "cron.saveChanges":
    case "cron.registerQuarantine":
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
    case "cron.registerQuarantine":
      return runOpenClawStateWriteTransaction(
        ({ db }) => registerCronQuarantineInDatabase(db, command.input),
        { database, path: database.path, env: getSqliteWorkerStateContext().environment },
        { operationLabel: command.type },
      );
    case "cron.recordSkippedRuns":
      if (!scheduler) {
        throw new Error("Cron scheduler worker is not prepared");
      }
      return scheduler.recordSkippedCronRunsInWorker(database, command.input);
    case "cron.planStartup":
      if (!startup) {
        throw new Error("Cron startup worker is not prepared");
      }
      return startup.planCronStartupInWorker(database, command.input);
    case "cron.mutateExternalState":
      if (!externalState) {
        throw new Error("Cron external-state worker is not prepared");
      }
      return externalState.mutateCronExternalStateInWorker(database, command.input);
    case "cron.writeScratch":
      if (!scratch) {
        throw new Error("Cron scratch worker is not prepared");
      }
      return scratch.writeCronScratchInWorker(database, command.input);
    case "cron.mutateJobs":
      if (!mutation) {
        throw new Error("Cron mutation worker is not prepared");
      }
      return mutation.mutateCronJobsInWorker(database, command.input);
    case "cron.recordRun":
      return runOpenClawStateWriteTransaction(
        ({ db }) => recordCronRunInDatabase(db, command.input),
        { database, path: database.path, env: getSqliteWorkerStateContext().environment },
        { operationLabel: command.type },
      );
    case "cron.finalizeRuns":
      if (!finalization) {
        throw new Error("Cron finalization worker is not prepared");
      }
      return finalization.finalizeCronRunsInWorker(database, command.input);
    case "cron.reserveRuns":
    case "cron.activateRun":
    case "cron.releaseReservations":
    case "cron.markDeliveryStarted":
    case "cron.finishReceipt":
    case "cron.removeStaleFamily":
      if (!admission) {
        throw new Error("Cron admission worker is not prepared");
      }
      switch (command.type) {
        case "cron.reserveRuns":
          return admission.reserveCronRunsInWorker(database, command.input);
        case "cron.activateRun":
          return admission.activateCronRunInWorker(database, command.input);
        case "cron.releaseReservations":
          return admission.releaseCronReservationsInWorker(database, command.input);
        case "cron.markDeliveryStarted":
          return admission.markCronDeliveryStartedInWorker(database, command.input);
        case "cron.finishReceipt":
          return admission.finishCronReceiptInWorker(database, command.input);
        case "cron.removeStaleFamily":
          return admission.removeStaleCronFamilyInWorker(database, command.input);
      }
    case "cron.loadMutable":
      return loadMutableCronStoreInWorker(database, command.input.storeKey);
    case "cron.repairRun":
      if (!recovery) {
        throw new Error("Cron recovery worker is not prepared");
      }
      return recovery.repairCronRunInWorker(database, command.input);
    case "cron.scheduleUnowned":
    case "cron.maintainHistory":
    case "cron.recordFailureAlertOutcome":
      if (!maintenance) {
        throw new Error("Cron maintenance worker is not prepared");
      }
      if (command.type === "cron.maintainHistory") {
        return maintenance.maintainCronRunHistoryInWorker(database, command.input);
      }
      return command.type === "cron.scheduleUnowned"
        ? maintenance.scheduleUnownedCronJobsInWorker(database, command.input)
        : maintenance.recordCronFailureAlertOutcomeInWorker(database, command.input);
    case "cron.initializeRunReceipts":
      return runOpenClawStateWriteTransaction(
        ({ db }) => ensureCronRunReceiptSchema(db),
        { database, path: database.path, env: getSqliteWorkerStateContext().environment },
        { operationLabel: "cron.run-receipt.initialize" },
      );
    case "cron.save":
    case "cron.saveChanges":
      return executeCronStoreSaveCommand(command, database);
    case "cron.bindReceiptExecution":
      return runOpenClawStateWriteTransaction(
        ({ db }) =>
          bindCronRunReceiptExecutionInDatabase(
            db,
            command.input.handle,
            command.input.binding,
            prepareCronRunReceiptWriteSchema(db),
          ),
        { database, path: database.path, env: getSqliteWorkerStateContext().environment },
        { operationLabel: "cron.run-receipt.execution-binding" },
      );
    default:
      throw new Error("Unknown Cron shared-state worker command");
  }
}
