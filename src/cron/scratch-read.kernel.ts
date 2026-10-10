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

export function readHeartbeatMonitorScratchFromDatabase(
  db: DatabaseSync,
  storeKey: string,
  agentId: string,
): { jobId: string; state: CronJobScratchState } | undefined {
  const cronDb = getCronStoreKysely(db);
  const row = executeSqliteQuerySync(
    db,
    cronDb
      .selectFrom("cron_jobs")
      .leftJoin("cron_job_scratch", (join) =>
        join
          .onRef("cron_job_scratch.store_key", "=", "cron_jobs.store_key")
          .onRef("cron_job_scratch.job_id", "=", "cron_jobs.job_id"),
      )
      .select([
        "cron_jobs.job_id as job_id",
        "cron_job_scratch.content as content",
        "cron_job_scratch.revision as revision",
        "cron_job_scratch.source_sha256 as source_sha256",
        "cron_job_scratch.updated_at_ms as updated_at_ms",
      ])
      .where("cron_jobs.store_key", "=", storeKey)
      .where("cron_jobs.declaration_key", "=", `heartbeat:${agentId}`)
      .where("cron_jobs.payload_kind", "=", "heartbeat"),
  ).rows[0];
  if (!row) {
    return undefined;
  }
  if (row.revision === null || row.updated_at_ms === null) {
    return { jobId: row.job_id, state: { currentRevision: 0 } };
  }
  return {
    jobId: row.job_id,
    state: rowToState({
      content: row.content,
      revision: row.revision,
      source_sha256: row.source_sha256,
      updated_at_ms: row.updated_at_ms,
    }),
  };
}

/** The authorized definition and private content belong to one native read snapshot. */
export function readCronScratchSnapshotInDatabase(
  db: DatabaseSync,
  command: CronScratchReadCommand,
): CronScratchSnapshot | undefined {
  return runSqliteDeferredTransactionSync(db, () => {
    if (command.selector.kind === "heartbeat") {
      return readHeartbeatMonitorScratchFromDatabase(
        db,
        command.storeKey,
        command.selector.agentId,
      );
    }
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
