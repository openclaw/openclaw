import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { acquireSessionWriteLock } from "../../agents/session-write-lock.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import {
  archiveSessionTranscripts,
  cleanupArchivedSessionTranscripts,
} from "../../gateway/session-utils.fs.js";
import { writeTextAtomic } from "../../infra/json-files.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  deliveryContextFromSession,
  mergeDeliveryContext,
  normalizeDeliveryContext,
  normalizeSessionDeliveryFields,
  type DeliveryContext,
} from "../../utils/delivery-context.js";
import { getFileStatSnapshot, isCacheEnabled, resolveCacheTtlMs } from "../cache-utils.js";
import { enforceSessionDiskBudget, type SessionDiskBudgetSweepResult } from "./disk-budget.js";
import { deriveSessionMetaPatch } from "./metadata.js";
import {
  clearSessionStoreCaches,
  dropSessionStoreObjectCache,
  getSerializedSessionStore,
  invalidateSessionStoreCache,
  readSessionStoreCache,
  setSerializedSessionStore,
  writeSessionStoreCache,
} from "./store-cache.js";
import {
  capEntryCount,
  getActiveSessionMaintenanceWarning,
  pruneStaleEntries,
  resolveMaintenanceConfig,
  rotateSessionFile,
  type ResolvedSessionMaintenanceConfig,
  type SessionMaintenanceWarning,
} from "./store-maintenance.js";
import { applySessionStoreMigrations } from "./store-migrations.js";
import {
  mergeSessionEntry,
  mergeSessionEntryPreserveActivity,
  normalizeSessionRuntimeModelFields,
  type SessionEntry,
} from "./types.js";

const log = createSubsystemLogger("sessions/store");

// ============================================================================
// Directory-per-session store
// ============================================================================

/** Sibling directory name for the per-session store layout. */
const DIR_STORE_NAME = "sessions.d";

/**
 * Derive the directory store path from a legacy storePath (e.g. `sessions.json`).
 * The directory store lives as a sibling `sessions.d/` directory.
 */
export function resolveSessionStoreDir(storePath: string): string {
  return path.join(path.dirname(storePath), DIR_STORE_NAME);
}

/**
 * Sanitize a session key for safe use as a filesystem name.
 * Colons, slashes, and backslashes are percent-encoded to prevent path traversal.
 */
export function sanitizeSessionKey(key: string): string {
  return key.replace(/%/g, "%25").replace(/\//g, "%2F").replace(/\\/g, "%5C").replace(/:/g, "%3A");
}

/** Reverse the sanitization to recover the original session key. */
export function desanitizeSessionKey(fileName: string): string {
  return fileName
    .replace(/%3A/g, ":")
    .replace(/%5C/g, "\\")
    .replace(/%2F/g, "/")
    .replace(/%25/g, "%");
}

/** Check whether a directory-based session store exists. */
function isDirectoryStore(storePath: string): boolean {
  try {
    return fs.statSync(resolveSessionStoreDir(storePath)).isDirectory();
  } catch {
    return false;
  }
}

/** Read a single session entry from the directory store. */
function loadSessionEntryFromDir(storeDir: string, fileName: string): SessionEntry | null {
  const filePath = path.join(storeDir, fileName);
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    if (!raw || raw.length === 0) {
      return null;
    }
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as SessionEntry;
    }
    return null;
  } catch {
    return null;
  }
}

/** Load all session entries from the directory store. */
function loadSessionStoreFromDir(storeDir: string): Record<string, SessionEntry> {
  const store: Record<string, SessionEntry> = {};
  let entries: string[];
  try {
    entries = fs.readdirSync(storeDir);
  } catch {
    return store;
  }
  for (const fileName of entries) {
    if (!fileName.endsWith(".json") || fileName.startsWith(".")) {
      continue;
    }
    const sessionKey = desanitizeSessionKey(fileName.slice(0, -5));
    const entry = loadSessionEntryFromDir(storeDir, fileName);
    if (entry) {
      store[sessionKey] = entry;
    }
  }
  return store;
}

/** Write a single session entry to the directory store atomically. */
async function writeSessionEntryToDir(
  storeDir: string,
  sessionKey: string,
  entry: SessionEntry,
): Promise<void> {
  const fileName = `${sanitizeSessionKey(sessionKey)}.json`;
  const filePath = path.join(storeDir, fileName);
  const json = JSON.stringify(entry, null, 2);
  const tmp = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.promises.mkdir(storeDir, { recursive: true });
  try {
    await fs.promises.writeFile(tmp, json, { mode: 0o600, encoding: "utf-8" });
    await fs.promises.rename(tmp, filePath);
    if (process.platform !== "win32") {
      await fs.promises.chmod(filePath, 0o600).catch(() => undefined);
    }
  } catch (err) {
    if (getErrorCode(err) === "ENOENT") {
      // Parent dir may have been removed (e.g. in tests). Best-effort retry.
      try {
        await fs.promises.mkdir(storeDir, { recursive: true });
        await fs.promises.writeFile(filePath, json, { mode: 0o600, encoding: "utf-8" });
      } catch {
        // Ignore
      }
      return;
    }
    throw err;
  } finally {
    await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
  }
}

/** Delete a single session entry from the directory store. */
async function deleteSessionEntryFromDir(storeDir: string, sessionKey: string): Promise<void> {
  const fileName = `${sanitizeSessionKey(sessionKey)}.json`;
  try {
    await fs.promises.unlink(path.join(storeDir, fileName));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}

/**
 * Compute which session keys changed or were removed between snapshots.
 */
function computeStoreDiff(
  previous: Record<string, SessionEntry>,
  current: Record<string, SessionEntry>,
): { changed: string[]; removed: string[] } {
  const changed: string[] = [];
  const removed: string[] = [];
  for (const key of Object.keys(current)) {
    const prev = previous[key];
    const curr = current[key];
    if (!prev || JSON.stringify(prev) !== JSON.stringify(curr)) {
      changed.push(key);
    }
  }
  for (const key of Object.keys(previous)) {
    if (!(key in current)) {
      removed.push(key);
    }
  }
  return { changed, removed };
}

/**
 * Migrate a legacy JSON session store to directory-per-session layout.
 * Safe to call multiple times — no-ops if already migrated or no JSON exists.
 */
export async function migrateSessionStoreToDirectory(storePath: string): Promise<boolean> {
  return await withSessionStoreLock(storePath, async () => {
    let legacyExists = false;
    try {
      legacyExists = fs.statSync(storePath).isFile();
    } catch {
      // No legacy file — nothing to migrate
    }
    if (!legacyExists) {
      return false;
    }

    let store: Record<string, SessionEntry> = {};
    try {
      const raw = fs.readFileSync(storePath, "utf-8");
      if (raw.length === 0) {
        return false;
      }
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        store = parsed as Record<string, SessionEntry>;
      }
    } catch {
      return false;
    }

    const keys = Object.keys(store);
    if (keys.length === 0) {
      return false;
    }

    const storeDir = resolveSessionStoreDir(storePath);
    const dirAlreadyExists = isDirectoryStore(storePath);
    log.info("migrating session store from JSON to directory layout", {
      entries: keys.length,
      storeDir,
      merge: dirAlreadyExists,
    });

    // Deduplicate case-variant keys: multiple legacy keys may normalize to the
    // same key (e.g. "Foo" and "foo").  Keep the entry with the newest updatedAt.
    const deduped = new Map<string, SessionEntry>();
    for (const [key, entry] of Object.entries(store)) {
      if (!entry) {
        continue;
      }
      const normalizedKey = normalizeStoreSessionKey(key);
      const prev = deduped.get(normalizedKey);
      if (!prev || (entry.updatedAt ?? 0) > (prev.updatedAt ?? 0)) {
        deduped.set(normalizedKey, entry);
      }
    }

    // For fresh migrations, write to a staging directory and atomically rename
    // so a partial failure (ENOSPC/EIO) doesn't activate a half-migrated store.
    // For merge migrations (dir already exists), write directly into the live dir.
    const writeDir = dirAlreadyExists ? storeDir : `${storeDir}.migrating`;
    if (!dirAlreadyExists) {
      await fs.promises.rm(writeDir, { recursive: true, force: true });
    }
    await fs.promises.mkdir(writeDir, { recursive: true });

    let migratedCount = 0;
    for (const [normalizedKey, entry] of deduped) {
      if (dirAlreadyExists) {
        const existing = loadSessionEntryFromDir(
          storeDir,
          `${sanitizeSessionKey(normalizedKey)}.json`,
        );
        if (existing) {
          continue;
        }
      }
      await writeSessionEntryToDir(writeDir, normalizedKey, entry);
      migratedCount++;
    }

    // Atomically activate the directory store for fresh migrations.
    if (!dirAlreadyExists) {
      await fs.promises.rename(writeDir, storeDir);
    }

    if (dirAlreadyExists) {
      log.info("merged legacy entries into existing directory store", {
        merged: migratedCount,
        skipped: keys.length - migratedCount,
      });
    }

    // Backup and remove the old JSON file
    const backupPath = `${storePath}.bak.${Date.now()}`;
    try {
      await fs.promises.rename(storePath, backupPath);
      log.info("backed up legacy sessions.json", { backupPath: path.basename(backupPath) });
    } catch {
      // If rename fails, directory store takes precedence anyway.
    }
    return true;
  });
}

// ============================================================================
// Session Store Cache with TTL Support
// ============================================================================

const DEFAULT_SESSION_STORE_TTL_MS = 45_000; // 45 seconds (between 30-60s)

function isSessionStoreRecord(value: unknown): value is Record<string, SessionEntry> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function getSessionStoreTtl(): number {
  return resolveCacheTtlMs({
    envValue: process.env.OPENCLAW_SESSION_CACHE_TTL_MS,
    defaultTtlMs: DEFAULT_SESSION_STORE_TTL_MS,
  });
}

function isSessionStoreCacheEnabled(): boolean {
  return isCacheEnabled(getSessionStoreTtl());
}

function normalizeSessionEntryDelivery(entry: SessionEntry): SessionEntry {
  const normalized = normalizeSessionDeliveryFields({
    channel: entry.channel,
    lastChannel: entry.lastChannel,
    lastTo: entry.lastTo,
    lastAccountId: entry.lastAccountId,
    lastThreadId: entry.lastThreadId ?? entry.deliveryContext?.threadId ?? entry.origin?.threadId,
    deliveryContext: entry.deliveryContext,
  });
  const nextDelivery = normalized.deliveryContext;
  const sameDelivery =
    (entry.deliveryContext?.channel ?? undefined) === nextDelivery?.channel &&
    (entry.deliveryContext?.to ?? undefined) === nextDelivery?.to &&
    (entry.deliveryContext?.accountId ?? undefined) === nextDelivery?.accountId &&
    (entry.deliveryContext?.threadId ?? undefined) === nextDelivery?.threadId;
  const sameLast =
    entry.lastChannel === normalized.lastChannel &&
    entry.lastTo === normalized.lastTo &&
    entry.lastAccountId === normalized.lastAccountId &&
    entry.lastThreadId === normalized.lastThreadId;
  if (sameDelivery && sameLast) {
    return entry;
  }
  return {
    ...entry,
    deliveryContext: nextDelivery,
    lastChannel: normalized.lastChannel,
    lastTo: normalized.lastTo,
    lastAccountId: normalized.lastAccountId,
    lastThreadId: normalized.lastThreadId,
  };
}

function removeThreadFromDeliveryContext(context?: DeliveryContext): DeliveryContext | undefined {
  if (!context || context.threadId == null) {
    return context;
  }
  const next: DeliveryContext = { ...context };
  delete next.threadId;
  return next;
}

export function normalizeStoreSessionKey(sessionKey: string): string {
  return sessionKey.trim().toLowerCase();
}

export function resolveSessionStoreEntry(params: {
  store: Record<string, SessionEntry>;
  sessionKey: string;
}): {
  normalizedKey: string;
  existing: SessionEntry | undefined;
  legacyKeys: string[];
} {
  const trimmedKey = params.sessionKey.trim();
  const normalizedKey = normalizeStoreSessionKey(trimmedKey);
  const legacyKeySet = new Set<string>();
  if (
    trimmedKey !== normalizedKey &&
    Object.prototype.hasOwnProperty.call(params.store, trimmedKey)
  ) {
    legacyKeySet.add(trimmedKey);
  }
  let existing =
    params.store[normalizedKey] ?? (legacyKeySet.size > 0 ? params.store[trimmedKey] : undefined);
  let existingUpdatedAt = existing?.updatedAt ?? 0;
  for (const [candidateKey, candidateEntry] of Object.entries(params.store)) {
    if (candidateKey === normalizedKey) {
      continue;
    }
    if (candidateKey.toLowerCase() !== normalizedKey) {
      continue;
    }
    legacyKeySet.add(candidateKey);
    const candidateUpdatedAt = candidateEntry?.updatedAt ?? 0;
    if (!existing || candidateUpdatedAt > existingUpdatedAt) {
      existing = candidateEntry;
      existingUpdatedAt = candidateUpdatedAt;
    }
  }
  return {
    normalizedKey,
    existing,
    legacyKeys: [...legacyKeySet],
  };
}

function normalizeSessionStore(store: Record<string, SessionEntry>): void {
  for (const [key, entry] of Object.entries(store)) {
    if (!entry) {
      continue;
    }
    const normalized = normalizeSessionEntryDelivery(normalizeSessionRuntimeModelFields(entry));
    if (normalized !== entry) {
      store[key] = normalized;
    }
  }
}

export function clearSessionStoreCacheForTest(): void {
  clearSessionStoreCaches();
  for (const queue of LOCK_QUEUES.values()) {
    for (const task of queue.pending) {
      task.reject(new Error("session store queue cleared for test"));
    }
  }
  LOCK_QUEUES.clear();
}

/** Expose lock queue size for tests. */
export function getSessionStoreLockQueueSizeForTest(): number {
  return LOCK_QUEUES.size;
}

export async function withSessionStoreLockForTest<T>(
  storePath: string,
  fn: () => Promise<T>,
  opts: SessionStoreLockOptions = {},
): Promise<T> {
  return await withSessionStoreLock(storePath, fn, opts);
}

type LoadSessionStoreOptions = {
  skipCache?: boolean;
};

export function loadSessionStore(
  storePath: string,
  opts: LoadSessionStoreOptions = {},
): Record<string, SessionEntry> {
  const useDirectory = isDirectoryStore(storePath);

  // Check cache first if enabled (TTL-based only for directory mode)
  if (!opts.skipCache && isSessionStoreCacheEnabled()) {
    if (useDirectory) {
      const cached = readSessionStoreCache({
        storePath,
        ttlMs: getSessionStoreTtl(),
        // Directory mode: skip mtime/size checks — rely on TTL only.
        // Individual file mtimes don't propagate to directory mtime reliably.
        mtimeMs: undefined,
        sizeBytes: undefined,
      });
      if (cached) {
        return cached;
      }
    } else {
      const currentFileStat = getFileStatSnapshot(storePath);
      const cached = readSessionStoreCache({
        storePath,
        ttlMs: getSessionStoreTtl(),
        mtimeMs: currentFileStat?.mtimeMs,
        sizeBytes: currentFileStat?.sizeBytes,
      });
      if (cached) {
        return cached;
      }
    }
  }

  let store: Record<string, SessionEntry>;
  let fileStat: ReturnType<typeof getFileStatSnapshot> = undefined;
  let serializedFromDisk: string | undefined;

  if (useDirectory) {
    const storeDir = resolveSessionStoreDir(storePath);
    store = loadSessionStoreFromDir(storeDir);
    // No serialized cache for directory mode — individual files don't map to a single JSON blob.
    setSerializedSessionStore(storePath, undefined);
  } else {
    // Legacy JSON file mode.
    // Retry up to 3 times when the file is empty or unparseable.  On Windows the
    // temp-file + rename write is not fully atomic: a concurrent reader can briefly
    // observe a 0-byte file (between truncate and write) or a stale/locked state.
    // A short synchronous backoff (50 ms via `Atomics.wait`) is enough for the
    // writer to finish.
    store = {};
    fileStat = getFileStatSnapshot(storePath);
    const maxReadAttempts = process.platform === "win32" ? 3 : 1;
    const retryBuf = maxReadAttempts > 1 ? new Int32Array(new SharedArrayBuffer(4)) : undefined;
    for (let attempt = 0; attempt < maxReadAttempts; attempt++) {
      try {
        const raw = fs.readFileSync(storePath, "utf-8");
        if (raw.length === 0 && attempt < maxReadAttempts - 1) {
          Atomics.wait(retryBuf!, 0, 0, 50);
          continue;
        }
        const parsed = JSON.parse(raw);
        if (isSessionStoreRecord(parsed)) {
          store = parsed;
          serializedFromDisk = raw;
        }
        fileStat = getFileStatSnapshot(storePath) ?? fileStat;
        break;
      } catch {
        if (attempt < maxReadAttempts - 1) {
          Atomics.wait(retryBuf!, 0, 0, 50);
          continue;
        }
      }
    }
    if (serializedFromDisk !== undefined) {
      setSerializedSessionStore(storePath, serializedFromDisk);
    } else {
      setSerializedSessionStore(storePath, undefined);
    }
  }

  applySessionStoreMigrations(store);

  // Cache the result if caching is enabled
  if (!opts.skipCache && isSessionStoreCacheEnabled()) {
    writeSessionStoreCache({
      storePath,
      store,
      mtimeMs: useDirectory ? undefined : fileStat?.mtimeMs,
      sizeBytes: useDirectory ? undefined : fileStat?.sizeBytes,
      serialized: serializedFromDisk,
    });
  }

  return structuredClone(store);
}

export function readSessionUpdatedAt(params: {
  storePath: string;
  sessionKey: string;
}): number | undefined {
  // For directory stores, read only the target entry — avoids loading the entire store.
  if (isDirectoryStore(params.storePath)) {
    const storeDir = resolveSessionStoreDir(params.storePath);
    const sanitized = sanitizeSessionKey(normalizeStoreSessionKey(params.sessionKey));
    const entry = loadSessionEntryFromDir(storeDir, `${sanitized}.json`);
    return entry?.updatedAt;
  }
  try {
    const store = loadSessionStore(params.storePath);
    const resolved = resolveSessionStoreEntry({ store, sessionKey: params.sessionKey });
    return resolved.existing?.updatedAt;
  } catch {
    return undefined;
  }
}

// ============================================================================
// Session Store Pruning, Capping & File Rotation
// ============================================================================

export type SessionMaintenanceApplyReport = {
  mode: ResolvedSessionMaintenanceConfig["mode"];
  beforeCount: number;
  afterCount: number;
  pruned: number;
  capped: number;
  diskBudget: SessionDiskBudgetSweepResult | null;
};

export {
  capEntryCount,
  getActiveSessionMaintenanceWarning,
  pruneStaleEntries,
  resolveMaintenanceConfig,
  rotateSessionFile,
};
export type { ResolvedSessionMaintenanceConfig, SessionMaintenanceWarning };

type SaveSessionStoreOptions = {
  /** Skip pruning, capping, and rotation (e.g. during one-time migrations). */
  skipMaintenance?: boolean;
  /** Active session key for warn-only maintenance. */
  activeSessionKey?: string;
  /** Optional callback for warn-only maintenance. */
  onWarn?: (warning: SessionMaintenanceWarning) => void | Promise<void>;
  /** Optional callback with maintenance stats after a save. */
  onMaintenanceApplied?: (report: SessionMaintenanceApplyReport) => void | Promise<void>;
  /** Optional overrides used by maintenance commands. */
  maintenanceOverride?: Partial<ResolvedSessionMaintenanceConfig>;
};

function updateSessionStoreWriteCaches(params: {
  storePath: string;
  store: Record<string, SessionEntry>;
  serialized: string;
}): void {
  const fileStat = getFileStatSnapshot(params.storePath);
  setSerializedSessionStore(params.storePath, params.serialized);
  if (!isSessionStoreCacheEnabled()) {
    dropSessionStoreObjectCache(params.storePath);
    return;
  }
  writeSessionStoreCache({
    storePath: params.storePath,
    store: params.store,
    mtimeMs: fileStat?.mtimeMs,
    sizeBytes: fileStat?.sizeBytes,
    serialized: params.serialized,
  });
}

async function saveSessionStoreUnlocked(
  storePath: string,
  store: Record<string, SessionEntry>,
  opts?: SaveSessionStoreOptions,
  /** Snapshot of the store before mutations — enables diff-based directory writes. */
  previousSnapshot?: Record<string, SessionEntry>,
): Promise<void> {
  normalizeSessionStore(store);

  if (!opts?.skipMaintenance) {
    // Resolve maintenance config once (avoids repeated loadConfig() calls).
    const maintenance = { ...resolveMaintenanceConfig(), ...opts?.maintenanceOverride };
    const shouldWarnOnly = maintenance.mode === "warn";
    const beforeCount = Object.keys(store).length;

    if (shouldWarnOnly) {
      const activeSessionKey = opts?.activeSessionKey?.trim();
      if (activeSessionKey) {
        const warning = getActiveSessionMaintenanceWarning({
          store,
          activeSessionKey,
          pruneAfterMs: maintenance.pruneAfterMs,
          maxEntries: maintenance.maxEntries,
        });
        if (warning) {
          log.warn("session maintenance would evict active session; skipping enforcement", {
            activeSessionKey: warning.activeSessionKey,
            wouldPrune: warning.wouldPrune,
            wouldCap: warning.wouldCap,
            pruneAfterMs: warning.pruneAfterMs,
            maxEntries: warning.maxEntries,
          });
          await opts?.onWarn?.(warning);
        }
      }
      const diskBudget = await enforceSessionDiskBudget({
        store,
        storePath,
        activeSessionKey: opts?.activeSessionKey,
        maintenance,
        warnOnly: true,
        log,
      });
      await opts?.onMaintenanceApplied?.({
        mode: maintenance.mode,
        beforeCount,
        afterCount: Object.keys(store).length,
        pruned: 0,
        capped: 0,
        diskBudget,
      });
    } else {
      // Prune stale entries and cap total count before serializing.
      const removedSessionFiles = new Map<string, string | undefined>();
      const pruned = pruneStaleEntries(store, maintenance.pruneAfterMs, {
        onPruned: ({ entry }) => {
          rememberRemovedSessionFile(removedSessionFiles, entry);
        },
      });
      const capped = capEntryCount(store, maintenance.maxEntries, {
        onCapped: ({ entry }) => {
          rememberRemovedSessionFile(removedSessionFiles, entry);
        },
      });
      const archivedDirs = new Set<string>();
      const referencedSessionIds = new Set(
        Object.values(store)
          .map((entry) => entry?.sessionId)
          .filter((id): id is string => Boolean(id)),
      );
      const archivedForDeletedSessions = archiveRemovedSessionTranscripts({
        removedSessionFiles,
        referencedSessionIds,
        storePath,
        reason: "deleted",
        restrictToStoreDir: true,
      });
      for (const archivedDir of archivedForDeletedSessions) {
        archivedDirs.add(archivedDir);
      }
      if (archivedDirs.size > 0 || maintenance.resetArchiveRetentionMs != null) {
        const targetDirs =
          archivedDirs.size > 0 ? [...archivedDirs] : [path.dirname(path.resolve(storePath))];
        await cleanupArchivedSessionTranscripts({
          directories: targetDirs,
          olderThanMs: maintenance.pruneAfterMs,
          reason: "deleted",
        });
        if (maintenance.resetArchiveRetentionMs != null) {
          await cleanupArchivedSessionTranscripts({
            directories: targetDirs,
            olderThanMs: maintenance.resetArchiveRetentionMs,
            reason: "reset",
          });
        }
      }

      // Rotate the on-disk file if it exceeds the size threshold (legacy JSON only).
      if (!isDirectoryStore(storePath)) {
        await rotateSessionFile(storePath, maintenance.rotateBytes);
      }

      const diskBudget = await enforceSessionDiskBudget({
        store,
        storePath,
        activeSessionKey: opts?.activeSessionKey,
        maintenance,
        warnOnly: false,
        log,
      });
      await opts?.onMaintenanceApplied?.({
        mode: maintenance.mode,
        beforeCount,
        afterCount: Object.keys(store).length,
        pruned,
        capped,
        diskBudget,
      });
    }
  }

  // Directory mode: write changed entries only (diff-based when previousSnapshot provided).
  if (isDirectoryStore(storePath)) {
    invalidateSessionStoreCache(storePath);
    setSerializedSessionStore(storePath, undefined);
    await writeSessionStoreDir(storePath, store, previousSnapshot);
    return;
  }

  // Legacy JSON file mode.
  await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
  const json = JSON.stringify(store, null, 2);
  if (getSerializedSessionStore(storePath) === json) {
    updateSessionStoreWriteCaches({ storePath, store, serialized: json });
    return;
  }

  // Windows: keep retry semantics because rename can fail while readers hold locks.
  if (process.platform === "win32") {
    for (let i = 0; i < 5; i++) {
      try {
        await writeSessionStoreAtomic({ storePath, store, serialized: json });
        return;
      } catch (err) {
        const code = getErrorCode(err);
        if (code === "ENOENT") {
          return;
        }
        if (i < 4) {
          await new Promise((r) => setTimeout(r, 50 * (i + 1)));
          continue;
        }
        log.warn(`atomic write failed after 5 attempts: ${storePath}`);
      }
    }
    return;
  }

  try {
    await writeSessionStoreAtomic({ storePath, store, serialized: json });
  } catch (err) {
    const code = getErrorCode(err);

    if (code === "ENOENT") {
      try {
        await writeSessionStoreAtomic({ storePath, store, serialized: json });
      } catch (err2) {
        const code2 = getErrorCode(err2);
        if (code2 === "ENOENT") {
          return;
        }
        throw err2;
      }
      return;
    }

    throw err;
  }
}

/**
 * Write changed session entries to the directory store.
 * If `previousSnapshot` is provided, only changed/removed entries are written (diff-based).
 * Otherwise, all entries are written and stale files are cleaned up.
 */
async function writeSessionStoreDir(
  storePath: string,
  store: Record<string, SessionEntry>,
  previousSnapshot?: Record<string, SessionEntry>,
): Promise<void> {
  const storeDir = resolveSessionStoreDir(storePath);
  await fs.promises.mkdir(storeDir, { recursive: true });

  if (previousSnapshot) {
    const { changed, removed } = computeStoreDiff(previousSnapshot, store);
    for (const key of changed) {
      await writeSessionEntryToDir(storeDir, key, store[key]);
    }
    for (const key of removed) {
      await deleteSessionEntryFromDir(storeDir, key);
    }
  } else {
    // Full write: write all entries, remove stale files.
    const existingFiles = new Set<string>();
    try {
      for (const f of await fs.promises.readdir(storeDir)) {
        if (f.endsWith(".json") && !f.startsWith(".")) {
          existingFiles.add(f);
        }
      }
    } catch {
      // Directory may not exist yet
    }

    const currentFiles = new Set<string>();
    for (const [key, entry] of Object.entries(store)) {
      if (!entry) {
        continue;
      }
      await writeSessionEntryToDir(storeDir, key, entry);
      currentFiles.add(`${sanitizeSessionKey(key)}.json`);
    }

    for (const file of existingFiles) {
      if (!currentFiles.has(file)) {
        const key = desanitizeSessionKey(file.slice(0, -5));
        await deleteSessionEntryFromDir(storeDir, key);
      }
    }
  }
}

export async function saveSessionStore(
  storePath: string,
  store: Record<string, SessionEntry>,
  opts?: SaveSessionStoreOptions,
): Promise<void> {
  await withSessionStoreLock(storePath, async () => {
    await saveSessionStoreUnlocked(storePath, store, opts);
  });
}

export async function updateSessionStore<T>(
  storePath: string,
  mutator: (store: Record<string, SessionEntry>) => Promise<T> | T,
  opts?: SaveSessionStoreOptions,
): Promise<T> {
  // Both directory and legacy modes use the global lock for updateSessionStore because
  // the generic mutator may touch any number of session keys — per-key locking is not feasible.
  return await withSessionStoreLock(storePath, async () => {
    const useDirectory = isDirectoryStore(storePath);
    const store = loadSessionStore(storePath, { skipCache: true });
    const previousSnapshot = useDirectory ? structuredClone(store) : undefined;
    const result = await mutator(store);
    await saveSessionStoreUnlocked(storePath, store, opts, previousSnapshot);
    return result;
  });
}

type SessionStoreLockOptions = {
  timeoutMs?: number;
  pollIntervalMs?: number;
  staleMs?: number;
};

type SessionStoreLockTask = {
  fn: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeoutMs?: number;
  staleMs: number;
};

type SessionStoreLockQueue = {
  running: boolean;
  pending: SessionStoreLockTask[];
};

const LOCK_QUEUES = new Map<string, SessionStoreLockQueue>();

function getErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return null;
  }
  return String((error as { code?: unknown }).code);
}

function rememberRemovedSessionFile(
  removedSessionFiles: Map<string, string | undefined>,
  entry: SessionEntry,
): void {
  if (!removedSessionFiles.has(entry.sessionId) || entry.sessionFile) {
    removedSessionFiles.set(entry.sessionId, entry.sessionFile);
  }
}

export function archiveRemovedSessionTranscripts(params: {
  removedSessionFiles: Iterable<[string, string | undefined]>;
  referencedSessionIds: ReadonlySet<string>;
  storePath: string;
  reason: "deleted" | "reset";
  restrictToStoreDir?: boolean;
}): Set<string> {
  const archivedDirs = new Set<string>();
  for (const [sessionId, sessionFile] of params.removedSessionFiles) {
    if (params.referencedSessionIds.has(sessionId)) {
      continue;
    }
    const archived = archiveSessionTranscripts({
      sessionId,
      storePath: params.storePath,
      sessionFile,
      reason: params.reason,
      restrictToStoreDir: params.restrictToStoreDir,
    });
    for (const archivedPath of archived) {
      archivedDirs.add(path.dirname(archivedPath));
    }
  }
  return archivedDirs;
}

async function writeSessionStoreAtomic(params: {
  storePath: string;
  store: Record<string, SessionEntry>;
  serialized: string;
}): Promise<void> {
  await writeTextAtomic(params.storePath, params.serialized, { mode: 0o600 });
  updateSessionStoreWriteCaches({
    storePath: params.storePath,
    store: params.store,
    serialized: params.serialized,
  });
}

async function persistResolvedSessionEntry(params: {
  storePath: string;
  store: Record<string, SessionEntry>;
  resolved: ReturnType<typeof resolveSessionStoreEntry>;
  next: SessionEntry;
  /** Pre-mutation snapshot — enables diff-based directory writes. */
  previousSnapshot?: Record<string, SessionEntry>;
}): Promise<SessionEntry> {
  params.store[params.resolved.normalizedKey] = params.next;
  for (const legacyKey of params.resolved.legacyKeys) {
    delete params.store[legacyKey];
  }
  await saveSessionStoreUnlocked(
    params.storePath,
    params.store,
    { activeSessionKey: params.resolved.normalizedKey },
    params.previousSnapshot,
  );
  return params.next;
}

function lockTimeoutError(storePath: string): Error {
  return new Error(`timeout waiting for session store lock: ${storePath}`);
}

function getOrCreateLockQueue(storePath: string): SessionStoreLockQueue {
  const existing = LOCK_QUEUES.get(storePath);
  if (existing) {
    return existing;
  }
  const created: SessionStoreLockQueue = { running: false, pending: [] };
  LOCK_QUEUES.set(storePath, created);
  return created;
}

async function drainSessionStoreLockQueue(storePath: string): Promise<void> {
  const queue = LOCK_QUEUES.get(storePath);
  if (!queue || queue.running) {
    return;
  }
  queue.running = true;
  try {
    while (queue.pending.length > 0) {
      const task = queue.pending.shift();
      if (!task) {
        continue;
      }

      const remainingTimeoutMs = task.timeoutMs ?? Number.POSITIVE_INFINITY;
      if (task.timeoutMs != null && remainingTimeoutMs <= 0) {
        task.reject(lockTimeoutError(storePath));
        continue;
      }

      let lock: { release: () => Promise<void> } | undefined;
      let result: unknown;
      let failed: unknown;
      let hasFailure = false;
      try {
        lock = await acquireSessionWriteLock({
          sessionFile: storePath,
          timeoutMs: remainingTimeoutMs,
          staleMs: task.staleMs,
        });
        result = await task.fn();
      } catch (err) {
        hasFailure = true;
        failed = err;
      } finally {
        await lock?.release().catch(() => undefined);
      }
      if (hasFailure) {
        task.reject(failed);
        continue;
      }
      task.resolve(result);
    }
  } finally {
    queue.running = false;
    if (queue.pending.length === 0) {
      LOCK_QUEUES.delete(storePath);
    } else {
      queueMicrotask(() => {
        void drainSessionStoreLockQueue(storePath);
      });
    }
  }
}

async function withSessionStoreLock<T>(
  storePath: string,
  fn: () => Promise<T>,
  opts: SessionStoreLockOptions = {},
): Promise<T> {
  if (!storePath || typeof storePath !== "string") {
    throw new Error(
      `withSessionStoreLock: storePath must be a non-empty string, got ${JSON.stringify(storePath)}`,
    );
  }
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const staleMs = opts.staleMs ?? 30_000;
  // `pollIntervalMs` is retained for API compatibility with older lock options.
  void opts.pollIntervalMs;

  const hasTimeout = timeoutMs > 0 && Number.isFinite(timeoutMs);
  const queue = getOrCreateLockQueue(storePath);

  const promise = new Promise<T>((resolve, reject) => {
    const task: SessionStoreLockTask = {
      fn: async () => await fn(),
      resolve: (value) => resolve(value as T),
      reject,
      timeoutMs: hasTimeout ? timeoutMs : undefined,
      staleMs,
    };

    queue.pending.push(task);
    void drainSessionStoreLockQueue(storePath);
  });

  return await promise;
}

export async function updateSessionStoreEntry(params: {
  storePath: string;
  sessionKey: string;
  update: (entry: SessionEntry) => Promise<Partial<SessionEntry> | null>;
}): Promise<SessionEntry | null> {
  const { storePath, sessionKey, update } = params;
  // All directory-mode writers share the same storePath lock so that updateSessionStore
  // (which also holds storePath) and updateSessionStoreEntry serialize against each other,
  // preventing lost-update races on the same session entry.
  return await withSessionStoreLock(storePath, async () => {
    const useDirectory = isDirectoryStore(storePath);
    const store = loadSessionStore(storePath, { skipCache: true });
    const previousSnapshot = useDirectory ? structuredClone(store) : undefined;
    const resolved = resolveSessionStoreEntry({ store, sessionKey });
    const existing = resolved.existing;
    if (!existing) {
      return null;
    }
    const patch = await update(existing);
    if (!patch) {
      return existing;
    }
    const next = mergeSessionEntry(existing, patch);
    return await persistResolvedSessionEntry({
      storePath,
      store,
      resolved,
      next,
      previousSnapshot,
    });
  });
}

export async function recordSessionMetaFromInbound(params: {
  storePath: string;
  sessionKey: string;
  ctx: MsgContext;
  groupResolution?: import("./types.js").GroupKeyResolution | null;
  createIfMissing?: boolean;
}): Promise<SessionEntry | null> {
  const { storePath, sessionKey, ctx } = params;
  const createIfMissing = params.createIfMissing ?? true;
  return await updateSessionStore(
    storePath,
    (store) => {
      const resolved = resolveSessionStoreEntry({ store, sessionKey });
      const existing = resolved.existing;
      const patch = deriveSessionMetaPatch({
        ctx,
        sessionKey: resolved.normalizedKey,
        existing,
        groupResolution: params.groupResolution,
      });
      if (!patch) {
        if (existing && resolved.legacyKeys.length > 0) {
          store[resolved.normalizedKey] = existing;
          for (const legacyKey of resolved.legacyKeys) {
            delete store[legacyKey];
          }
        }
        return existing ?? null;
      }
      if (!existing && !createIfMissing) {
        return null;
      }
      const next = existing
        ? // Inbound metadata updates must not refresh activity timestamps;
          // idle reset evaluation relies on updatedAt from actual session turns.
          mergeSessionEntryPreserveActivity(existing, patch)
        : mergeSessionEntry(existing, patch);
      store[resolved.normalizedKey] = next;
      for (const legacyKey of resolved.legacyKeys) {
        delete store[legacyKey];
      }
      return next;
    },
    { activeSessionKey: normalizeStoreSessionKey(sessionKey) },
  );
}

export async function updateLastRoute(params: {
  storePath: string;
  sessionKey: string;
  channel?: SessionEntry["lastChannel"];
  to?: string;
  accountId?: string;
  threadId?: string | number;
  deliveryContext?: DeliveryContext;
  ctx?: MsgContext;
  groupResolution?: import("./types.js").GroupKeyResolution | null;
}) {
  const { storePath, sessionKey, channel, to, accountId, threadId, ctx } = params;
  // All directory-mode writers share the storePath lock (same as updateSessionStore) to
  // prevent lost-update races between updateLastRoute and generic updateSessionStore calls.
  const body = async () => {
    const useDirectory = isDirectoryStore(storePath);
    const store = loadSessionStore(storePath, { skipCache: true });
    const previousSnapshot = useDirectory ? structuredClone(store) : undefined;
    const resolved = resolveSessionStoreEntry({ store, sessionKey });
    const existing = resolved.existing;
    const now = Date.now();
    const explicitContext = normalizeDeliveryContext(params.deliveryContext);
    const inlineContext = normalizeDeliveryContext({
      channel,
      to,
      accountId,
      threadId,
    });
    const mergedInput = mergeDeliveryContext(explicitContext, inlineContext);
    const explicitDeliveryContext = params.deliveryContext;
    const explicitThreadFromDeliveryContext =
      explicitDeliveryContext != null &&
      Object.prototype.hasOwnProperty.call(explicitDeliveryContext, "threadId")
        ? explicitDeliveryContext.threadId
        : undefined;
    const explicitThreadValue =
      explicitThreadFromDeliveryContext ??
      (threadId != null && threadId !== "" ? threadId : undefined);
    const explicitRouteProvided = Boolean(
      explicitContext?.channel ||
      explicitContext?.to ||
      inlineContext?.channel ||
      inlineContext?.to,
    );
    const clearThreadFromFallback = explicitRouteProvided && explicitThreadValue == null;
    const fallbackContext = clearThreadFromFallback
      ? removeThreadFromDeliveryContext(deliveryContextFromSession(existing))
      : deliveryContextFromSession(existing);
    const merged = mergeDeliveryContext(mergedInput, fallbackContext);
    const normalized = normalizeSessionDeliveryFields({
      deliveryContext: {
        channel: merged?.channel,
        to: merged?.to,
        accountId: merged?.accountId,
        threadId: merged?.threadId,
      },
    });
    const metaPatch = ctx
      ? deriveSessionMetaPatch({
          ctx,
          sessionKey: resolved.normalizedKey,
          existing,
          groupResolution: params.groupResolution,
        })
      : null;
    const basePatch: Partial<SessionEntry> = {
      updatedAt: Math.max(existing?.updatedAt ?? 0, now),
      deliveryContext: normalized.deliveryContext,
      lastChannel: normalized.lastChannel,
      lastTo: normalized.lastTo,
      lastAccountId: normalized.lastAccountId,
      lastThreadId: normalized.lastThreadId,
    };
    const next = mergeSessionEntry(
      existing,
      metaPatch ? { ...basePatch, ...metaPatch } : basePatch,
    );
    return await persistResolvedSessionEntry({
      storePath,
      store,
      resolved,
      next,
      previousSnapshot,
    });
  };
  return await withSessionStoreLock(storePath, body);
}
