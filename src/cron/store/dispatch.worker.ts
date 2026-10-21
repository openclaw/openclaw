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
import { ensureCronRunReceiptSchema } from "./run-receipt-store.js";
import { executeCronStoreSaveCommand } from "./save.worker.js";
import type { CronStateWorkerOperations } from "./worker-contract.js";

const loadQueue = createLazyRuntimeModule(() => import("./run-queue.worker.js"));
let queue: typeof import("./run-queue.worker.js") | undefined;

const loadReceipts = createLazyRuntimeModule(() => import("./run-receipt.worker.js"));
let receipts: typeof import("./run-receipt.worker.js") | undefined;
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
const loadSchedulerActor = createLazyRuntimeModule(() => import("./scheduler-actor.worker.js"));
let schedulerActor: typeof import("./scheduler-actor.worker.js") | undefined;

export function prepareCronStateWorkerCommand(type: PropertyKey): Promise<void> | undefined {
  if (String(type).startsWith("cron.scheduler") && !schedulerActor) {
    return loadSchedulerActor().then((loaded) => {
      schedulerActor = loaded;
    });
  }
  if (
    ["cron.requestRuns", "cron.drainQueue", "cron.cancelRequests"].includes(String(type)) &&
    !queue
  ) {
    return loadQueue().then((loaded) => {
      queue = loaded;
    });
  }
  if (type === "cron.finalizeRuns" && !finalization) {
    return loadFinalization().then((loaded) => {
      finalization = loaded;
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
      "cron.markDeliveryStarted",
      "cron.releaseDeliveryAdmission",
      "cron.removeStaleFamily",
      "cron.bindReceiptExecution",
    ].includes(String(type)) &&
    !receipts
  ) {
    return loadReceipts().then((loaded) => {
      receipts = loaded;
    });
  }
  if (
    (type === "cron.scheduleUnowned" ||
      type === "cron.recordFailureAlertOutcome" ||
      type === "cron.recordFailureRepairSettlement" ||
      type === "cron.maintainHistory") &&
    !maintenance
  ) {
    return loadMaintenance().then((loaded) => {
      maintenance = loaded;
    });
  }
  if (type !== "cron.recoverRuns" || recovery) {
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
    case "cron.schedulerStart":
    case "cron.schedulerTick":
    case "cron.schedulerRefresh":
    case "cron.schedulerStop":
    case "cron.requestRuns":
    case "cron.drainQueue":
    case "cron.cancelRequests":
    case "cron.recordSkippedRuns":
    case "cron.mutateExternalState":
    case "cron.writeScratch":
    case "cron.mutateJobs":
    case "cron.recordRun":
    case "cron.markDeliveryStarted":
    case "cron.releaseDeliveryAdmission":
    case "cron.bindReceiptExecution":
    case "cron.finalizeRuns":
    case "cron.removeStaleFamily":
    case "cron.loadMutable":
    case "cron.initializeRunReceipts":
    case "cron.recoverRuns":
    case "cron.scheduleUnowned":
    case "cron.maintainHistory":
    case "cron.recordFailureAlertOutcome":
    case "cron.recordFailureRepairSettlement":
    case "cron.save":
    case "cron.saveChanges":
    case "cron.registerQuarantine":
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
    case "cron.schedulerStart":
    case "cron.schedulerTick":
    case "cron.schedulerRefresh":
    case "cron.schedulerStop":
      if (!schedulerActor) {
        throw new Error("Cron scheduler actor is not prepared");
      }
      if (command.type === "cron.schedulerStop") {
        return schedulerActor.stopCronSchedulerInWorker(command.input);
      }
      return schedulerActor.runCronSchedulerInWorker(database, command);
    case "cron.requestRuns":
    case "cron.drainQueue":
    case "cron.cancelRequests":
      if (!queue) {
        throw new Error("Cron queue worker is not prepared");
      }
      switch (command.type) {
        case "cron.requestRuns":
          return queue.requestCronRunsInWorker(database, command.input);
        case "cron.drainQueue":
          return queue.drainCronQueueInWorker(database, command.input);
        case "cron.cancelRequests":
          return queue.cancelCronRequestsInWorker(database, command.input);
      }
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
    case "cron.markDeliveryStarted":
    case "cron.releaseDeliveryAdmission":
    case "cron.bindReceiptExecution":
    case "cron.removeStaleFamily":
      if (!receipts) {
        throw new Error("Cron receipts worker is not prepared");
      }
      switch (command.type) {
        case "cron.bindReceiptExecution":
          return receipts.bindCronRunReceiptExecutionInWorker(database, command.input);
        case "cron.markDeliveryStarted":
          return receipts.markCronDeliveryStartedInWorker(database, command.input);
        case "cron.releaseDeliveryAdmission":
          return receipts.releaseCronDeliveryAdmissionInWorker(database, command.input);
        case "cron.removeStaleFamily":
          return receipts.removeStaleCronFamilyInWorker(database, command.input);
      }
    case "cron.loadMutable":
      return loadMutableCronStoreInWorker(database, command.input.storeKey);
    case "cron.recoverRuns":
      if (!recovery) {
        throw new Error("Cron recovery worker is not prepared");
      }
      return recovery.recoverCronRunsInWorker(database, command.input);
    case "cron.scheduleUnowned":
    case "cron.maintainHistory":
    case "cron.recordFailureAlertOutcome":
    case "cron.recordFailureRepairSettlement":
      if (!maintenance) {
        throw new Error("Cron maintenance worker is not prepared");
      }
      if (command.type === "cron.maintainHistory") {
        return maintenance.maintainCronRunHistoryInWorker(database, command.input);
      }
      if (command.type === "cron.recordFailureRepairSettlement") {
        return maintenance.recordCronFailureRepairSettlementInWorker(database, command.input);
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
    default:
      throw new Error("Unknown Cron shared-state worker command");
  }
}
