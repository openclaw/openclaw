import type { EngineConnection } from "../../infra/sql-connection.js";
import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import type { OpenClawStateReadCommand } from "../../state/openclaw-state-read.types.js";
import { readCronScratchSnapshotInDatabase } from "../scratch-read.kernel.js";
import { readCronJobNamesInDatabase } from "./job-name.kernel.js";
import { resolveCronStoreKeyInDatabase } from "./paths.js";
import { readCronQuarantinedJobsInDatabase } from "./quarantine.kernel.js";
import { readCronRunReceiptCurrentFactsInDatabase } from "./run-receipt-read.js";

type CronStateReadCommand = Extract<OpenClawStateReadCommand, { type: `cron.${string}` }>;

export function isCronStateReadCommand(
  command: OpenClawStateReadCommand,
): command is CronStateReadCommand {
  switch (command.type) {
    case "cron.currentReceipt":
    case "cron.scratch":
    case "cron.jobNames":
    case "cron.quarantine":
      return true;
    default:
      return false;
  }
}

/** Runs Cron queries inside the shared reader's admitted native frame. */
export function readCronStateCommandInDatabase(
  db: EngineConnection,
  command: CronStateReadCommand,
) {
  switch (command.type) {
    case "cron.currentReceipt":
      return {
        type: command.type,
        facts: readCronRunReceiptCurrentFactsInDatabase(db, command),
      };
    case "cron.scratch":
      return {
        type: command.type,
        snapshot: readCronScratchSnapshotInDatabase(db, command),
      };
    case "cron.jobNames": {
      const storeKey =
        command.storePath ??
        resolveCronStoreKeyInDatabase(db, undefined, getSqliteWorkerStateContext().environment);
      return {
        type: command.type,
        storeKey,
        names: readCronJobNamesInDatabase(db, command.jobIds, storeKey),
      };
    }
    case "cron.quarantine":
      return {
        type: command.type,
        entries: readCronQuarantinedJobsInDatabase(db, command.storeKey),
      };
    default:
      throw new Error("Unsupported Cron read command");
  }
}
