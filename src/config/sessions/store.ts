import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { MsgContext } from "../../auto-reply/templating.js";
import type { SessionMaintenanceConfig, SessionMaintenanceMode } from "../types.base.js";
import { acquireSessionWriteLock } from "../../agents/session-write-lock.js";
import { parseByteSize } from "../../cli/parse-bytes.js";
import { parseDurationMs } from "../../cli/parse-duration.js";
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
import { deriveSessionMetaPatch } from "./metadata.js";
import { mergeSessionEntry, type SessionEntry } from "./types.js";

const log = createSubsystemLogger("sessions/store");

// ============================================================================
// Session Store Cache with TTL Support
// ============================================================================

type SessionStoreCacheEntry = {
  store: Record<string, SessionEntry>;
  loadedAt: number;
  storePath: string;
  mtimeMs?: number;
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
      task.timedOut = true;
      if (task.timer) {
        clearTimeout(task.timer);
      }
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
  // Check cache first if enabled
  if (!opts.skipCache && isSessionStoreCacheEnabled()) {
    const cached = SESSION_STORE_CACHE.get(storePath);
    if (cached && isSessionStoreCacheValid(cached)) {
      const currentMtimeMs = getFileMtimeMs(storePath);
      if (currentMtimeMs === cached.mtimeMs) {
        // Return a deep copy to prevent external mutations affecting cache
        return structuredClone(cached.store);
      }
      invalidateSessionStoreCache(storePath);
    }
  }

  // Cache miss or disabled - load from disk
  let store: Record<string, SessionEntry> = {};
  let mtimeMs = getFileMtimeMs(storePath);
  try {
    const raw = fs.readFileSync(storePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (isSessionStoreRecord(parsed)) {
      store = parsed;
    }
    mtimeMs = getFileMtimeMs(storePath) ?? mtimeMs;
  } catch {
    // ignore missing/invalid store; we'll recreate it
  }

  // Best-effort migration: message provider → channel naming.
  for (const entry of Object.values(store)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const rec = entry as unknown as Record<string, unknown>;
    if (typeof rec.channel !== "string" && typeof rec.provider === "string") {
      rec.channel = rec.provider;
      delete rec.provider;
    }
    if (typeof rec.lastChannel !== "string" && typeof rec.lastProvider === "string") {
      rec.lastChannel = rec.lastProvider;
      delete rec.lastProvider;
    }

    // Best-effort migration: legacy `room` field → `groupChannel` (keep value, prune old key).
    if (typeof rec.groupChannel !== "string" && typeof rec.room === "string") {
      rec.groupChannel = rec.room;
      delete rec.room;
    } else if ("room" in rec) {
      delete rec.room;
    }
  }

  // Cache the result if caching is enabled
  if (!opts.skipCache && isSessionStoreCacheEnabled()) {
    SESSION_STORE_CACHE.set(storePath, {
      store: structuredClone(store), // Store a copy to prevent external mutations
      loadedAt: Date.now(),
      storePath,
      mtimeMs,
    });
  }

  return structuredClone(store);
}

export function readSessionUpdatedAt(params: {
  storePath: string;
  sessionKey: string;
}): number | undefined {
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
  opts: { log?: boolean } = {},
): number {
  const maxAgeMs = overrideMaxAgeMs ?? resolveMaintenanceConfig().pruneAfterMs;
  const cutoffMs = Date.now() - maxAgeMs;
  let pruned = 0;
  for (const [key, entry] of Object.entries(store)) {
    if (entry?.updatedAt != null && entry.updatedAt < cutoffMs) {
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
 * Renames the current file to `sessions.json.bak.{timestamp}` and cleans up
 * old rotation backups, keeping only the 3 most recent `.bak.*` files.
 */
export async function rotateSessionFile(
  storePath: string,
  overrideBytes?: number,
): Promise<boolean> {
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

async function saveSessionStoreUnlocked(
  storePath: string,
  store: Record<string, SessionEntry>,
  opts?: SaveSessionStoreOptions,
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
      pruneStaleEntries(store, maintenance.pruneAfterMs);
      capEntryCount(store, maintenance.maxEntries);

      // Rotate the on-disk file if it exceeds the size threshold.
      await rotateSessionFile(storePath, maintenance.rotateBytes);
    }
  }

  await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
  const json = JSON.stringify(store, null, 2);

  // Windows: avoid atomic rename swaps (can be flaky under concurrent access).
  // We serialize writers via the session-store lock instead.
  if (process.platform === "win32") {
    try {
      await fs.promises.writeFile(storePath, json, "utf-8");
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err
          ? String((err as { code?: unknown }).code)
          : null;
      if (code === "ENOENT") {
        return;
      }
      throw err;
    }
    return;
  }

  const tmp = `${storePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(tmp, json, { mode: 0o600, encoding: "utf-8" });
    await fs.promises.rename(tmp, storePath);
    // Ensure permissions are set even if rename loses them
    await fs.promises.chmod(storePath, 0o600);
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code?: unknown }).code)
        : null;

    if (code === "ENOENT") {
      // In tests the temp session-store directory may be deleted while writes are in-flight.
      // Best-effort: try a direct write (recreating the parent dir), otherwise ignore.
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
    const result = await mutator(store);
    await saveSessionStoreUnlocked(storePath, store, opts);
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
  timeoutAt?: number;
  staleMs: number;
  timer?: ReturnType<typeof setTimeout>;
  started: boolean;
  timedOut: boolean;
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

function removePendingTask(queue: SessionStoreLockQueue, task: SessionStoreLockTask): void {
  const idx = queue.pending.indexOf(task);
  if (idx >= 0) {
    queue.pending.splice(idx, 1);
  }
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
      if (!task || task.timedOut) {
        continue;
      }

      if (task.timer) {
        clearTimeout(task.timer);
      }
      task.started = true;

      const remainingTimeoutMs =
        task.timeoutAt != null
          ? Math.max(0, task.timeoutAt - Date.now())
          : Number.POSITIVE_INFINITY;
      if (task.timeoutAt != null && remainingTimeoutMs <= 0) {
        task.timedOut = true;
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
  const timeoutAt = hasTimeout ? Date.now() + timeoutMs : undefined;
  const queue = getOrCreateLockQueue(storePath);

  const promise = new Promise<T>((resolve, reject) => {
    const task: SessionStoreLockTask = {
      fn: async () => await fn(),
      resolve: (value) => resolve(value as T),
      reject,
      timeoutAt,
      staleMs,
      started: false,
      timedOut: false,
    };

    if (hasTimeout) {
      task.timer = setTimeout(() => {
        if (task.started || task.timedOut) {
          return;
        }
        task.timedOut = true;
        removePendingTask(queue, task);
        reject(lockTimeoutError(storePath));
      }, timeoutMs);
    }

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
