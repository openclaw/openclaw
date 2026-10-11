import type { DatabaseSync } from "node:sqlite";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import { getSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import { readDefaultProactiveJobReceiptInDatabase } from "./proactive-job-receipt.kernel.js";
import type { ProactiveJobReceiptReadOperations } from "./proactive-job-receipt.types.js";
import { cronStoreKey } from "./store/key.js";
import { resolveCronJobsStorePathInDatabase } from "./store/paths.js";
import { loadCronRows, loadedCronStoreFromRows } from "./store/row-codec.js";

function readReceipts(
  db: DatabaseSync,
  input: { storePath: string | undefined; agentIds: string[] },
) {
  const storePath = resolveCronJobsStorePathInDatabase(
    db,
    input.storePath,
    getSqliteWorkerStateContext().environment,
  );
  return {
    storePath,
    receipts: Object.fromEntries(
      input.agentIds.flatMap((agentId) => {
        const receipt = readDefaultProactiveJobReceiptInDatabase(db, storePath, agentId);
        return receipt ? [[agentId, receipt] as const] : [];
      }),
    ),
  };
}

export const proactiveJobReceiptReadOperations = {
  "automationProactive.receipts": (
    input: { storePath: string | undefined; agentIds: string[] },
    db,
  ) =>
    runSqliteDeferredTransactionSync(db, () => {
      return {
        type: "automationProactive.receipts" as const,
        receipts: readReceipts(db, input).receipts,
      };
    }),
  "automationProactive.jobs": (input: { storePath: string | undefined; agentIds: string[] }, db) =>
    runSqliteDeferredTransactionSync(db, () => {
      const { storePath, receipts } = readReceipts(db, input);
      const jobIds = new Set(
        Object.values(receipts).flatMap((receipt) =>
          receipt.phase === "complete" ? [receipt.jobId].concat(receipt.convertedJobIds ?? []) : [],
        ),
      );
      const jobs =
        jobIds.size > 0
          ? loadedCronStoreFromRows(loadCronRows(db, cronStoreKey(storePath), jobIds)).store.jobs
          : [];
      const jobsById = new Map(jobs.map((job) => [job.id, job]));
      return {
        type: "automationProactive.jobs" as const,
        jobs: [...jobIds].flatMap((id) => {
          const job = jobsById.get(id);
          return job ? [job] : [];
        }),
      };
    }),
} satisfies {
  [Type in keyof ProactiveJobReceiptReadOperations]: (
    input: ProactiveJobReceiptReadOperations[Type]["input"],
    db: DatabaseSync,
  ) => ProactiveJobReceiptReadOperations[Type]["output"];
};
