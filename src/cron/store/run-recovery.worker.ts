import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import type { CronJobPolicyContext } from "../service/state.js";
import { loadedCronStoreFromRows, loadCronRows } from "./row-codec.js";
import { receiptFromRow, type CronRunReceiptDatabase } from "./run-receipt-read.js";
import { ensureCronRunReceiptSchema } from "./run-receipt-store.js";
import { prepareCronRunReceiptWriteSchema } from "./run-receipt-write-admission.js";
import { recoverCronJobInDatabase } from "./run-recovery.kernel.js";
import type { CronRunRecoveryInput, CronRunRecoveryOutcome } from "./run-recovery.types.js";
import { createCronMutationLogger } from "./runtime-mutation.worker.js";

/** One startup command restores committed outcomes before scheduling can dispatch work. */
export function recoverCronRunsInWorker(
  database: OpenClawStateDatabase,
  input: CronRunRecoveryInput,
): CronRunRecoveryOutcome {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      ensureCronRunReceiptSchema(db);
      const receiptSchema = prepareCronRunReceiptWriteSchema(db);
      const jobs = loadedCronStoreFromRows(loadCronRows(db, input.storeKey)).store.jobs;
      const receipts = new Map(
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<CronRunReceiptDatabase>(db)
            .selectFrom("cron_run_receipts")
            .selectAll()
            .where("store_key", "=", input.storeKey)
            .where("status", "=", "running"),
        ).rows.map((row) => [row.job_id, receiptFromRow(row)]),
      );
      const outcome: CronRunRecoveryOutcome = {
        jobs: [],
        removedJobIds: [],
        interruptedRuns: [],
        notifications: [],
        skipJobIds: [],
        logs: [],
      };
      const state: CronJobPolicyContext = {
        deps: {
          nowMs: () => input.nowMs,
          cronConfig: input.cronConfig,
          defaultAgentId: input.defaultAgentId,
          failureRepairTimeoutMs: input.failureRepairTimeoutMs,
          log: createCronMutationLogger(outcome.logs),
        },
      };
      for (const job of jobs) {
        const result = recoverCronJobInDatabase({
          database,
          receiptSchema,
          job,
          receipt: receipts.get(job.id),
          state,
          storeKey: input.storeKey,
          notifications: outcome.notifications,
        });
        receipts.delete(job.id);
        if (result.removed) {
          outcome.removedJobIds.push(job.id);
        } else {
          outcome.jobs.push(job);
        }
        if (result.interrupted) {
          outcome.interruptedRuns.push(result.interrupted);
        }
        if (result.skipStartupCatchup) {
          outcome.skipJobIds.push(job.id);
        }
      }
      for (const receipt of receipts.values()) {
        const result = recoverCronJobInDatabase({
          database,
          receiptSchema,
          receipt,
          state,
          storeKey: input.storeKey,
          notifications: outcome.notifications,
        });
        if (result.interrupted) {
          outcome.interruptedRuns.push(result.interrupted);
        }
      }
      return outcome;
    },
    { database, path: database.path, env: getSqliteWorkerStateContext().environment },
    { operationLabel: "cron.run-recovery" },
  );
}
