import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { resolveFailureAlert } from "../service/failure-alerts.js";
import type { CronJobPolicyContext } from "../service/state.js";
import { loadedCronStoreFromRows, loadCronRows } from "./row-codec.js";
import { prepareCronRunReceiptWriteSchema } from "./run-receipt-write-admission.js";
import { repairCronRunInDatabase } from "./run-recovery.kernel.js";
import type { CronRunRecoveryOutcome } from "./run-recovery.types.js";
import { createCronMutationLogger } from "./runtime-mutation.worker.js";
import type { CronRuntimeWorkerOperations } from "./runtime-worker.types.js";

export function repairCronRunInWorker(
  database: OpenClawStateDatabase,
  input: CronRuntimeWorkerOperations["cron.repairRun"]["input"],
): CronRuntimeWorkerOperations["cron.repairRun"]["output"] {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const receiptSchema = prepareCronRunReceiptWriteSchema(db);
      const row = loadCronRows(db, input.storeKey, new Set([input.proposal.jobId]))[0];
      const job = row ? loadedCronStoreFromRows([row]).store.jobs[0] : undefined;
      const logs: CronRunRecoveryOutcome["logs"] = [];
      const { nowMs, cronConfig } = input.snapshot;
      const state: CronJobPolicyContext = {
        deps: {
          nowMs: () => nowMs,
          cronConfig,
          log: createCronMutationLogger(logs),
        },
        preparedFailureAlert: {
          jobId: input.proposal.jobId,
          value: job ? resolveFailureAlert({ deps: { cronConfig } }, job) : null,
        },
      };
      const result = repairCronRunInDatabase({
        database,
        receiptSchema,
        row,
        job,
        storeKey: input.storeKey,
        state,
        proposal: input.proposal,
        proposedReceiptIsStale: input.snapshot.proposedReceiptIsStale,
        mode: input.mode,
      });
      const outcome: CronRunRecoveryOutcome = { result, logs };
      return { outcome };
    },
    { database, path: database.path, env: getSqliteWorkerStateContext().environment },
    { operationLabel: "cron.run-recovery" },
  );
}
