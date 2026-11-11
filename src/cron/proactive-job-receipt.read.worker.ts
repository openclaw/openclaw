import type { EngineConnection } from "../infra/sql-connection.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import { getSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import { readDefaultProactiveJobReceiptInDatabase } from "./proactive-job-receipt.kernel.js";
import type { ProactiveJobReceiptReadOperations } from "./proactive-job-receipt.types.js";
import { resolveCronStoreSelectionInDatabase } from "./store/paths.js";
import { loadCronRows, loadedCronStoreFromRows } from "./store/row-codec.js";

function readReceipts(db: EngineConnection, input: { storeKey: string; agentIds: string[] }) {
  const storeKey = input.storeKey;
  return {
    storeKey,
    receipts: Object.fromEntries(
      input.agentIds.flatMap((agentId) => {
        const receipt = readDefaultProactiveJobReceiptInDatabase(db, storeKey, agentId);
        return receipt ? [[agentId, receipt] as const] : [];
      }),
    ),
  };
}

export const proactiveJobReceiptReadOperations = {
  "automationProactive.storeSelection": (
    input: ProactiveJobReceiptReadOperations["automationProactive.storeSelection"]["input"],
    db,
  ) =>
    runSqliteDeferredTransactionSync(db, () => ({
      type: "automationProactive.storeSelection" as const,
      selection: resolveCronStoreSelectionInDatabase(
        db,
        input.storePath,
        getSqliteWorkerStateContext().environment,
        input.defaultStorePath,
      ),
    })),
  "automationProactive.receipts": (
    input: ProactiveJobReceiptReadOperations["automationProactive.receipts"]["input"],
    db,
  ) =>
    runSqliteDeferredTransactionSync(db, () => {
      return {
        type: "automationProactive.receipts" as const,
        receipts: readReceipts(db, input).receipts,
      };
    }),
  "automationProactive.jobs": (
    input: ProactiveJobReceiptReadOperations["automationProactive.jobs"]["input"],
    db,
  ) =>
    runSqliteDeferredTransactionSync(db, () => {
      const { storeKey, receipts } = readReceipts(db, input);
      const jobIds = new Set(
        Object.values(receipts).flatMap((receipt) =>
          receipt.phase === "complete" ? [receipt.jobId].concat(receipt.convertedJobIds ?? []) : [],
        ),
      );
      const jobs =
        jobIds.size > 0
          ? loadedCronStoreFromRows(loadCronRows(db, storeKey, jobIds)).store.jobs
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
    db: EngineConnection,
  ) => ProactiveJobReceiptReadOperations[Type]["output"];
};
