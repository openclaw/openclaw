/** Public cron store load/save API backed by SQLite plus quarantine sidecars. */
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { expandHomePrefix } from "../infra/home-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { readRegularFile } from "../infra/regular-file.js";
import { replaceFileAtomic } from "../infra/replace-file.js";

// Cron quarantine sidecars are small JSON files; cap reads so a corrupted or
// hostile file cannot OOM the cron load path.
export const CRON_QUARANTINE_MAX_BYTES = 8 * 1024 * 1024;

/** Thrown when a persisted cron quarantine sidecar exceeds the bounded read cap. */
export class CronQuarantineOversizedError extends Error {
  override readonly name = "CronQuarantineOversizedError";
  readonly code = "CRON_QUARANTINE_OVERSIZED";
  constructor(
    readonly filePath: string,
    readonly maxBytes: number,
  ) {
    super(
      `Cron quarantine file at ${filePath} exceeds ${maxBytes} bytes; run openclaw doctor --fix to archive it.`,
    );
  }
}
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { resolveConfigDir } from "../utils.js";
import { parseJsonWithJson5Fallback } from "../utils/parse-json-compat.js";
import { readCronStoreStatePath } from "./store/config-state.js";
import { cronStoreKey } from "./store/key.js";
import {
  assertCronStoreCanPersist,
  loadedCronStoreFromRows,
  loadCronRows,
  replaceCronRows,
  updateCronRuntimeRows,
} from "./store/row-codec.js";
import type {
  CronQuarantineFile,
  LoadedCronStore,
  QuarantinedCronConfigJob,
} from "./store/types.js";
export type {
  CronConfigJobRuntimeEntry,
  LoadedCronStore,
  QuarantinedCronConfigJob,
} from "./store/types.js";
import type { CronStoreFile } from "./types.js";

function resolveDefaultCronDir(env: NodeJS.ProcessEnv): string {
  return path.join(resolveConfigDir(env), "cron");
}

function resolveDefaultCronStorePath(env: NodeJS.ProcessEnv): string {
  return path.join(resolveDefaultCronDir(env), "jobs.json");
}

/** Resolves the sidecar quarantine path used for invalid cron config rows. */
export function resolveCronQuarantinePath(storePath: string): string {
  if (storePath.endsWith(".json")) {
    return storePath.replace(/\.json$/, "-quarantine.json");
  }
  return `${storePath}-quarantine.json`;
}

/** Resolves the cron jobs store path, expanding home-relative user input. */
export function resolveCronJobsStorePath(storePath?: string, env: NodeJS.ProcessEnv = process.env) {
  const selected = storePath?.trim() || readCronStoreStatePath(env);
  if (selected) {
    const raw = selected.trim();
    if (raw.startsWith("~")) {
      return path.resolve(expandHomePrefix(raw, { env }));
    }
    return path.resolve(raw);
  }
  return resolveDefaultCronStorePath(env);
}

/** Resolves the active cron partition from runtime config and environment. */
export function resolveCronJobsStorePathFromConfig(
  cfg: { cron?: unknown },
  env: NodeJS.ProcessEnv = process.env,
): string {
  const store = (cfg.cron as { store?: unknown } | undefined)?.store;
  return resolveCronJobsStorePath(typeof store === "string" ? store : undefined, env);
}

/** Loads cron jobs plus config/runtime sidecars from the SQLite-backed store. */
export async function loadCronJobsStoreWithConfigJobs(storePath: string): Promise<LoadedCronStore> {
  const resolvedStorePath = path.resolve(storePath);
  const storeKey = cronStoreKey(resolvedStorePath);
  const database = openOpenClawStateDatabase().db;
  const rows = loadCronRows(database, storeKey);
  if (rows.length > 0) {
    return loadedCronStoreFromRows(rows);
  }
  return {
    store: { version: 1, jobs: [] },
    configJobs: [],
    configJobIndexes: [],
    configJobRuntimeEntries: [],
    invalidConfigRows: [],
  };
}

function emptyLoadedCronStore(): LoadedCronStore {
  return {
    store: { version: 1, jobs: [] },
    configJobs: [],
    configJobIndexes: [],
    configJobRuntimeEntries: [],
    invalidConfigRows: [],
  };
}

function tableExists(db: DatabaseSync, tableName: string): boolean {
  return (
    db
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName) !== undefined
  );
}

/** Loads cron jobs from an existing SQLite store without creating or migrating state. */
export async function loadCronJobsStoreWithConfigJobsReadOnly(
  storePath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LoadedCronStore> {
  const statePath = resolveOpenClawStateSqlitePath(env);
  if (!fs.existsSync(statePath)) {
    return emptyLoadedCronStore();
  }
  const resolvedStorePath = path.resolve(storePath);
  const storeKey = cronStoreKey(resolvedStorePath);
  const sqlite = requireNodeSqlite();
  const db = new sqlite.DatabaseSync(statePath, { readOnly: true });
  try {
    if (!tableExists(db, "cron_jobs")) {
      return emptyLoadedCronStore();
    }
    const rows = loadCronRows(db, storeKey);
    if (rows.length > 0) {
      return loadedCronStoreFromRows(rows);
    }
    return emptyLoadedCronStore();
  } finally {
    db.close();
  }
}

/** Loads only the persisted cron job store payload. */
export async function loadCronJobsStore(storePath: string): Promise<CronStoreFile> {
  return (await loadCronJobsStoreWithConfigJobs(storePath)).store;
}

/** Synchronously loads only the persisted cron job store payload. */
export function loadCronJobsStoreSync(storePath: string): CronStoreFile {
  const resolvedStorePath = path.resolve(storePath);
  const storeKey = cronStoreKey(resolvedStorePath);
  const database = openOpenClawStateDatabase().db;
  const rows = loadCronRows(database, storeKey);
  if (rows.length > 0) {
    return loadedCronStoreFromRows(rows).store;
  }
  return { version: 1, jobs: [] };
}

type SaveCronStoreOptions = {
  stateOnly?: boolean;
};

async function atomicWrite(filePath: string, content: string, dirMode = 0o700): Promise<void> {
  await replaceFileAtomic({
    filePath,
    content,
    dirMode,
    mode: 0o600,
    tempPrefix: ".openclaw-cron",
    renameMaxRetries: 3,
    copyFallbackOnPermissionError: true,
  });
}

/** Persists cron jobs, or only mutable runtime state when stateOnly is set. */
export async function saveCronJobsStore(
  storePath: string,
  store: CronStoreFile,
  opts?: SaveCronStoreOptions,
) {
  const resolvedStorePath = path.resolve(storePath);
  const storeKey = cronStoreKey(resolvedStorePath);
  if (opts?.stateOnly) {
    // Hot-path timer updates only mutate runtime columns; full config JSON stays
    // untouched so user-authored cron definitions do not churn.
    runOpenClawStateWriteTransaction(({ db }) => {
      updateCronRuntimeRows(db, storeKey, store);
    });
    return;
  }
  assertCronStoreCanPersist(store);
  runOpenClawStateWriteTransaction(({ db }) => {
    replaceCronRows(db, storeKey, store);
  });
}

/** Atomically acquire doctor migration metadata and replace cron rows only for the winner. */
export async function saveCronJobsStoreWithMetadata(
  storePath: string,
  store: CronStoreFile,
  acquireMetadata: (db: DatabaseSync) => boolean,
): Promise<boolean> {
  const resolvedStorePath = path.resolve(storePath);
  const storeKey = cronStoreKey(resolvedStorePath);
  assertCronStoreCanPersist(store);
  return runOpenClawStateWriteTransaction(({ db }) => {
    if (!acquireMetadata(db)) {
      return false;
    }
    replaceCronRows(db, storeKey, store);
    return true;
  });
}

// Public plugin SDK seam; core callers use the SQLite-backed cron-jobs names above.
/** Resolves the public plugin-SDK cron store path. */
export function resolveCronStorePath(storePath?: string) {
  return resolveCronJobsStorePath(storePath);
}

/** Plugin-SDK alias for loading the cron store. */
export async function loadCronStore(storePath: string): Promise<CronStoreFile> {
  return await loadCronJobsStore(storePath);
}

/** Plugin-SDK alias for saving the cron store. */
export async function saveCronStore(
  storePath: string,
  store: CronStoreFile,
  opts?: SaveCronStoreOptions,
) {
  await saveCronJobsStore(storePath, store, opts);
}

/** Loads the cron quarantine sidecar, validating its persisted v1 shape. */
export async function loadCronQuarantineFile(pathLocal: string): Promise<CronQuarantineFile> {
  try {
    const { buffer } = await readRegularFile({
      filePath: pathLocal,
      maxBytes: CRON_QUARANTINE_MAX_BYTES,
    });
    const parsed = parseJsonWithJson5Fallback(buffer.toString("utf-8"));
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.jobs)) {
      throw new Error(`Unsupported cron quarantine file shape at ${pathLocal}`);
    }
    const jobs = parsed.jobs.map((entry, index) => {
      if (
        !isRecord(entry) ||
        typeof entry.reason !== "string" ||
        (!isRecord(entry.job) && !("raw" in entry))
      ) {
        throw new Error(`Unsupported cron quarantine entry at ${pathLocal} index ${index}`);
      }
      const sourceIndex = typeof entry.sourceIndex === "number" ? entry.sourceIndex : -1;
      const quarantinedAtMs =
        typeof entry.quarantinedAtMs === "number" && Number.isFinite(entry.quarantinedAtMs)
          ? entry.quarantinedAtMs
          : Date.now();
      const quarantined: CronQuarantineFile["jobs"][number] = {
        quarantinedAtMs,
        sourceIndex,
        reason: entry.reason,
      };
      if (isRecord(entry.job)) {
        quarantined.job = entry.job;
      }
      if ("raw" in entry) {
        quarantined.raw = entry.raw;
      }
      if (isRecord(entry.state)) {
        quarantined.state = entry.state;
      }
      if (typeof entry.updatedAtMs === "number" && Number.isFinite(entry.updatedAtMs)) {
        quarantined.updatedAtMs = entry.updatedAtMs;
      }
      if (typeof entry.scheduleIdentity === "string") {
        quarantined.scheduleIdentity = entry.scheduleIdentity;
      }
      return quarantined;
    });
    return { version: 1, jobs };
  } catch (err) {
    if ((err as { code?: unknown })?.code === "ENOENT") {
      return { version: 1, jobs: [] };
    }
    if (err instanceof Error && err.message.includes("exceeds")) {
      throw new CronQuarantineOversizedError(pathLocal, CRON_QUARANTINE_MAX_BYTES);
    }
    throw err;
  }
}

function buildQuarantineJobEntry(
  entry: QuarantinedCronConfigJob,
  nowMs: number,
): CronQuarantineFile["jobs"][number] {
  const result: CronQuarantineFile["jobs"][number] = {
    quarantinedAtMs: nowMs,
    sourceIndex: entry.sourceIndex,
    reason: entry.reason,
  };
  if (entry.job) {
    result.job = structuredClone(entry.job);
  }
  if ("raw" in entry) {
    result.raw = structuredClone(entry.raw);
  }
  if (entry.state) {
    result.state = structuredClone(entry.state);
  }
  if (entry.updatedAtMs !== undefined) {
    result.updatedAtMs = entry.updatedAtMs;
  }
  if (entry.scheduleIdentity !== undefined) {
    result.scheduleIdentity = entry.scheduleIdentity;
  }
  return result;
}

function quarantineEntryKey(entry: QuarantinedCronConfigJob): string {
  const rawId = entry.job
    ? (normalizeOptionalString(entry.job.id) ?? normalizeOptionalString(entry.job.jobId))
    : null;
  return JSON.stringify({
    id: rawId ?? null,
    sourceIndex: entry.sourceIndex,
    reason: entry.reason,
    job: entry.job ?? null,
    raw: entry.raw ?? null,
    state: entry.state ?? null,
    updatedAtMs: entry.updatedAtMs ?? null,
    scheduleIdentity: entry.scheduleIdentity ?? null,
  });
}

/** Appends new invalid cron config rows to the quarantine sidecar without duplicating entries. */
export async function saveCronQuarantineFile(params: {
  storePath: string;
  entries: QuarantinedCronConfigJob[];
  nowMs: number;
}) {
  if (params.entries.length === 0) {
    return null;
  }
  const quarantinePath = resolveCronQuarantinePath(params.storePath);

  // Load existing quarantine entries for deduplication. A missing file starts
  // with empty state; an oversized sidecar is a legacy-data migration issue
  // that must be resolved with `openclaw doctor --fix` rather than silently
  // discarded here.
  const existing = await loadCronQuarantineFile(quarantinePath);
  const existingKeys = new Set(existing.jobs.map(quarantineEntryKey));

  const seen = new Set(existingKeys);
  const nextJobs = existing.jobs.slice();
  let appended = false;
  for (const entry of params.entries.toSorted((a, b) => a.sourceIndex - b.sourceIndex)) {
    const key = quarantineEntryKey(entry);
    if (seen.has(key)) {
      continue;
    }
    // Deduplicate by the original invalid row shape so repeated loads do not
    // keep appending the same quarantined config job.
    seen.add(key);
    appended = true;
    nextJobs.push(buildQuarantineJobEntry(entry, params.nowMs));
  }
  if (!appended) {
    return quarantinePath;
  }
  const payload = JSON.stringify({ version: 1, jobs: nextJobs }, null, 2);
  if (Buffer.byteLength(payload, "utf-8") > CRON_QUARANTINE_MAX_BYTES) {
    throw new Error(`Cron quarantine file exceeds ${CRON_QUARANTINE_MAX_BYTES} bytes`);
  }
  await atomicWrite(quarantinePath, payload);
  return quarantinePath;
}
