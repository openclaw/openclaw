import type { DatabaseSync } from "node:sqlite";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { loadedCronStoreFromRows, loadCronRows } from "./row-codec.js";
import { readActiveCronRunReceiptsInDatabase } from "./run-receipt-read.js";
import type {
  CronRunRecoveryObservation,
  CronRunRecoveryReadCommand,
} from "./run-recovery-read.types.js";

export function observeCronRunRecoveryInDatabase(
  database: DatabaseSync,
  command: CronRunRecoveryReadCommand,
): CronRunRecoveryObservation {
  try {
    return runSqliteDeferredTransactionSync(database, () => {
      const receipts = new Map(
        readActiveCronRunReceiptsInDatabase(
          database,
          command.storeKey,
          command.proposals.map((proposal) => proposal.jobId),
        ).map((receipt) => [receipt.jobId, receipt]),
      );
      const runningJobIds = new Set(
        command.proposals
          .filter((proposal) => proposal.runningAtMs !== undefined)
          .map((proposal) => proposal.jobId),
      );
      const jobs = new Map(
        loadedCronStoreFromRows(
          loadCronRows(database, command.storeKey, runningJobIds),
        ).store.jobs.map((job) => [job.id, job]),
      );
      return {
        kind: "observed",
        proposals: command.proposals.map((proposal) => {
          const job = jobs.get(proposal.jobId);
          return {
            jobId: proposal.jobId,
            ...(proposal.queuedAtMs === undefined ? {} : { queuedAtMs: proposal.queuedAtMs }),
            ...(proposal.runningAtMs === undefined ? {} : { runningAtMs: proposal.runningAtMs }),
            receipt: receipts.get(proposal.jobId),
            runningReceiptId:
              job?.state.runningAtMs === proposal.runningAtMs
                ? job?.state.runningReceiptId
                : undefined,
          };
        }),
      };
    });
  } catch (error) {
    if (error instanceof Error && error.message === "no such table: cron_run_receipts") {
      return { kind: "schema-uninitialized" };
    }
    throw error;
  }
}
