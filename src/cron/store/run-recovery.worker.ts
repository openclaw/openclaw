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

export function repairCronRunInWorker(
  database: OpenClawStateDatabase,
  input: CronRuntimeWorkerOperations["cron.repairRun"]["input"],
): CronRuntimeWorkerOperations["cron.repairRun"]["output"] {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const row = loadCronRows(db, input.storeKey, new Set([input.proposal.jobId]))[0];
      const job = row ? loadedCronStoreFromRows([row]).store.jobs[0] : undefined;
      const preparation = prepareCronRuntimeMutation("cron.repairRun", input.nonce, {
        id: input.proposal.jobId,
        delivery: job?.delivery,
        failureAlert: job?.failureAlert,
      });
      const logs: CronRunRecoveryOutcome["logs"] = [];
      const record = (level: keyof Logger) => (fields: unknown, message?: string) => {
        logs.push({ level, fields, message });
      };
      const { nowMs, cronConfig, failureAlert } = preparation;
      const state: CronJobPolicyContext = {
        deps: {
          nowMs: () => nowMs,
          cronConfig,
          log: {
            debug: record("debug"),
            info: record("info"),
            warn: record("warn"),
            error: record("error"),
          },
        },
        preparedFailureAlert: { jobId: input.proposal.jobId, value: failureAlert },
      };
      const result = repairCronRunInDatabase({
        database,
        row,
        job,
        storeKey: input.storeKey,
        state,
        proposal: input.proposal,
        proposedReceiptIsStale: preparation.proposedReceiptIsStale,
        mode: input.mode,
      });
      const outcome: CronRunRecoveryOutcome = { result, logs };
      return retainCronRuntimeMutationOutcome("cron.repairRun", db, input.nonce, outcome);
    },
    { database, path: database.path, env: getSqliteWorkerStateContext().environment },
    { operationLabel: "cron.run-recovery" },
  );
}
