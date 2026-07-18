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
const CRON_QUARANTINE_MAX_BYTES = 8 * 1024 * 1024;
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { resolveConfigDir } from "../utils.js";
import { parseJsonWithJson5Fallback } from "../utils/parse-json-compat.js";
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
  if (storePath?.trim()) {
    const raw = storePath.trim();
    if (raw.startsWith("~")) {
      return path.resolve(expandHomePrefix(raw, { env }));
    }
    return path.resolve(raw);
  }
  return resolveDefaultCronStorePath(env);
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
): Promise<LoadedCronStore> {
  const statePath = resolveOpenClawStateSqlitePath(process.env);
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

  // If the existing sidecar is already over the byte cap, we cannot safely
  // load it for deduplication. Archive it and start fresh with the new entries.
  let existing: CronQuarantineFile = { version: 1, jobs: [] };
  let existingKeys = new Set<string>();
  const existingStat = await fs.promises.stat(quarantinePath).catch((err: unknown) => {
    if ((err as { code?: unknown })?.code === "ENOENT") {
      return null;
    }
    throw err;
  });
  if (existingStat && existingStat.size > CRON_QUARANTINE_MAX_BYTES) {
    await archiveQuarantineFile(quarantinePath);
  } else {
    existing = await loadCronQuarantineFile(quarantinePath);
    existingKeys = new Set(existing.jobs.map(quarantineEntryKey));
  }

  const seen = new Set(existingKeys);
  const nextJobs = existing.jobs.slice();
  const appendedEntries: QuarantinedCronConfigJob[] = [];
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
    appendedEntries.push(entry);
    nextJobs.push(buildQuarantineJobEntry(entry, params.nowMs));
  }
  if (!appended) {
    return quarantinePath;
  }
  const payload = JSON.stringify({ version: 1, jobs: nextJobs }, null, 2);
  if (Buffer.byteLength(payload, "utf-8") > CRON_QUARANTINE_MAX_BYTES) {
    // The sidecar has grown past the cap. Archive the existing file so the
    // canonical SQLite cron store can still persist, then start a fresh
    // quarantine file containing only the new entries. This prevents a
    // cap-saturated sidecar from blocking every subsequent cron mutation.
    await archiveQuarantineFile(quarantinePath);
    const freshJobs = appendedEntries.map((entry) => buildQuarantineJobEntry(entry, params.nowMs));
    const freshPayload = JSON.stringify({ version: 1, jobs: freshJobs }, null, 2);
    if (Buffer.byteLength(freshPayload, "utf-8") > CRON_QUARANTINE_MAX_BYTES) {
      throw new Error(`Cron quarantine file exceeds ${CRON_QUARANTINE_MAX_BYTES} bytes`);
    }
    await atomicWrite(quarantinePath, freshPayload);
    return quarantinePath;
  }
  await atomicWrite(quarantinePath, payload);
  return quarantinePath;
}

async function archiveQuarantineFile(quarantinePath: string): Promise<void> {
  try {
    await fs.promises.access(quarantinePath);
  } catch {
    // Nothing to archive.
    return;
  }
  const archivePath = `${quarantinePath}.${Date.now()}.${Math.random().toString(36).slice(2)}.archive.json`;
  await fs.promises.rename(quarantinePath, archivePath);
}

/** Lists quarantine archive files for the given sidecar path, sorted oldest first. */
async function listQuarantineArchives(
  quarantinePath: string,
): Promise<Array<{ name: string; ts: number }>> {
  const dir = path.dirname(quarantinePath);
  const base = path.basename(quarantinePath);
  const prefix = `${base}.`;
  const suffix = ".archive.json";
  const entries: Array<{ name: string; ts: number }> = [];
  try {
    const names = await fs.promises.readdir(dir);
    for (const name of names) {
      if (name.startsWith(prefix) && name.endsWith(suffix)) {
        // Filename: {base}.{ts}.{random}.archive.json — extract the timestamp
        // part between the base prefix and the next dot.
        const afterPrefix = name.slice(prefix.length);
        const dotIdx = afterPrefix.indexOf(".");
        if (dotIdx === -1) {
          continue;
        }
        const tsStr = afterPrefix.slice(0, dotIdx);
        const ts = Number(tsStr);
        if (Number.isFinite(ts)) {
          entries.push({ name, ts });
        }
      }
    }
  } catch {
    return [];
  }
  entries.sort((a, b) => a.ts - b.ts);
  return entries;
}
