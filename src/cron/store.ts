/** Public cron store load/save API backed by SQLite plus quarantine sidecars. */
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { expandHomePrefix } from "../infra/home-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { replaceFileAtomic } from "../infra/replace-file.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { resolveConfigDir } from "../utils.js";
import { parseJsonWithJson5Fallback } from "../utils/parse-json-compat.js";
import { readCronStoreStatePath } from "./store/config-state.js";
import { deleteStaleCronJobFamilyRows, type CronJobFamilyIdentity } from "./store/job-family.js";
import { cronStoreKey } from "./store/key.js";
import {
  assertCronStoreCanPersist,
  CronRuntimeRevisionMismatchError,
  CronStoreEpochMismatchError,
  CronStoreTopologyMismatchError,
  loadedCronStoreFromRows,
  loadCronRows,
  loadCronRowsWithEpoch,
  readCronRuntimeRevision,
  readCronStoreEpoch,
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
import type { CronJob, CronStoreFile } from "./types.js";

export {
  CronRuntimeRevisionMismatchError,
  CronStoreEpochMismatchError,
  CronStoreTopologyMismatchError,
};

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
export async function loadCronJobsStoreWithConfigJobs(
  storePath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LoadedCronStore> {
  const resolvedStorePath = path.resolve(storePath);
  const storeKey = cronStoreKey(resolvedStorePath);
  const database = openOpenClawStateDatabase({ env }).db;
  const { rows, storeEpoch, runtimeRevision } = loadCronRowsWithEpoch(database, storeKey);
  if (rows.length > 0) {
    return loadedCronStoreFromRows(rows, storeEpoch, runtimeRevision);
  }
  return {
    store: { version: 1, jobs: [] },
    topologyFingerprintByJobId: new Map(),
    storeEpoch,
    runtimeRevision,
    configJobs: [],
    configJobIndexes: [],
    legacyImportedJobIndexes: [],
    configJobRuntimeEntries: [],
    invalidConfigRows: [],
  };
}

/** Removes an owned declarative job family left under obsolete absolute store keys. */
export function removeStaleCronJobFamilyRows(
  storePath: string,
  family: CronJobFamilyIdentity,
): number {
  const activeStoreKey = cronStoreKey(path.resolve(storePath));
  return runOpenClawStateWriteTransaction(
    ({ db }) => deleteStaleCronJobFamilyRows(db, activeStoreKey, family),
    {},
    { operationLabel: "cron.job-family-adoption" },
  );
}

function emptyLoadedCronStore(storeEpoch = 0, runtimeRevision = 0): LoadedCronStore {
  return {
    store: { version: 1, jobs: [] },
    topologyFingerprintByJobId: new Map(),
    storeEpoch,
    runtimeRevision,
    configJobs: [],
    configJobIndexes: [],
    legacyImportedJobIndexes: [],
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
  const db = openNodeSqliteDatabase(statePath, { readOnly: true });
  try {
    if (!tableExists(db, "cron_jobs")) {
      return emptyLoadedCronStore();
    }
    const epochSchemaPresent = tableExists(db, "cron_store_epochs");
    const { rows, storeEpoch, runtimeRevision } = loadCronRowsWithEpoch(db, storeKey, {
      ensureEpochSchema: false,
      epochSchemaPresent,
    });
    if (rows.length > 0) {
      return loadedCronStoreFromRows(rows, storeEpoch, runtimeRevision);
    }
    return emptyLoadedCronStore(storeEpoch, runtimeRevision);
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
  env?: NodeJS.ProcessEnv;
  /** Reject a stale full-store writer instead of replacing newer topology. */
  expectedStoreEpoch?: number;
  /** Caller-loaded topology fingerprints that catch epoch-blind legacy writers. */
  expectedTopologyFingerprintByJobId?: ReadonlyMap<string, string>;
  /** Detect runtime writes committed since this snapshot was loaded. */
  expectedRuntimeRevision?: number;
  /** Per-job runtime baseline for distinguishing stale siblings from intentional writes. */
  expectedRuntimeStateByJobId?: ReadonlyMap<string, CronJob["state"] | undefined>;
  /** Per-job runtime timestamp baseline paired with expectedRuntimeStateByJobId. */
  expectedRuntimeUpdatedAtMsByJobId?: ReadonlyMap<string, number>;
  /** Advance the epoch when an ownership migration changes topology meaning. */
  bumpStoreEpoch?: boolean;
};

type SaveCronJobsStoreResult = {
  storeEpoch: number;
  runtimeRevision: number;
  runtimeMerged: boolean;
  store: CronStoreFile;
  topologyFingerprintByJobId: Map<string, string>;
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
): Promise<SaveCronJobsStoreResult | void> {
  const resolvedStorePath = path.resolve(storePath);
  const storeKey = cronStoreKey(resolvedStorePath);
  // Epoch/revision checks catch new-code writers; legacy writers are epoch-blind,
  // so every write path must compare against a caller-loaded baseline (topology
  // fingerprint + per-job runtime baselines) and preserve rows it did not intend to change.
  if (opts?.stateOnly) {
    // Hot-path timer updates only mutate runtime columns; full config JSON stays
    // untouched so user-authored cron definitions do not churn.
    const result = runOpenClawStateWriteTransaction(
      ({ db }) => {
        const storeEpoch = readCronStoreEpoch(db, storeKey);
        if (opts.expectedStoreEpoch !== undefined && opts.expectedStoreEpoch !== storeEpoch) {
          throw new CronStoreEpochMismatchError(opts.expectedStoreEpoch, storeEpoch);
        }
        const runtimeRevision = readCronRuntimeRevision(db, storeKey);
        const runtimeMerged =
          opts.expectedRuntimeRevision !== undefined &&
          opts.expectedRuntimeRevision !== runtimeRevision;
        const nextRuntimeRevision = updateCronRuntimeRows(db, storeKey, store, {
          expectedRuntimeRevision: opts.expectedRuntimeRevision,
          currentRuntimeRevision: runtimeRevision,
          expectedRuntimeStateByJobId: opts.expectedRuntimeStateByJobId,
          expectedRuntimeUpdatedAtMsByJobId: opts.expectedRuntimeUpdatedAtMsByJobId,
        });
        const loaded = loadedCronStoreFromRows(
          loadCronRows(db, storeKey),
          storeEpoch,
          nextRuntimeRevision,
        );
        return {
          storeEpoch,
          runtimeRevision: nextRuntimeRevision,
          runtimeMerged,
          store: loaded.store,
          topologyFingerprintByJobId: loaded.topologyFingerprintByJobId,
        };
      },
      { env: opts?.env },
    );
    // The service layer owns publication into reference-stable live jobs. Keep this
    // storage primitive side-effect free so it cannot detach timer-held job objects.
    return result;
  }
  assertCronStoreCanPersist(store);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const runtimeRevisionBeforeWrite = readCronRuntimeRevision(db, storeKey);
      const runtimeMerged =
        opts?.expectedRuntimeRevision !== undefined &&
        opts.expectedRuntimeRevision !== runtimeRevisionBeforeWrite;
      const storeEpoch = replaceCronRows(db, storeKey, store, {
        expectedStoreEpoch: opts?.expectedStoreEpoch,
        expectedTopologyFingerprintByJobId: opts?.expectedTopologyFingerprintByJobId,
        expectedRuntimeRevision: opts?.expectedRuntimeRevision,
        expectedRuntimeStateByJobId: opts?.expectedRuntimeStateByJobId,
        expectedRuntimeUpdatedAtMsByJobId: opts?.expectedRuntimeUpdatedAtMsByJobId,
        bumpStoreEpoch: opts?.bumpStoreEpoch ?? true,
      });
      const runtimeRevision = readCronRuntimeRevision(db, storeKey);
      const loaded = loadedCronStoreFromRows(
        loadCronRows(db, storeKey),
        storeEpoch,
        runtimeRevision,
      );
      return {
        storeEpoch,
        runtimeRevision,
        runtimeMerged,
        store: loaded.store,
        topologyFingerprintByJobId: loaded.topologyFingerprintByJobId,
      };
    },
    { env: opts?.env },
  );
}

/** Atomically acquire doctor migration metadata and replace cron rows only for the winner. */
export async function saveCronJobsStoreWithMetadata(
  storePath: string,
  store: CronStoreFile,
  acquireMetadata: (db: DatabaseSync) => boolean,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const resolvedStorePath = path.resolve(storePath);
  const storeKey = cronStoreKey(resolvedStorePath);
  assertCronStoreCanPersist(store);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      if (!acquireMetadata(db)) {
        return false;
      }
      replaceCronRows(db, storeKey, store, { bumpStoreEpoch: true });
      return true;
    },
    { env },
  );
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
    const raw = await fs.promises.readFile(pathLocal, "utf-8");
    const parsed = parseJsonWithJson5Fallback(raw);
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
  const existing = await loadCronQuarantineFile(quarantinePath);
  const seen = new Set(existing.jobs.map(quarantineEntryKey));
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
    nextJobs.push({
      quarantinedAtMs: params.nowMs,
      sourceIndex: entry.sourceIndex,
      reason: entry.reason,
      ...(entry.job ? { job: structuredClone(entry.job) } : {}),
      ...("raw" in entry ? { raw: structuredClone(entry.raw) } : {}),
      ...(entry.state ? { state: structuredClone(entry.state) } : {}),
      ...(entry.updatedAtMs !== undefined ? { updatedAtMs: entry.updatedAtMs } : {}),
      ...(entry.scheduleIdentity !== undefined ? { scheduleIdentity: entry.scheduleIdentity } : {}),
    });
  }
  if (!appended) {
    return quarantinePath;
  }
  const payload = JSON.stringify({ version: 1, jobs: nextJobs }, null, 2);
  await atomicWrite(quarantinePath, payload);
  return quarantinePath;
}
