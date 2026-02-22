import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { acquireSessionWriteLock } from "../../agents/session-write-lock.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import { parseByteSize } from "../../cli/parse-bytes.js";
import { parseDurationMs } from "../../cli/parse-duration.js";
import {
  archiveSessionTranscripts,
  cleanupArchivedSessionTranscripts,
} from "../../gateway/session-utils.fs.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  deliveryContextFromSession,
  mergeDeliveryContext,
  normalizeDeliveryContext,
  normalizeSessionDeliveryFields,
  type DeliveryContext,
} from "../../utils/delivery-context.js";
import { getFileMtimeMs, isCacheEnabled, resolveCacheTtlMs } from "../cache-utils.js";
import { loadConfig } from "../config.js";
import type { SessionMaintenanceConfig, SessionMaintenanceMode } from "../types.base.js";
import { deriveSessionMetaPatch } from "./metadata.js";
import { mergeSessionEntry, type SessionEntry } from "./types.js";

const log = createSubsystemLogger("sessions/store");

// ============================================================================
// Directory-per-session layout helpers
// ============================================================================

/**
 * Derive the directory store path from a legacy storePath (e.g. `sessions.json`).
 * The directory store lives as a sibling `sessions.d/` directory.
 */
export function resolveSessionStoreDir(storePath: string): string {
  const dir = path.dirname(storePath);
  return path.join(dir, "sessions.d");
}

/**
 * Sanitize a session key for safe use as a filesystem directory name.
 * Colons are replaced with `--` for reversible filesystem-safe encoding.
 */
export function sanitizeSessionKey(key: string): string {
  // Replace colons with double-dash (reversible, filesystem-safe)
  return key.replace(/:/g, "--");
}

/**
 * Reverse the sanitization to recover the original session key.
 */
export function desanitizeSessionKey(dirName: string): string {
  return dirName.replace(/--/g, ":");
}

/**
 * Check whether a directory-based session store exists.
 */
function isDirectoryStore(storePath: string): boolean {
  const storeDir = resolveSessionStoreDir(storePath);
  try {
    return fs.statSync(storeDir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Check whether a legacy JSON session store file exists.
 */
function isLegacyJsonStore(storePath: string): boolean {
  try {
    return fs.statSync(storePath).isFile();
  } catch {
    return false;
  }
}

// ============================================================================
// Directory store: per-session read/write
// ============================================================================

function loadSessionEntryFromDir(storeDir: string, dirName: string): SessionEntry | null {
  const metaPath = path.join(storeDir, dirName, "meta.json");
  try {
    const raw = fs.readFileSync(metaPath, "utf-8");
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

function loadSessionStoreFromDir(storeDir: string): Record<string, SessionEntry> {
  const store: Record<string, SessionEntry> = {};
  let entries: string[];
  try {
    entries = fs.readdirSync(storeDir);
  } catch {
    return store;
  }
  for (const dirName of entries) {
    // Skip non-directories and hidden files
    try {
      const stat = fs.statSync(path.join(storeDir, dirName));
      if (!stat.isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }
    const sessionKey = desanitizeSessionKey(dirName);
    const entry = loadSessionEntryFromDir(storeDir, dirName);
    if (entry) {
      store[sessionKey] = entry;
    }
  }
  return store;
}

async function writeSessionEntryToDir(
  storeDir: string,
  sessionKey: string,
  entry: SessionEntry,
): Promise<void> {
  const sanitized = sanitizeSessionKey(sessionKey);
  const entryDir = path.join(storeDir, sanitized);
  const metaPath = path.join(entryDir, "meta.json");
  await fs.promises.mkdir(entryDir, { recursive: true });
  const json = JSON.stringify(entry, null, 2);
  const tmp = `${metaPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(tmp, json, { mode: 0o600, encoding: "utf-8" });
    await fs.promises.rename(tmp, metaPath);
    if (process.platform !== "win32") {
      await fs.promises.chmod(metaPath, 0o600).catch(() => undefined);
    }
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code?: unknown }).code)
        : null;
    if (code === "ENOENT") {
      // Parent dir may have been deleted (e.g. in tests). Best-effort retry.
      try {
        await fs.promises.mkdir(entryDir, { recursive: true });
        await fs.promises.writeFile(metaPath, json, { mode: 0o600, encoding: "utf-8" });
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

async function deleteSessionEntryFromDir(storeDir: string, sessionKey: string): Promise<void> {
  const sanitized = sanitizeSessionKey(sessionKey);
  const entryDir = path.join(storeDir, sanitized);
  try {
    await fs.promises.rm(entryDir, { recursive: true, force: true });
  } catch {
    // Ignore - entry may already be deleted
  }
}

// ============================================================================
// Migration: JSON file → directory store
// ============================================================================

async function migrateJsonToDirectory(storePath: string): Promise<void> {
  const storeDir = resolveSessionStoreDir(storePath);
  let store: Record<string, SessionEntry> = {};

  try {
    const raw = fs.readFileSync(storePath, "utf-8");
    if (raw.length === 0) {
      return;
    }
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      store = parsed as Record<string, SessionEntry>;
    }
  } catch {
    return; // Can't read/parse the file, nothing to migrate
  }

  const keys = Object.keys(store);
  if (keys.length === 0) {
    return;
  }

  log.info("migrating session store from JSON to directory layout", {
    entries: keys.length,
    storePath,
    storeDir,
  });

  // Create the directory store
  await fs.promises.mkdir(storeDir, { recursive: true });

  // Write each entry
  for (const [key, entry] of Object.entries(store)) {
    if (!entry) {
      continue;
    }
    await writeSessionEntryToDir(storeDir, key, entry);
  }

  // Backup and remove the old JSON file
  const backupPath = `${storePath}.pre-directory-migration.${Date.now()}`;
  try {
    await fs.promises.rename(storePath, backupPath);
    log.info("backed up legacy sessions.json", {
      backupPath: path.basename(backupPath),
    });
  } catch {
    // If rename fails, just leave the file. Directory store takes precedence.
  }
}

// ============================================================================
// Session Store Cache with TTL Support
// ============================================================================

type SessionStoreCacheEntry = {
  store: Record<string, SessionEntry>;
  loadedAt: number;
  storePath: string;
  mtimeMs?: number;
  /** For directory stores, track per-session mtimes for smarter invalidation. */
  dirMtimeMs?: number;
};

const SESSION_STORE_CACHE = new Map<string, SessionStoreCacheEntry>();
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

function isSessionStoreCacheValid(entry: SessionStoreCacheEntry): boolean {
  const now = Date.now();
  const ttl = getSessionStoreTtl();
  return now - entry.loadedAt <= ttl;
}

function invalidateSessionStoreCache(storePath: string): void {
  SESSION_STORE_CACHE.delete(storePath);
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

function normalizeSessionStore(store: Record<string, SessionEntry>): void {
  for (const [key, entry] of Object.entries(store)) {
    if (!entry) {
      continue;
    }
    const normalized = normalizeSessionEntryDelivery(entry);
    if (normalized !== entry) {
      store[key] = normalized;
    }
  }
}

export function clearSessionStoreCacheForTest(): void {
  SESSION_STORE_CACHE.clear();
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

/**
 * Get the mtime of the directory store (uses the directory's own mtime).
 */
function getDirStoreMtimeMs(storeDir: string): number | undefined {
  try {
    return fs.statSync(storeDir).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * Apply best-effort legacy field migrations to a session entry.
 */
function migrateEntryFields(entry: SessionEntry): void {
  const rec = entry as unknown as Record<string, unknown>;
  if (typeof rec.channel !== "string" && typeof rec.provider === "string") {
    rec.channel = rec.provider;
    delete rec.provider;
  }
  if (typeof rec.lastChannel !== "string" && typeof rec.lastProvider === "string") {
    rec.lastChannel = rec.lastProvider;
    delete rec.lastProvider;
  }
  if (typeof rec.groupChannel !== "string" && typeof rec.room === "string") {
    rec.groupChannel = rec.room;
    delete rec.room;
  } else if ("room" in rec) {
    delete rec.room;
  }
}

export function loadSessionStore(
  storePath: string,
  opts: LoadSessionStoreOptions = {},
): Record<string, SessionEntry> {
  const useDirectoryStore = isDirectoryStore(storePath);

  // Check cache first if enabled
  if (!opts.skipCache && isSessionStoreCacheEnabled()) {
    const cached = SESSION_STORE_CACHE.get(storePath);
    if (cached && isSessionStoreCacheValid(cached)) {
      if (useDirectoryStore) {
        const currentDirMtime = getDirStoreMtimeMs(resolveSessionStoreDir(storePath));
        if (currentDirMtime === cached.dirMtimeMs) {
          return structuredClone(cached.store);
        }
      } else {
        const currentMtimeMs = getFileMtimeMs(storePath);
        if (currentMtimeMs === cached.mtimeMs) {
          return structuredClone(cached.store);
        }
      }
      invalidateSessionStoreCache(storePath);
    }
  }

  let store: Record<string, SessionEntry>;
  let mtimeMs: number | undefined;
  let dirMtimeMs: number | undefined;

  if (useDirectoryStore) {
    // Directory-per-session mode
    const storeDir = resolveSessionStoreDir(storePath);
    store = loadSessionStoreFromDir(storeDir);
    dirMtimeMs = getDirStoreMtimeMs(storeDir);
  } else {
    // Legacy JSON file mode (or empty — will be migrated on first write)
    store = {};
    mtimeMs = getFileMtimeMs(storePath);
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
        }
        mtimeMs = getFileMtimeMs(storePath) ?? mtimeMs;
        break;
      } catch {
        if (attempt < maxReadAttempts - 1) {
          Atomics.wait(retryBuf!, 0, 0, 50);
          continue;
        }
      }
    }
  }

  // Best-effort migration: legacy field renames
  for (const entry of Object.values(store)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    migrateEntryFields(entry);
  }

  // Cache the result if caching is enabled
  if (!opts.skipCache && isSessionStoreCacheEnabled()) {
    SESSION_STORE_CACHE.set(storePath, {
      store: structuredClone(store),
      loadedAt: Date.now(),
      storePath,
      mtimeMs,
      dirMtimeMs,
    });
  }

  return structuredClone(store);
}

export function readSessionUpdatedAt(params: {
  storePath: string;
  sessionKey: string;
}): number | undefined {
  // For directory stores, read only the specific entry for efficiency
  if (isDirectoryStore(params.storePath)) {
    const storeDir = resolveSessionStoreDir(params.storePath);
    const sanitized = sanitizeSessionKey(params.sessionKey);
    const entry = loadSessionEntryFromDir(storeDir, sanitized);
    return entry?.updatedAt;
  }
  try {
    const store = loadSessionStore(params.storePath);
    return store[params.sessionKey]?.updatedAt;
  } catch {
    return undefined;
  }
}

// ============================================================================
// Session Store Pruning, Capping & File Rotation
// ============================================================================

const DEFAULT_SESSION_PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_SESSION_MAX_ENTRIES = 500;
const DEFAULT_SESSION_ROTATE_BYTES = 10_485_760; // 10 MB
const DEFAULT_SESSION_MAINTENANCE_MODE: SessionMaintenanceMode = "warn";

export type SessionMaintenanceWarning = {
  activeSessionKey: string;
  activeUpdatedAt?: number;
  totalEntries: number;
  pruneAfterMs: number;
  maxEntries: number;
  wouldPrune: boolean;
  wouldCap: boolean;
};

type ResolvedSessionMaintenanceConfig = {
  mode: SessionMaintenanceMode;
  pruneAfterMs: number;
  maxEntries: number;
  rotateBytes: number;
};

function resolvePruneAfterMs(maintenance?: SessionMaintenanceConfig): number {
  const raw = maintenance?.pruneAfter ?? maintenance?.pruneDays;
  if (raw === undefined || raw === null || raw === "") {
    return DEFAULT_SESSION_PRUNE_AFTER_MS;
  }
  try {
    return parseDurationMs(String(raw).trim(), { defaultUnit: "d" });
  } catch {
    return DEFAULT_SESSION_PRUNE_AFTER_MS;
  }
}

function resolveRotateBytes(maintenance?: SessionMaintenanceConfig): number {
  const raw = maintenance?.rotateBytes;
  if (raw === undefined || raw === null || raw === "") {
    return DEFAULT_SESSION_ROTATE_BYTES;
  }
  try {
    return parseByteSize(String(raw).trim(), { defaultUnit: "b" });
  } catch {
    return DEFAULT_SESSION_ROTATE_BYTES;
  }
}

/**
 * Resolve maintenance settings from openclaw.json (`session.maintenance`).
 * Falls back to built-in defaults when config is missing or unset.
 */
export function resolveMaintenanceConfig(): ResolvedSessionMaintenanceConfig {
  let maintenance: SessionMaintenanceConfig | undefined;
  try {
    maintenance = loadConfig().session?.maintenance;
  } catch {
    // Config may not be available (e.g. in tests). Use defaults.
  }
  return {
    mode: maintenance?.mode ?? DEFAULT_SESSION_MAINTENANCE_MODE,
    pruneAfterMs: resolvePruneAfterMs(maintenance),
    maxEntries: maintenance?.maxEntries ?? DEFAULT_SESSION_MAX_ENTRIES,
    rotateBytes: resolveRotateBytes(maintenance),
  };
}

/**
 * Remove entries whose `updatedAt` is older than the configured threshold.
 * Entries without `updatedAt` are kept (cannot determine staleness).
 * Mutates `store` in-place.
 */
export function pruneStaleEntries(
  store: Record<string, SessionEntry>,
  overrideMaxAgeMs?: number,
  opts: { log?: boolean; onPruned?: (params: { key: string; entry: SessionEntry }) => void } = {},
): number {
  const maxAgeMs = overrideMaxAgeMs ?? resolveMaintenanceConfig().pruneAfterMs;
  const cutoffMs = Date.now() - maxAgeMs;
  let pruned = 0;
  for (const [key, entry] of Object.entries(store)) {
    if (entry?.updatedAt != null && entry.updatedAt < cutoffMs) {
      opts.onPruned?.({ key, entry });
      delete store[key];
      pruned++;
    }
  }
  if (pruned > 0 && opts.log !== false) {
    log.info("pruned stale session entries", { pruned, maxAgeMs });
  }
  return pruned;
}

/**
 * Cap the store to the N most recently updated entries.
 * Entries without `updatedAt` are sorted last (removed first when over limit).
 * Mutates `store` in-place.
 */
function getEntryUpdatedAt(entry?: SessionEntry): number {
  return entry?.updatedAt ?? Number.NEGATIVE_INFINITY;
}

export function getActiveSessionMaintenanceWarning(params: {
  store: Record<string, SessionEntry>;
  activeSessionKey: string;
  pruneAfterMs: number;
  maxEntries: number;
  nowMs?: number;
}): SessionMaintenanceWarning | null {
  const activeSessionKey = params.activeSessionKey.trim();
  if (!activeSessionKey) {
    return null;
  }
  const activeEntry = params.store[activeSessionKey];
  if (!activeEntry) {
    return null;
  }
  const now = params.nowMs ?? Date.now();
  const cutoffMs = now - params.pruneAfterMs;
  const wouldPrune = activeEntry.updatedAt != null ? activeEntry.updatedAt < cutoffMs : false;
  const keys = Object.keys(params.store);
  const wouldCap =
    keys.length > params.maxEntries &&
    keys
      .toSorted((a, b) => getEntryUpdatedAt(params.store[b]) - getEntryUpdatedAt(params.store[a]))
      .slice(params.maxEntries)
      .includes(activeSessionKey);

  if (!wouldPrune && !wouldCap) {
    return null;
  }

  return {
    activeSessionKey,
    activeUpdatedAt: activeEntry.updatedAt,
    totalEntries: keys.length,
    pruneAfterMs: params.pruneAfterMs,
    maxEntries: params.maxEntries,
    wouldPrune,
    wouldCap,
  };
}

export function capEntryCount(
  store: Record<string, SessionEntry>,
  overrideMax?: number,
  opts: { log?: boolean } = {},
): number {
  const maxEntries = overrideMax ?? resolveMaintenanceConfig().maxEntries;
  const keys = Object.keys(store);
  if (keys.length <= maxEntries) {
    return 0;
  }

  // Sort by updatedAt descending; entries without updatedAt go to the end (removed first).
  const sorted = keys.toSorted((a, b) => {
    const aTime = getEntryUpdatedAt(store[a]);
    const bTime = getEntryUpdatedAt(store[b]);
    return bTime - aTime;
  });

  const toRemove = sorted.slice(maxEntries);
  for (const key of toRemove) {
    delete store[key];
  }
  if (opts.log !== false) {
    log.info("capped session entry count", { removed: toRemove.length, maxEntries });
  }
  return toRemove.length;
}

async function getSessionFileSize(storePath: string): Promise<number | null> {
  try {
    const stat = await fs.promises.stat(storePath);
    return stat.size;
  } catch {
    return null;
  }
}

/**
 * Rotate the sessions file if it exceeds the configured size threshold.
 * For directory stores, this is a no-op (individual files are tiny).
 * For legacy JSON stores, renames the file to `.bak.{timestamp}`.
 */
export async function rotateSessionFile(
  storePath: string,
  overrideBytes?: number,
): Promise<boolean> {
  // Directory stores don't need rotation — each entry is a small file
  if (isDirectoryStore(storePath)) {
    return false;
  }

  const maxBytes = overrideBytes ?? resolveMaintenanceConfig().rotateBytes;

  // Check current file size (file may not exist yet).
  const fileSize = await getSessionFileSize(storePath);
  if (fileSize == null) {
    return false;
  }

  if (fileSize <= maxBytes) {
    return false;
  }

  // Rotate: rename current file to .bak.{timestamp}
  const backupPath = `${storePath}.bak.${Date.now()}`;
  try {
    await fs.promises.rename(storePath, backupPath);
    log.info("rotated session store file", {
      backupPath: path.basename(backupPath),
      sizeBytes: fileSize,
    });
  } catch {
    // If rename fails (e.g. file disappeared), skip rotation.
    return false;
  }

  // Clean up old backups — keep only the 3 most recent .bak.* files.
  try {
    const dir = path.dirname(storePath);
    const baseName = path.basename(storePath);
    const files = await fs.promises.readdir(dir);
    const backups = files
      .filter((f) => f.startsWith(`${baseName}.bak.`))
      .toSorted()
      .toReversed();

    const maxBackups = 3;
    if (backups.length > maxBackups) {
      const toDelete = backups.slice(maxBackups);
      for (const old of toDelete) {
        await fs.promises.unlink(path.join(dir, old)).catch(() => undefined);
      }
      log.info("cleaned up old session store backups", { deleted: toDelete.length });
    }
  } catch {
    // Best-effort cleanup; don't fail the write.
  }

  return true;
}

type SaveSessionStoreOptions = {
  /** Skip pruning, capping, and rotation (e.g. during one-time migrations). */
  skipMaintenance?: boolean;
  /** Active session key for warn-only maintenance. */
  activeSessionKey?: string;
  /** Optional callback for warn-only maintenance. */
  onWarn?: (warning: SessionMaintenanceWarning) => void | Promise<void>;
};

/**
 * Compute the diff between the previous store snapshot and the current one.
 * Returns lists of keys that were added/changed and removed.
 */
function computeStoreDiff(
  previous: Record<string, SessionEntry>,
  current: Record<string, SessionEntry>,
): { changed: string[]; removed: string[] } {
  const changed: string[] = [];
  const removed: string[] = [];

  // Find added/changed entries
  for (const key of Object.keys(current)) {
    if (!previous[key]) {
      changed.push(key);
    } else {
      // Quick check: compare updatedAt and a few key fields for changes
      const prev = previous[key];
      const curr = current[key];
      if (prev !== curr) {
        // Deep comparison is expensive; use JSON comparison for correctness
        if (JSON.stringify(prev) !== JSON.stringify(curr)) {
          changed.push(key);
        }
      }
    }
  }

  // Find removed entries
  for (const key of Object.keys(previous)) {
    if (!(key in current)) {
      removed.push(key);
    }
  }

  return { changed, removed };
}

async function saveSessionStoreUnlocked(
  storePath: string,
  store: Record<string, SessionEntry>,
  opts?: SaveSessionStoreOptions,
  /** Snapshot of the store before mutations, used for diff-based directory writes. */
  previousStore?: Record<string, SessionEntry>,
): Promise<void> {
  // Invalidate cache on write to ensure consistency
  invalidateSessionStoreCache(storePath);

  normalizeSessionStore(store);

  if (!opts?.skipMaintenance) {
    // Resolve maintenance config once (avoids repeated loadConfig() calls).
    const maintenance = resolveMaintenanceConfig();
    const shouldWarnOnly = maintenance.mode === "warn";

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
    } else {
      // Prune stale entries and cap total count before serializing.
      const prunedSessionFiles = new Map<string, string | undefined>();
      pruneStaleEntries(store, maintenance.pruneAfterMs, {
        onPruned: ({ entry }) => {
          if (!prunedSessionFiles.has(entry.sessionId) || entry.sessionFile) {
            prunedSessionFiles.set(entry.sessionId, entry.sessionFile);
          }
        },
      });
      capEntryCount(store, maintenance.maxEntries);
      const archivedDirs = new Set<string>();
      for (const [sessionId, sessionFile] of prunedSessionFiles) {
        const archived = archiveSessionTranscripts({
          sessionId,
          storePath,
          sessionFile,
          reason: "deleted",
        });
        for (const archivedPath of archived) {
          archivedDirs.add(path.dirname(archivedPath));
        }
      }
      if (archivedDirs.size > 0) {
        await cleanupArchivedSessionTranscripts({
          directories: [...archivedDirs],
          olderThanMs: maintenance.pruneAfterMs,
          reason: "deleted",
        });
      }

      // Rotate the on-disk file if it exceeds the size threshold (legacy JSON only).
      await rotateSessionFile(storePath, maintenance.rotateBytes);
    }
  }

  // Determine whether to use directory or legacy JSON mode.
  // Use directory mode only if `sessions.d/` already exists (i.e., after explicit migration).
  // Fresh installs and un-migrated stores continue using JSON for backward compatibility.
  const useDirectory = isDirectoryStore(storePath);

  if (useDirectory) {
    const storeDir = resolveSessionStoreDir(storePath);
    await fs.promises.mkdir(storeDir, { recursive: true });

    if (previousStore) {
      // Diff-based write: only write changed entries, delete removed ones
      const { changed, removed } = computeStoreDiff(previousStore, store);
      for (const key of changed) {
        await writeSessionEntryToDir(storeDir, key, store[key]);
      }
      for (const key of removed) {
        await deleteSessionEntryFromDir(storeDir, key);
      }
    } else {
      // Full write: write all entries, remove stale directories
      const existingDirs = new Set<string>();
      try {
        const entries = await fs.promises.readdir(storeDir);
        for (const e of entries) {
          existingDirs.add(e);
        }
      } catch {
        // Directory may not exist yet
      }

      const currentDirs = new Set<string>();
      for (const [key, entry] of Object.entries(store)) {
        if (!entry) {
          continue;
        }
        await writeSessionEntryToDir(storeDir, key, entry);
        currentDirs.add(sanitizeSessionKey(key));
      }

      // Remove directories that no longer have entries
      for (const dir of existingDirs) {
        if (!currentDirs.has(dir)) {
          await deleteSessionEntryFromDir(storeDir, desanitizeSessionKey(dir));
        }
      }
    }
    return;
  }

  // Legacy JSON file mode (backward compatibility for existing stores)
  await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
  const json = JSON.stringify(store, null, 2);

  if (process.platform === "win32") {
    const tmp = `${storePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.promises.writeFile(tmp, json, "utf-8");
      for (let i = 0; i < 5; i++) {
        try {
          await fs.promises.rename(tmp, storePath);
          break;
        } catch {
          if (i < 4) {
            await new Promise((r) => setTimeout(r, 50 * (i + 1)));
          }
          if (i === 4) {
            log.warn(`rename failed after 5 attempts: ${storePath}`);
          }
        }
      }
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err
          ? String((err as { code?: unknown }).code)
          : null;
      if (code === "ENOENT") {
        return;
      }
      throw err;
    } finally {
      await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
    }
    return;
  }

  const tmp = `${storePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(tmp, json, { mode: 0o600, encoding: "utf-8" });
    await fs.promises.rename(tmp, storePath);
    await fs.promises.chmod(storePath, 0o600);
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code?: unknown }).code)
        : null;

    if (code === "ENOENT") {
      try {
        await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
        await fs.promises.writeFile(storePath, json, { mode: 0o600, encoding: "utf-8" });
        await fs.promises.chmod(storePath, 0o600);
      } catch (err2) {
        const code2 =
          err2 && typeof err2 === "object" && "code" in err2
            ? String((err2 as { code?: unknown }).code)
            : null;
        if (code2 === "ENOENT") {
          return;
        }
        throw err2;
      }
      return;
    }

    throw err;
  } finally {
    await fs.promises.rm(tmp, { force: true });
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
  return await withSessionStoreLock(storePath, async () => {
    // Always re-read inside the lock to avoid clobbering concurrent writers.
    const store = loadSessionStore(storePath, { skipCache: true });
    // Take a snapshot before mutation for diff-based writes
    const previousStore = structuredClone(store);
    const result = await mutator(store);
    await saveSessionStoreUnlocked(storePath, store, opts, previousStore);
    return result;
  });
}

/**
 * Migrate a legacy JSON session store to directory-per-session layout.
 * Safe to call multiple times — no-ops if already migrated or no JSON exists.
 * After migration, all subsequent load/save/update calls will use the directory store.
 */
export async function migrateSessionStoreToDirectory(storePath: string): Promise<boolean> {
  if (isDirectoryStore(storePath)) {
    return false; // Already migrated
  }
  if (!isLegacyJsonStore(storePath)) {
    return false; // No JSON file to migrate
  }
  return await withSessionStoreLock(storePath, async () => {
    // Double-check inside lock
    if (isDirectoryStore(storePath) || !isLegacyJsonStore(storePath)) {
      return false;
    }
    await migrateJsonToDirectory(storePath);
    return true;
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
  return await withSessionStoreLock(storePath, async () => {
    const store = loadSessionStore(storePath);
    const existing = store[sessionKey];
    if (!existing) {
      return null;
    }
    const patch = await update(existing);
    if (!patch) {
      return existing;
    }
    const next = mergeSessionEntry(existing, patch);
    store[sessionKey] = next;
    await saveSessionStoreUnlocked(storePath, store, { activeSessionKey: sessionKey });
    return next;
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
      const existing = store[sessionKey];
      const patch = deriveSessionMetaPatch({
        ctx,
        sessionKey,
        existing,
        groupResolution: params.groupResolution,
      });
      if (!patch) {
        return existing ?? null;
      }
      if (!existing && !createIfMissing) {
        return null;
      }
      const next = mergeSessionEntry(existing, patch);
      store[sessionKey] = next;
      return next;
    },
    { activeSessionKey: sessionKey },
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
  return await withSessionStoreLock(storePath, async () => {
    const store = loadSessionStore(storePath);
    const existing = store[sessionKey];
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
          sessionKey,
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
    store[sessionKey] = next;
    await saveSessionStoreUnlocked(storePath, store, { activeSessionKey: sessionKey });
    return next;
  });
}
