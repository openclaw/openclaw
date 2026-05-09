import fs from "node:fs";
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
import { parseJsonWithJson5Fallback } from "../utils/parse-json-compat.js";
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

function resolveDefaultCronDir(): string {
  return path.join(resolveConfigDir(), "cron");
}

function resolveDefaultCronStoreKey(): string {
  return path.join(resolveDefaultCronDir(), "jobs.json");
}

function resolveStatePath(storePath: string): string {
  if (storePath.endsWith(".json")) {
    return storePath.replace(/\.json$/, "-state.json");
  }
  return `${storePath}-state.json`;
}

type CronStateFileEntry = {
  updatedAtMs?: number;
  scheduleIdentity?: string;
  state?: Record<string, unknown>;
};

type CronStateFile = {
  version: 1;
  jobs: Record<string, CronStateFileEntry>;
};

function cronStoreKey(storePath: string): string {
  return path.resolve(storePath);
}

function getCronJobsKysely(db: import("node:sqlite").DatabaseSync) {
  return getNodeSqliteKysely<CronJobsDatabase>(db);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeCronStateFile(value: unknown): CronStateFile | null {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.jobs)) {
    return null;
  }
  const jobs: Record<string, CronStateFileEntry> = {};
  for (const [jobId, entry] of Object.entries(value.jobs)) {
    if (!isRecord(entry)) {
      continue;
    }
    const normalized: CronStateFileEntry = {};
    if (typeof entry.updatedAtMs === "number" && Number.isFinite(entry.updatedAtMs)) {
      normalized.updatedAtMs = entry.updatedAtMs;
    }
    if (typeof entry.scheduleIdentity === "string") {
      normalized.scheduleIdentity = entry.scheduleIdentity;
    }
    if (isRecord(entry.state)) {
      normalized.state = entry.state;
    }
    jobs[jobId] = normalized;
  }
  return { version: 1, jobs };
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

export function resolveCronStoreKey(configuredLegacyStorePath?: string) {
  if (configuredLegacyStorePath?.trim()) {
    const raw = configuredLegacyStorePath.trim();
    if (raw.startsWith("~")) {
      return path.resolve(expandHomePrefix(raw));
    }
    return path.resolve(raw);
  }
  return resolveDefaultCronStoreKey();
}

/**
 * @deprecated Use `resolveCronStoreKey`. The returned value is now a SQLite
 * partition key and legacy import namespace, not a runtime JSON store path.
 */
export const resolveCronStorePath = resolveCronStoreKey;

export function legacyCronStoreFileExists(storePath: string): boolean {
  try {
    return fs.existsSync(storePath);
  } catch {
    return false;
  }
}

export function legacyCronStateFileExists(storePath: string): boolean {
  try {
    return fs.existsSync(resolveStatePath(storePath));
  } catch {
    return false;
  }
}

async function loadStateFile(statePath: string): Promise<CronStateFile | null> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(statePath, "utf-8");
  } catch (err) {
    if ((err as { code?: unknown })?.code === "ENOENT") {
      return null;
    }
    throw new Error(`Failed to read cron state at ${statePath}: ${String(err)}`, {
      cause: err,
    });
  }

  try {
    const parsed = parseJsonWithJson5Fallback(raw);
    return normalizeCronStateFile(parsed);
  } catch {
    // Best-effort: if state file is corrupt, treat as absent.
    return null;
  }
}

export async function loadLegacyCronStoreForMigration(
  storePath: string,
): Promise<CronStoreFile | null> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(storePath, "utf-8");
  } catch (err) {
    if ((err as { code?: unknown })?.code === "ENOENT") {
      return null;
    }
    throw new Error(`Failed to read cron store at ${storePath}: ${String(err)}`, {
      cause: err,
    });
  }
  let parsed: unknown;
  try {
    parsed = parseJsonWithJson5Fallback(raw);
  } catch (err) {
    throw new Error(`Failed to parse cron store at ${storePath}: ${String(err)}`, {
      cause: err,
    });
  }
  const parsedRecord = isRecord(parsed) ? parsed : {};
  const jobs = Array.isArray(parsedRecord.jobs) ? (parsedRecord.jobs as never[]) : [];
  return {
    version: 1,
    jobs: jobs.filter(Boolean) as never as CronStoreFile["jobs"],
  };
}

export async function importLegacyCronStateFileToSqlite(storePath: string): Promise<{
  imported: boolean;
  importedJobs: number;
  removedPath?: string;
}> {
  const statePath = resolveStatePath(storePath);
  const stateFile = await loadStateFile(statePath);
  if (!stateFile) {
    return { imported: false, importedJobs: 0 };
  }
  const importedJobs = writeCronJobRuntimeStateToSqlite(storePath, stateFile);
  try {
    await fs.promises.rm(statePath, { force: true });
  } catch {
    // Import already succeeded; a later doctor run can remove the stale sidecar.
  }
  return {
    imported: true,
    importedJobs,
    removedPath: statePath,
  };
}

export async function importLegacyCronStoreToSqlite(storePath: string): Promise<{
  imported: boolean;
  importedJobs: number;
  removedPath?: string;
}> {
  const store = await loadLegacyCronStoreForMigration(storePath);
  if (!store) {
    return { imported: false, importedJobs: 0 };
  }
  const stateFile = (await loadStateFile(resolveStatePath(storePath))) ?? extractStateFile(store);
  writeCronJobsToSqlite(storePath, store);
  writeCronJobRuntimeStateToSqlite(storePath, stateFile);
  try {
    await fs.promises.rm(storePath, { force: true });
  } catch {
    // Import already succeeded; doctor can remove the stale source on the next pass.
  }
  return {
    imported: true,
    importedJobs: store.jobs.length,
    removedPath: storePath,
  };
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

function hydrateCronStoreFromSqlite(storePath: string): CronStoreFile {
  const database = openOpenClawStateDatabase();
  const rows = executeSqliteQuerySync(
    database.db,
    getCronJobsKysely(database.db)
      .selectFrom("cron_jobs")
      .select(["job_id", "job_json", "runtime_updated_at_ms", "schedule_identity", "state_json"])
      .where("store_key", "=", cronStoreKey(storePath))
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

export async function loadCronStore(storePath: string): Promise<CronStoreFile> {
  return hydrateCronStoreFromSqlite(storePath);
}

export function loadCronStoreSync(storePath: string): CronStoreFile {
  return hydrateCronStoreFromSqlite(storePath);
}

function cronJobRow(storePath: string, job: CronJob, sortOrder: number): Insertable<CronJobsTable> {
  const scheduleIdentity = tryCronScheduleIdentity(job as unknown as Record<string, unknown>);
  return {
    store_key: cronStoreKey(storePath),
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

function writeCronJobsToSqlite(storePath: string, store: CronStoreFile): void {
  const storeKey = cronStoreKey(storePath);
  runOpenClawStateWriteTransaction((database) => {
    const db = getCronJobsKysely(database.db);
    const existingRows = executeSqliteQuerySync(
      database.db,
      db.selectFrom("cron_jobs").select("job_id").where("store_key", "=", storeKey),
    ).rows;
    const nextJobIds = new Set(store.jobs.map((job) => job.id));
    for (const [index, job] of store.jobs.entries()) {
      executeSqliteQuerySync(
        database.db,
        db
          .insertInto("cron_jobs")
          .values(cronJobRow(storePath, job, index))
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
          .where("store_key", "=", storeKey)
          .where("job_id", "=", row.job_id),
      );
    }
  });
}

function writeCronJobRuntimeStateToSqlite(storePath: string, stateFile: CronStateFile): number {
  const storeKey = cronStoreKey(storePath);
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
          .where("store_key", "=", storeKey)
          .where("job_id", "=", jobId),
      );
      if ((result.numAffectedRows ?? 0n) > 0n) {
        importedJobs += 1;
      }
    }
  });
  return importedJobs;
}

export async function saveCronStore(
  storePath: string,
  store: CronStoreFile,
  opts?: { skipBackup?: boolean; stateOnly?: boolean },
) {
  void opts?.skipBackup;
  if (opts?.stateOnly === true) {
    writeCronJobRuntimeStateToSqlite(storePath, extractStateFile(store));
    return;
  }
  writeCronJobsToSqlite(storePath, store);
}

export async function updateCronStoreJobs(
  storePath: string,
  updateJob: (job: CronJob) => CronJob | undefined,
): Promise<{ updatedJobs: number }> {
  const store = await loadCronStore(storePath);
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

  const storeKey = cronStoreKey(storePath);
  const updatedAt = Date.now();
  runOpenClawStateWriteTransaction((database) => {
    const db = getNodeSqliteKysely<CronStoreUpdateDatabase>(database.db);
    for (const update of updates) {
      if (update.previousJobId !== update.job.id) {
        executeSqliteQuerySync(
          database.db,
          db
            .deleteFrom("cron_jobs")
            .where("store_key", "=", storeKey)
            .where("job_id", "=", update.previousJobId),
        );
      }
      executeSqliteQuerySync(
        database.db,
        db
          .insertInto("cron_jobs")
          .values(cronJobRow(storePath, update.job, update.sortOrder))
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
