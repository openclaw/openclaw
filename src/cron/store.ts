import path from "node:path";
import type { Insertable } from "kysely";
import { expandHomePrefix } from "../infra/home-dir.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resolveConfigDir } from "../utils.js";
import { tryCronScheduleIdentity } from "./schedule-identity.js";
import type { CronJob, CronStoreFile } from "./types.js";

type CronJobsTable = OpenClawStateKyselyDatabase["cron_jobs"];
type CronJobsDatabase = Pick<OpenClawStateKyselyDatabase, "cron_jobs">;
type CronStoreUpdateDatabase = Pick<OpenClawStateKyselyDatabase, "cron_jobs">;

type CronJobRow = {
  job_id: string;
  job_json: string;
  runtime_updated_at_ms: number | null;
  schedule_identity: string | null;
  state_json: string;
};

const DEFAULT_CRON_STORE_KEY = "default";

function resolveDefaultCronDir(): string {
  return path.join(resolveConfigDir(), "cron");
}

function resolveDefaultLegacyCronStorePath(): string {
  return path.join(resolveDefaultCronDir(), "jobs.json");
}

export type CronStateFileEntry = {
  updatedAtMs?: number;
  scheduleIdentity?: string;
  state?: Record<string, unknown>;
};

export type CronStateFile = {
  version: 1;
  jobs: Record<string, CronStateFileEntry>;
};

function cronStoreKey(storeKey: string): string {
  const normalized = storeKey.trim();
  return normalized || DEFAULT_CRON_STORE_KEY;
}

function getCronJobsKysely(db: import("node:sqlite").DatabaseSync) {
  return getNodeSqliteKysely<CronJobsDatabase>(db);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stripRuntimeOnlyCronJobFields(job: CronJob): Record<string, unknown> {
  const { state: _state, updatedAtMs: _updatedAtMs, ...rest } = job;
  return { ...rest, state: {} };
}

function extractStateFile(store: CronStoreFile): CronStateFile {
  const jobs: Record<string, CronStateFileEntry> = {};
  for (const job of store.jobs) {
    jobs[job.id] = {
      updatedAtMs: job.updatedAtMs,
      scheduleIdentity: tryCronScheduleIdentity(job as unknown as Record<string, unknown>),
      state: job.state ?? {},
    };
  }
  return { version: 1, jobs };
}

export const extractCronStateFileForMigration = extractStateFile;

export function resolveCronStoreKey(): string {
  return DEFAULT_CRON_STORE_KEY;
}

export function resolveLegacyCronStorePath(configuredLegacyStorePath?: string): string {
  if (configuredLegacyStorePath?.trim()) {
    const raw = configuredLegacyStorePath.trim();
    if (raw.startsWith("~")) {
      return path.resolve(expandHomePrefix(raw));
    }
    return path.resolve(raw);
  }
  return resolveDefaultLegacyCronStorePath();
}

function ensureJobStateObject(job: CronStoreFile["jobs"][number]): void {
  if (!job.state || typeof job.state !== "object") {
    job.state = {} as never;
  }
}

function backfillMissingRuntimeFields(job: CronStoreFile["jobs"][number]): void {
  ensureJobStateObject(job);
  if (typeof job.updatedAtMs !== "number") {
    job.updatedAtMs = typeof job.createdAtMs === "number" ? job.createdAtMs : Date.now();
  }
}

function resolveUpdatedAtMs(job: CronStoreFile["jobs"][number], updatedAtMs: unknown): number {
  if (typeof updatedAtMs === "number" && Number.isFinite(updatedAtMs)) {
    return updatedAtMs;
  }
  if (typeof job.updatedAtMs === "number" && Number.isFinite(job.updatedAtMs)) {
    return job.updatedAtMs;
  }
  return typeof job.createdAtMs === "number" && Number.isFinite(job.createdAtMs)
    ? job.createdAtMs
    : Date.now();
}

function mergeStateFileEntry(job: CronStoreFile["jobs"][number], entry: CronStateFileEntry): void {
  job.updatedAtMs = resolveUpdatedAtMs(job, entry.updatedAtMs);
  job.state = (entry.state ?? {}) as never;
  if (
    typeof entry.scheduleIdentity === "string" &&
    entry.scheduleIdentity !== tryCronScheduleIdentity(job as unknown as Record<string, unknown>)
  ) {
    ensureJobStateObject(job);
    job.state.nextRunAtMs = undefined;
  }
}

function parseCronStateJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function mergeCronJobRowRuntimeState(job: CronStoreFile["jobs"][number], row: CronJobRow): void {
  mergeStateFileEntry(job, {
    updatedAtMs: row.runtime_updated_at_ms ?? undefined,
    scheduleIdentity: row.schedule_identity ?? undefined,
    state: parseCronStateJson(row.state_json),
  });
}

function hydrateCronStoreFromSqlite(storeKey: string): CronStoreFile {
  const database = openOpenClawStateDatabase();
  const rows = executeSqliteQuerySync(
    database.db,
    getCronJobsKysely(database.db)
      .selectFrom("cron_jobs")
      .select(["job_id", "job_json", "runtime_updated_at_ms", "schedule_identity", "state_json"])
      .where("store_key", "=", cronStoreKey(storeKey))
      .orderBy("sort_order", "asc")
      .orderBy("updated_at", "asc")
      .orderBy("job_id", "asc"),
  ).rows;
  const jobs = rows.flatMap((row) => {
    try {
      const parsed = JSON.parse(row.job_json) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? [parsed as CronStoreFile["jobs"][number]]
        : [];
    } catch {
      return [];
    }
  });
  for (const job of jobs) {
    const row = rows.find((candidate) => candidate.job_id === job.id);
    if (row) {
      mergeCronJobRowRuntimeState(job, row);
    } else {
      backfillMissingRuntimeFields(job);
    }
    ensureJobStateObject(job);
  }
  return { version: 1, jobs };
}

export async function loadCronStore(storeKey: string): Promise<CronStoreFile> {
  return hydrateCronStoreFromSqlite(storeKey);
}

export function loadCronStoreSync(storeKey: string): CronStoreFile {
  return hydrateCronStoreFromSqlite(storeKey);
}

function cronJobRow(storeKey: string, job: CronJob, sortOrder: number): Insertable<CronJobsTable> {
  const scheduleIdentity = tryCronScheduleIdentity(job as unknown as Record<string, unknown>);
  return {
    store_key: cronStoreKey(storeKey),
    job_id: job.id,
    job_json: JSON.stringify(stripRuntimeOnlyCronJobFields(job)),
    state_json: JSON.stringify(job.state ?? {}),
    runtime_updated_at_ms:
      typeof job.updatedAtMs === "number" && Number.isFinite(job.updatedAtMs)
        ? job.updatedAtMs
        : null,
    schedule_identity: scheduleIdentity,
    sort_order: sortOrder,
    updated_at: Date.now(),
  };
}

function cronStateUpdateValues(
  job: CronJob,
): Pick<Insertable<CronJobsTable>, "runtime_updated_at_ms" | "schedule_identity" | "state_json"> {
  return {
    state_json: JSON.stringify(job.state ?? {}),
    runtime_updated_at_ms:
      typeof job.updatedAtMs === "number" && Number.isFinite(job.updatedAtMs)
        ? job.updatedAtMs
        : null,
    schedule_identity: tryCronScheduleIdentity(job as unknown as Record<string, unknown>),
  };
}

function writeCronJobsToSqlite(storeKey: string, store: CronStoreFile): void {
  const normalizedStoreKey = cronStoreKey(storeKey);
  runOpenClawStateWriteTransaction((database) => {
    const db = getCronJobsKysely(database.db);
    const existingRows = executeSqliteQuerySync(
      database.db,
      db.selectFrom("cron_jobs").select("job_id").where("store_key", "=", normalizedStoreKey),
    ).rows;
    const nextJobIds = new Set(store.jobs.map((job) => job.id));
    for (const [index, job] of store.jobs.entries()) {
      executeSqliteQuerySync(
        database.db,
        db
          .insertInto("cron_jobs")
          .values(cronJobRow(storeKey, job, index))
          .onConflict((conflict) =>
            conflict.columns(["store_key", "job_id"]).doUpdateSet({
              job_json: JSON.stringify(stripRuntimeOnlyCronJobFields(job)),
              ...cronStateUpdateValues(job),
              sort_order: index,
              updated_at: Date.now(),
            }),
          ),
      );
    }
    for (const row of existingRows) {
      if (nextJobIds.has(row.job_id)) {
        continue;
      }
      executeSqliteQuerySync(
        database.db,
        db
          .deleteFrom("cron_jobs")
          .where("store_key", "=", normalizedStoreKey)
          .where("job_id", "=", row.job_id),
      );
    }
  });
}

export function writeCronJobsForMigration(storeKey: string, store: CronStoreFile): void {
  writeCronJobsToSqlite(storeKey, store);
}

function writeCronJobRuntimeStateToSqlite(storeKey: string, stateFile: CronStateFile): number {
  const normalizedStoreKey = cronStoreKey(storeKey);
  const updatedAt = Date.now();
  let importedJobs = 0;
  runOpenClawStateWriteTransaction((database) => {
    const db = getCronJobsKysely(database.db);
    for (const [jobId, entry] of Object.entries(stateFile.jobs)) {
      const result = executeSqliteQuerySync(
        database.db,
        db
          .updateTable("cron_jobs")
          .set({
            state_json: JSON.stringify(entry.state ?? {}),
            runtime_updated_at_ms:
              typeof entry.updatedAtMs === "number" && Number.isFinite(entry.updatedAtMs)
                ? entry.updatedAtMs
                : null,
            schedule_identity:
              typeof entry.scheduleIdentity === "string" ? entry.scheduleIdentity : null,
            updated_at: updatedAt,
          })
          .where("store_key", "=", normalizedStoreKey)
          .where("job_id", "=", jobId),
      );
      if ((result.numAffectedRows ?? 0n) > 0n) {
        importedJobs += 1;
      }
    }
  });
  return importedJobs;
}

export function writeCronJobRuntimeStateForMigration(
  storeKey: string,
  stateFile: CronStateFile,
): number {
  return writeCronJobRuntimeStateToSqlite(storeKey, stateFile);
}

export async function saveCronStore(
  storeKey: string,
  store: CronStoreFile,
  opts?: { skipBackup?: boolean; stateOnly?: boolean },
) {
  void opts?.skipBackup;
  if (opts?.stateOnly === true) {
    writeCronJobRuntimeStateToSqlite(storeKey, extractStateFile(store));
    return;
  }
  writeCronJobsToSqlite(storeKey, store);
}

export async function updateCronStoreJobs(
  storeKey: string,
  updateJob: (job: CronJob) => CronJob | undefined,
): Promise<{ updatedJobs: number }> {
  const store = await loadCronStore(storeKey);
  const updates: Array<{ previousJobId: string; job: CronJob; sortOrder: number }> = [];

  for (const [index, job] of store.jobs.entries()) {
    const nextJob = updateJob(structuredClone(job));
    if (!nextJob) {
      continue;
    }
    ensureJobStateObject(nextJob);
    updates.push({ previousJobId: job.id, job: nextJob, sortOrder: index });
  }

  if (updates.length === 0) {
    return { updatedJobs: 0 };
  }

  const normalizedStoreKey = cronStoreKey(storeKey);
  const updatedAt = Date.now();
  runOpenClawStateWriteTransaction((database) => {
    const db = getNodeSqliteKysely<CronStoreUpdateDatabase>(database.db);
    for (const update of updates) {
      if (update.previousJobId !== update.job.id) {
        executeSqliteQuerySync(
          database.db,
          db
            .deleteFrom("cron_jobs")
            .where("store_key", "=", normalizedStoreKey)
            .where("job_id", "=", update.previousJobId),
        );
      }
      executeSqliteQuerySync(
        database.db,
        db
          .insertInto("cron_jobs")
          .values(cronJobRow(storeKey, update.job, update.sortOrder))
          .onConflict((conflict) =>
            conflict.columns(["store_key", "job_id"]).doUpdateSet({
              job_json: JSON.stringify(stripRuntimeOnlyCronJobFields(update.job)),
              ...cronStateUpdateValues(update.job),
              sort_order: update.sortOrder,
              updated_at: updatedAt,
            }),
          ),
      );
    }
  });

  return { updatedJobs: updates.length };
}
