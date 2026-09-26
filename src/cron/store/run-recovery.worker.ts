import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import type { CronJobPolicyContext, Logger } from "../service/state.js";
import { loadedCronStoreFromRows, loadCronRows } from "./row-codec.js";
import { repairCronRunInDatabase } from "./run-recovery.kernel.js";
import type { CronRunRecoveryOutcome } from "./run-recovery.types.js";
import {
  prepareCronRuntimeMutation,
  retainCronRuntimeMutationOutcome,
} from "./runtime-mutation.worker.js";
import type { CronRuntimeWorkerOperations } from "./runtime-worker.types.js";

export function repairCronRunsInWorker(
  database: OpenClawStateDatabase,
  input: CronRuntimeWorkerOperations["cron.repairRuns"]["input"],
): CronRuntimeWorkerOperations["cron.repairRuns"]["output"] {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const rows = loadCronRows(
        db,
        input.storeKey,
        new Set(input.proposals.map((proposal) => proposal.jobId)),
      );
      const rowsById = new Map(rows.map((row) => [row.job_id, row]));
      const jobsById = new Map(
        loadedCronStoreFromRows(rows).store.jobs.map((job) => [job.id, job]),
      );
      const facts = input.proposals.map((proposal) => {
        const job = jobsById.get(proposal.jobId);
        return {
          id: proposal.jobId,
          delivery: job?.delivery,
          failureAlert: job?.failureAlert,
        };
      });
      const preparations = prepareCronRuntimeMutation("cron.repairRuns", input.nonce, facts);
      const outcomes = input.proposals.map((proposal, index) => {
        const job = jobsById.get(proposal.jobId);
        const row = rowsById.get(proposal.jobId);
        const preparation = preparations[index]!;
        const logs: CronRunRecoveryOutcome["logs"] = [];
        const record = (level: keyof Logger) => (fields: unknown, message?: string) => {
          logs.push({ level, fields, message });
        };
        const state: CronJobPolicyContext = {
          deps: {
            nowMs: () => preparation.nowMs,
            cronConfig: preparation.cronConfig,
            log: {
              debug: record("debug"),
              info: record("info"),
              warn: record("warn"),
              error: record("error"),
            },
          },
          preparedFailureAlert: { jobId: proposal.jobId, value: preparation.failureAlert },
        };
        return {
          result: repairCronRunInDatabase({
            database,
            row,
            job,
            storeKey: input.storeKey,
            state,
            proposal,
            proposedReceiptIsStale: preparation.proposedReceiptIsStale,
            mode: input.mode,
          }),
          logs,
        };
      });
      return retainCronRuntimeMutationOutcome("cron.repairRuns", db, input.nonce, { outcomes });
    },
    { database, path: database.path, env: getSqliteWorkerStateContext().environment },
    { operationLabel: "cron.run-recovery-batch" },
  );
}
