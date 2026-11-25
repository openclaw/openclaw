import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { resolveCronJobConfigRevision } from "./config-revision.js";
import type {
  CronJobScratchState,
  CronScratchReadCommand,
  CronScratchSnapshot,
} from "./scratch-contract.js";
import { loadedCronStoreFromRows } from "./store/row-codec.js";
import { CRON_JOB_READ_COLUMNS, getCronStoreKysely } from "./store/schema.js";

function rowToState(row: {
  content: string | null;
  revision: number | null;
  source_sha256: string | null;
  updated_at_ms: number | null;
}): CronJobScratchState {
  if (row.revision === null || row.updated_at_ms === null) {
    return { currentRevision: 0 };
  }
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
  db: EngineConnection,
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

function readHeartbeatMonitorScratchFromDatabase(
  db: EngineConnection,
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
  return row ? { jobId: row.job_id, state: rowToState(row) } : undefined;
}

/** The authorized definition and private content share one statement snapshot. */
export function readCronScratchSnapshotInDatabase(
  db: EngineConnection,
  command: CronScratchReadCommand,
): CronScratchSnapshot | undefined {
  if (command.selector.kind === "heartbeat") {
    return readHeartbeatMonitorScratchFromDatabase(db, command.storeKey, command.selector.agentId);
  }
  const cronDb = getCronStoreKysely(db);
  const row = executeSqliteQuerySync(
    db,
    cronDb
      // Retain the job reader's all-column authorization and narrow result projection.
      .selectFrom(cronDb.selectFrom("cron_jobs").selectAll().as("cron_rows"))
      .leftJoin("cron_job_scratch", (join) =>
        join
          .onRef("cron_job_scratch.store_key", "=", "cron_rows.store_key")
          .onRef("cron_job_scratch.job_id", "=", "cron_rows.job_id"),
      )
      .select(CRON_JOB_READ_COLUMNS.map((column) => `cron_rows.${column}` as const))
      .select([
        "cron_job_scratch.content as content",
        "cron_job_scratch.revision as revision",
        "cron_job_scratch.source_sha256 as source_sha256",
        "cron_job_scratch.updated_at_ms as updated_at_ms",
      ])
      .where("cron_rows.store_key", "=", command.storeKey)
      .where("cron_rows.job_id", "=", command.selector.jobId),
  ).rows[0];
  // Native SQLite replaces lone surrogates in bindings; retain exact caller identity.
  if (!row || row.job_id !== command.selector.jobId) {
    return undefined;
  }
  // Keep the original clock fallback for legacy definitions without creation metadata.
  const job = loadedCronStoreFromRows([row], command.selector.createdAtMsFallback).store.jobs[0];
  if (!job) {
    return undefined;
  }
  return {
    jobId: job.id,
    configRevision: resolveCronJobConfigRevision(job),
    state: rowToState(row),
  };
}
