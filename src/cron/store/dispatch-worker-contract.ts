import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import type { CronStateWorkerOperations } from "./dispatch.worker.js";

export function isCronStateWorkerCommand(command: {
  type: string;
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
