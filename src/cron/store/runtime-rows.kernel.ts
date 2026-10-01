import type { DatabaseSync } from "node:sqlite";
import type { CronStoredJob } from "../types.js";
import {
  deleteCronJobRowInDatabase,
  loadedCronStoreFromRows,
  loadCronRows,
  upsertCronJobRow,
} from "./row-codec.js";
import {
  prepareCronRunReceiptWriteSchema,
  type CronRunReceiptWriteSchema,
} from "./run-receipt-write-admission.js";
import {
  loadCronRuntimeAuthorities,
  repairCronRuntimeAuthorityRows,
} from "./runtime-authority-store.js";
import type { CronStoreTransactionHooks } from "./transaction-hooks.types.js";

export type CronRuntimeRowsMutation<T> = (context: {
  database: DatabaseSync;
  receiptSchema: CronRunReceiptWriteSchema;
  jobs: ReadonlyMap<string, CronStoredJob>;
}) => {
  deleteJobIds?: Iterable<string>;
  runHooks?: boolean;
  upsertJobIds?: Iterable<string>;
  value: T;
};

/** The caller owns the transaction; target rows and their authority are reread under its write lock. */
export function mutateCronRuntimeRowsInDatabase<T>(params: {
  database: DatabaseSync;
  storeKey: string;
  jobIds: ReadonlySet<string>;
  transactionHooks?: Pick<CronStoreTransactionHooks, "beforeWrite" | "afterWrite">;
  mutate: CronRuntimeRowsMutation<T>;
}): { changed: boolean; runHooks: boolean; value: T } {
  const { database: db, storeKey, jobIds } = params;
  const receiptSchema = prepareCronRunReceiptWriteSchema(db);
  const rows = loadCronRows(db, storeKey, jobIds, {
    includeGrantDefinitionProjection: true,
  });
  const rowsByJobId = new Map(rows.map((row) => [row.job_id, row] as const));
  const loadedJobs = loadedCronStoreFromRows(rows).store.jobs;
  const { repairJobIds } = loadCronRuntimeAuthorities({ db, storeKey, jobs: loadedJobs });
  if (repairJobIds.length > 0) {
    repairCronRuntimeAuthorityRows({
      db,
      storeKey,
      jobs: loadedJobs,
      jobIds: repairJobIds,
    });
  }
  const jobs = new Map(loadedJobs.map((job) => [job.id, job] as const));
  const mutation = params.mutate({ database: db, jobs, receiptSchema });
  const upsertJobIds = [...new Set(mutation.upsertJobIds ?? [])].toSorted();
  const deleteJobIds = [...new Set(mutation.deleteJobIds ?? [])].toSorted();
  const runHooks = mutation.runHooks !== false;
  if (runHooks) {
    params.transactionHooks?.beforeWrite?.(db, receiptSchema);
  }
  for (const jobId of deleteJobIds) {
    deleteCronJobRowInDatabase(db, storeKey, jobId);
  }
  for (const jobId of upsertJobIds) {
    const row = rowsByJobId.get(jobId);
    const job = jobs.get(jobId);
    if (row && job && !deleteJobIds.includes(jobId)) {
      upsertCronJobRow(db, storeKey, job, row.sort_order, { knownExistingRow: row });
    }
  }
  if (runHooks) {
    params.transactionHooks?.afterWrite?.(db, receiptSchema);
  }
  return {
    changed: upsertJobIds.length > 0 || deleteJobIds.length > 0,
    runHooks,
    value: mutation.value,
  };
}
