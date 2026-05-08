import fs from "node:fs";
import path from "node:path";
import type { Insertable } from "kysely";
import { expandHomePrefix } from "../infra/home-dir.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  readOpenClawStateKvJson,
  writeOpenClawStateKvJson,
  type OpenClawStateJsonValue,
} from "../state/openclaw-state-kv.js";
import { resolveConfigDir } from "../utils.js";
import { parseJsonWithJson5Fallback } from "../utils/parse-json-compat.js";
import { tryCronScheduleIdentity } from "./schedule-identity.js";
import type { CronJob, CronStoreFile } from "./types.js";

const CRON_STATE_KV_SCOPE = "cron.jobs.state";

type CronStateKvDatabase = Pick<OpenClawStateKyselyDatabase, "kv">;
type CronJobsTable = OpenClawStateKyselyDatabase["cron_jobs"];
type CronJobsDatabase = Pick<OpenClawStateKyselyDatabase, "cron_jobs">;

type CronJobRow = {
  job_id: string;
  job_json: string;
};

function resolveDefaultCronDir(): string {
  return path.join(resolveConfigDir(), "cron");
}

function resolveDefaultCronStorePath(): string {
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

function readStateDatabase(storePath: string): CronStateFile | null {
  const value = readOpenClawStateKvJson(CRON_STATE_KV_SCOPE, cronStoreKey(storePath));
  return normalizeCronStateFile(value);
}

function readStateDatabaseSync(storePath: string): CronStateFile | null {
  const database = openOpenClawStateDatabase();
  const row = executeSqliteQueryTakeFirstSync<{ value_json?: string }>(
    database.db,
    getNodeSqliteKysely<CronStateKvDatabase>(database.db)
      .selectFrom("kv")
      .select("value_json")
      .where("scope", "=", CRON_STATE_KV_SCOPE)
      .where("key", "=", cronStoreKey(storePath)),
  );
  if (typeof row?.value_json !== "string") {
    return null;
  }
  try {
    return normalizeCronStateFile(JSON.parse(row.value_json));
  } catch {
    return null;
  }
}

function writeStateDatabase(storePath: string, stateFile: CronStateFile) {
  writeOpenClawStateKvJson<OpenClawStateJsonValue>(
    CRON_STATE_KV_SCOPE,
    cronStoreKey(storePath),
    stateFile as unknown as OpenClawStateJsonValue,
  );
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

export function resolveCronStorePath(storePath?: string) {
  if (storePath?.trim()) {
    const raw = storePath.trim();
    if (raw.startsWith("~")) {
      return path.resolve(expandHomePrefix(raw));
    }
    return path.resolve(raw);
  }
  return resolveDefaultCronStorePath();
}

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
  writeStateDatabase(storePath, stateFile);
  try {
    await fs.promises.rm(statePath, { force: true });
  } catch {
    // Import already succeeded; a later doctor run can remove the stale sidecar.
  }
  return {
    imported: true,
    importedJobs: Object.keys(stateFile.jobs).length,
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
  writeStateDatabase(storePath, stateFile);
  writeCronJobsToSqlite(storePath, store);
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

function hydrateCronStoreFromSqlite(
  storePath: string,
  stateFile: CronStateFile | null,
): CronStoreFile {
  const database = openOpenClawStateDatabase();
  const rows = executeSqliteQuerySync<CronJobRow>(
    database.db,
    getCronJobsKysely(database.db)
      .selectFrom("cron_jobs")
      .select(["job_id", "job_json"])
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
    const entry = stateFile?.jobs[job.id];
    if (entry) {
      mergeStateFileEntry(job, entry);
    } else {
      backfillMissingRuntimeFields(job);
    }
    ensureJobStateObject(job);
  }
  return { version: 1, jobs };
}

export async function loadCronStore(storePath: string): Promise<CronStoreFile> {
  return hydrateCronStoreFromSqlite(storePath, readStateDatabase(storePath));
}

export function loadCronStoreSync(storePath: string): CronStoreFile {
  return hydrateCronStoreFromSqlite(storePath, readStateDatabaseSync(storePath));
}

function cronJobRow(storePath: string, job: CronJob, sortOrder: number): Insertable<CronJobsTable> {
  return {
    store_key: cronStoreKey(storePath),
    job_id: job.id,
    job_json: JSON.stringify(stripRuntimeOnlyCronJobFields(job)),
    sort_order: sortOrder,
    updated_at: Date.now(),
  };
}

function writeCronJobsToSqlite(storePath: string, store: CronStoreFile): void {
  const storeKey = cronStoreKey(storePath);
  runOpenClawStateWriteTransaction((database) => {
    const db = getCronJobsKysely(database.db);
    executeSqliteQuerySync(
      database.db,
      db.deleteFrom("cron_jobs").where("store_key", "=", storeKey),
    );
    for (const [index, job] of store.jobs.entries()) {
      executeSqliteQuerySync(
        database.db,
        db.insertInto("cron_jobs").values(cronJobRow(storePath, job, index)),
      );
    }
  });
}

export async function saveCronStore(
  storePath: string,
  store: CronStoreFile,
  opts?: { skipBackup?: boolean; stateOnly?: boolean },
) {
  void opts?.skipBackup;
  const stateFile = extractStateFile(store);
  writeStateDatabase(storePath, stateFile);
  if (opts?.stateOnly === true) {
    return;
  }
  writeCronJobsToSqlite(storePath, store);
}
