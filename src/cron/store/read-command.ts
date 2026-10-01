import type { DatabaseSync } from "node:sqlite";
import type {
  OpenClawStateReadCommand,
  OpenClawStateReadResult,
} from "../../state/openclaw-state-read.types.js";
import { readCronScratchSnapshotInDatabase } from "../scratch-read.kernel.js";
import { readCronJobNamesInDatabase } from "./job-name.js";
import { resolveCronJobsStorePath } from "./paths.js";
import { readCronQuarantinedJobsInDatabase } from "./quarantine.js";
import {
  readActiveCronRunReceiptOwnersInDatabase,
  readCronRunReceiptCurrentFactsInDatabase,
} from "./run-receipt-read.js";
import { observeCronRunRecoveryInDatabase } from "./run-recovery.read.js";

type CronStateReadCommand = Extract<OpenClawStateReadCommand, { type: `cron.${string}` }>;

export function isCronStateReadCommand(
  command: OpenClawStateReadCommand,
): command is CronStateReadCommand {
  switch (command.type) {
    case "cron.observeRunRecovery":
    case "cron.currentReceipt":
    case "cron.scratch":
    case "cron.jobNames":
    case "cron.quarantine":
    case "cron.activeReceiptOwners":
      return true;
    default:
      return false;
  }
}

/** Runs Cron queries inside the shared reader's admitted native frame. */
export function readCronStateCommandInDatabase(
  db: DatabaseSync,
  command: CronStateReadCommand,
): Extract<OpenClawStateReadResult, { type: `cron.${string}` }> {
  switch (command.type) {
    case "cron.observeRunRecovery":
      return {
        type: command.type,
        observation: observeCronRunRecoveryInDatabase(db, command),
      };
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
    case "cron.jobNames":
      return {
        type: command.type,
        names: readCronJobNamesInDatabase(
          db,
          command.jobIds,
          command.storePath ?? resolveCronJobsStorePath(),
        ),
      };
    case "cron.quarantine":
      return {
        type: command.type,
        entries: readCronQuarantinedJobsInDatabase(db, command.storeKey),
      };
    case "cron.activeReceiptOwners":
      return {
        type: command.type,
        owners: readActiveCronRunReceiptOwnersInDatabase(db, command.agentId),
      };
    default:
      throw new Error("Unsupported Cron read command");
  }
}
