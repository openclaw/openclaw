import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import { resolveCronJobConfigRevision } from "./config-revision.js";
import type {
  CronJobScratchState,
  CronScratchReadCommand,
  CronScratchSnapshot,
} from "./scratch-contract.js";
import { loadedCronStoreFromRows, loadCronRows } from "./store/row-codec.js";
import { getCronStoreKysely } from "./store/schema.js";

function rowToState(row: {
  content: string | null;
  revision: number;
  source_sha256: string | null;
  updated_at_ms: number;
}): CronJobScratchState {
  if (row.content === null) {
    return { currentRevision: row.revision };
  }
  return {
    currentRevision: row.revision,
    scratch: {
      content: row.content,
      revision: row.revision,
      ...(row.source_sha256 ? { sourceSha256: row.source_sha256 } : {}),
      updatedAtMs: row.updated_at_ms,
    },
  };
}

export function readScratchStateFromDatabase(
  db: DatabaseSync,
  storeKey: string,
  jobId: string,
): CronJobScratchState {
  const cronDb = getCronStoreKysely(db);
  const row = executeSqliteQuerySync(
    db,
    cronDb
      .selectFrom("cron_job_scratch")
      .select(["content", "revision", "source_sha256", "updated_at_ms"])
      .where("store_key", "=", storeKey)
      .where("job_id", "=", jobId),
  ).rows[0];
  return row ? rowToState(row) : { currentRevision: 0 };
}

/** The authorized definition and private content belong to one native read snapshot. */
export function readCronScratchSnapshotInDatabase(
  db: DatabaseSync,
  command: CronScratchReadCommand,
): CronScratchSnapshot | undefined {
  return runSqliteDeferredTransactionSync(db, () => {
    // Missing creation metadata keeps the original projection's clock fallback;
    // every actual persisted definition value still comes from this snapshot.
    const job = loadedCronStoreFromRows(
      loadCronRows(db, command.storeKey, new Set([command.selector.jobId])),
      command.selector.createdAtMsFallback,
    ).store.jobs[0];
    if (!job) {
      return undefined;
    }
    return {
      jobId: job.id,
      configRevision: resolveCronJobConfigRevision(job),
      state: readScratchStateFromDatabase(db, command.storeKey, job.id),
    };
  });
}
