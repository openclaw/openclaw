import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  acquireSessionWriteLock,
  resolveSessionLockMaxHoldFromTimeout,
} from "../../agents/session-write-lock.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import { writeTextAtomic } from "../../infra/json-files.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  deliveryContextFromSession,
  mergeDeliveryContext,
  normalizeDeliveryContext,
  normalizeSessionDeliveryFields,
} from "../../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { getFileStatSnapshot } from "../cache-utils.js";
import { enforceSessionDiskBudget, type SessionDiskBudgetSweepResult } from "./disk-budget.js";
import { deriveSessionMetaPatch } from "./metadata.js";
import { resolveSessionObjectCacheMaxBytes } from "./store-cache-limit.js";
import {
  dropSessionStoreObjectCache,
  getSerializedSessionStore,
  getSessionStoreTtl,
  isSessionStoreCacheEnabled,
  setSerializedSessionStore,
  writeSessionStoreCache,
} from "./store-cache.js";
import { normalizeStoreSessionKey, resolveSessionStoreEntry } from "./store-entry.js";
import {
  copyLoadedSessionStoreSnapshot,
  forgetLoadedSessionStoreSnapshot,
  getLoadedSessionStoreSnapshot,
  isSessionStoreObjectCacheEligible,
  loadSessionStore,
  rememberLoadedSessionStoreSnapshot,
  normalizeSessionStore,
} from "./store-load.js";
import {
  clearSessionStoreCacheForTest,
  drainSessionStoreLockQueuesForTest,
  getSessionStoreLockQueueSizeForTest,
  LOCK_QUEUES,
  type SessionStoreLockQueue,
  type SessionStoreLockTask,
} from "./store-lock-state.js";
import { resolveMaintenanceConfig } from "./store-maintenance-runtime.js";
import {
  capEntryCount,
  getActiveSessionMaintenanceWarning,
  pruneStaleEntries,
  rotateSessionFile,
  type ResolvedSessionMaintenanceConfig,
  type SessionMaintenanceWarning,
} from "./store-maintenance.js";
import {
  mergeSessionEntry,
  mergeSessionEntryPreserveActivity,
  type SessionEntry,
} from "./types.js";

export {
  clearSessionStoreCacheForTest,
  drainSessionStoreLockQueuesForTest,
  getSessionStoreLockQueueSizeForTest,
} from "./store-lock-state.js";
export { loadSessionStore } from "./store-load.js";
export { normalizeStoreSessionKey, resolveSessionStoreEntry } from "./store-entry.js";

const log = createSubsystemLogger("sessions/store");
let sessionArchiveRuntimePromise: Promise<
  typeof import("../../gateway/session-archive.runtime.js")
> | null = null;
let sessionWriteLockAcquirerForTests: typeof acquireSessionWriteLock | null = null;

function loadSessionArchiveRuntime() {
  sessionArchiveRuntimePromise ??= import("../../gateway/session-archive.runtime.js");
  return sessionArchiveRuntimePromise;
}

export function getLoadedSessionStoreSnapshotForTest(
  store: Record<string, SessionEntry> | undefined,
): { hasSerializedFromDisk: boolean; hasSerializedDigest: boolean } | undefined {
  const snapshot = getLoadedSessionStoreSnapshot(store);
  if (!snapshot) {
    return undefined;
  }
  return {
    hasSerializedFromDisk: snapshot.serializedFromDisk !== undefined,
    hasSerializedDigest: snapshot.serializedDigest !== undefined,
  };
}

function shouldRetainSessionStoreSerializedCache(sizeBytes?: number): boolean {
  if (!isSessionStoreCacheEnabled()) {
    return false;
  }
  const maxBytes = resolveSessionObjectCacheMaxBytes();
  if (maxBytes === 0) {
    return false;
  }
  return sizeBytes === undefined || sizeBytes <= maxBytes;
}

function isSessionStoreSerializedSnapshotEqual(params: {
  storePath: string;
  serialized: string;
}): boolean {
  const cached = getSerializedSessionStore({
    storePath: params.storePath,
    ttlMs: getSessionStoreTtl(),
  });
  if (cached !== undefined) {
    return cached === params.serialized;
  }
  try {
    return fs.readFileSync(params.storePath, "utf-8") === params.serialized;
  } catch {
    return false;
  }
}

function removeThreadFromDeliveryContext(context?: DeliveryContext): DeliveryContext | undefined {
  if (!context || context.threadId == null) {
    return context;
  }
  const next: DeliveryContext = { ...context };
  delete next.threadId;
  return next;
}

export function setSessionWriteLockAcquirerForTests(
  acquirer: typeof acquireSessionWriteLock | null,
): void {
  sessionWriteLockAcquirerForTests = acquirer;
}

export function resetSessionStoreLockRuntimeForTests(): void {
  sessionWriteLockAcquirerForTests = null;
}

export async function withSessionStoreLockForTest<T>(
  storePath: string,
  fn: () => Promise<T>,
  opts: SessionStoreLockOptions = {},
): Promise<T> {
  return await withSessionStoreLock(storePath, fn, opts);
}

export function readSessionUpdatedAt(params: {
  storePath: string;
  sessionKey: string;
}): number | undefined {
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
  /**
   * Session keys that are allowed to drop persisted ACP metadata during this update.
   * All other updates preserve existing `entry.acp` blocks when callers replace the
   * whole session entry without carrying ACP state forward.
   */
  allowDropAcpMetaSessionKeys?: string[];
  /** Optional callback for warn-only maintenance. */
  onWarn?: (warning: SessionMaintenanceWarning) => void | Promise<void>;
  /** Optional callback with maintenance stats after a save. */
  onMaintenanceApplied?: (report: SessionMaintenanceApplyReport) => void | Promise<void>;
  /** Optional overrides used by maintenance commands. */
  maintenanceOverride?: Partial<ResolvedSessionMaintenanceConfig>;
  /** Fully resolved maintenance settings when the caller already has config loaded. */
  maintenanceConfig?: ResolvedSessionMaintenanceConfig;
};

type UpdateSessionStoreOptions = SaveSessionStoreOptions & {
  baseStore?: Record<string, SessionEntry>;
};

function updateSessionStoreWriteCaches(params: {
  storePath: string;
  store: Record<string, SessionEntry>;
  serialized: string;
}): void {
  const fileStat = getFileStatSnapshot(params.storePath);
  const retainSerializedFromDisk = shouldRetainSessionStoreSerializedCache(fileStat?.sizeBytes);
  if (retainSerializedFromDisk) {
    setSerializedSessionStore(params.storePath, params.serialized);
  } else {
    setSerializedSessionStore(params.storePath, undefined);
  }
  if (
    !isSessionStoreObjectCacheEligible({
      storePath: params.storePath,
      sizeBytes: fileStat?.sizeBytes,
    })
  ) {
    rememberLoadedSessionStoreSnapshot({
      store: params.store,
      serializedFromDisk: params.serialized,
      retainSerializedFromDisk,
    });
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
  rememberLoadedSessionStoreSnapshot({
    store: params.store,
    serializedFromDisk: params.serialized,
    retainSerializedFromDisk,
  });
}

function tryReuseLoadedSessionStoreSnapshot(params: {
  storePath: string;
  baseStore?: Record<string, SessionEntry>;
}): Record<string, SessionEntry> | undefined {
  const snapshot = getLoadedSessionStoreSnapshot(params.baseStore);
  if (
    !params.baseStore ||
    (snapshot?.serializedFromDisk === undefined && snapshot?.serializedDigest === undefined)
  ) {
    return undefined;
  }
  try {
    const currentBaseStoreSerialized = JSON.stringify(params.baseStore, null, 2);
    if (
      snapshot.serializedFromDisk !== undefined &&
      currentBaseStoreSerialized !== snapshot.serializedFromDisk &&
      !isAcpScopedBaseStoreDrift(params.baseStore, snapshot)
    ) {
      return undefined;
    }
    if (
      snapshot.serializedDigest !== undefined &&
      createHash("sha256").update(currentBaseStoreSerialized).digest("hex") !==
        snapshot.serializedDigest
    ) {
      return undefined;
    }

    const serialized = fs.readFileSync(params.storePath, "utf-8");
    if (snapshot.serializedFromDisk !== undefined) {
      if (serialized !== snapshot.serializedFromDisk) {
        return undefined;
      }
      return params.baseStore;
    }
    if (createHash("sha256").update(serialized).digest("hex") !== snapshot.serializedDigest) {
      return undefined;
    }
    return params.baseStore;
  } catch {
    return undefined;
  }
}

function isAcpScopedBaseStoreDrift(
  baseStore: Record<string, SessionEntry>,
  snapshot: {
    serializedFromDisk?: string;
    acpByKey: Map<string, NonNullable<SessionEntry["acp"]>>;
  },
): boolean {
  if (snapshot.serializedFromDisk === undefined) {
    return false;
  }
  let parsedSnapshot: Record<string, SessionEntry>;
  try {
    const parsed = JSON.parse(snapshot.serializedFromDisk);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false;
    }
    parsedSnapshot = parsed as Record<string, SessionEntry>;
  } catch {
    return false;
  }

  const allKeys = new Set([...Object.keys(parsedSnapshot), ...Object.keys(baseStore)]);
  for (const key of allKeys) {
    const before = parsedSnapshot[key];
    const after = baseStore[key];
    if (JSON.stringify(before) === JSON.stringify(after)) {
      continue;
    }
    if (!snapshot.acpByKey.has(key)) {
      return false;
    }
  }
  return true;
}

function syncSessionStoreInPlace(params: {
  target: Record<string, SessionEntry>;
  source: Record<string, SessionEntry>;
}): void {
  for (const key of Object.keys(params.target)) {
    if (!(key in params.source)) {
      delete params.target[key];
    }
  }
  for (const [key, entry] of Object.entries(params.source)) {
    params.target[key] = structuredClone(entry);
  }
}

function resolveMutableSessionStoreKey(
  store: Record<string, SessionEntry>,
  sessionKey: string,
): string | undefined {
  const trimmed = sessionKey.trim();
  if (!trimmed) {
    return undefined;
  }
  if (Object.prototype.hasOwnProperty.call(store, trimmed)) {
    return trimmed;
  }
  const normalized = normalizeStoreSessionKey(trimmed);
  if (Object.prototype.hasOwnProperty.call(store, normalized)) {
    return normalized;
  }
  return Object.keys(store).find((key) => normalizeStoreSessionKey(key) === normalized);
}

function collectAcpMetadataSnapshot(
  store: Record<string, SessionEntry>,
): Map<string, NonNullable<SessionEntry["acp"]>> {
  const snapshot = new Map<string, NonNullable<SessionEntry["acp"]>>();
  for (const [sessionKey, entry] of Object.entries(store)) {
    if (entry?.acp) {
      snapshot.set(sessionKey, structuredClone(entry.acp));
    }
  }
  return snapshot;
}

function getLoadedSnapshotAcpMetadata(
  store: Record<string, SessionEntry> | undefined,
): Map<string, NonNullable<SessionEntry["acp"]>> | undefined {
  const snapshot = getLoadedSessionStoreSnapshot(store);
  if (!snapshot) {
    return undefined;
  }
  return new Map(snapshot.acpByKey);
}

function preserveExistingAcpMetadata(params: {
  previousAcpByKey: Map<string, NonNullable<SessionEntry["acp"]>>;
  nextStore: Record<string, SessionEntry>;
  allowDropSessionKeys?: string[];
}): void {
  const allowDrop = new Set(
    (params.allowDropSessionKeys ?? []).map((key) => normalizeStoreSessionKey(key)),
  );
  for (const [previousKey, previousAcp] of params.previousAcpByKey.entries()) {
    const normalizedKey = normalizeStoreSessionKey(previousKey);
    if (allowDrop.has(normalizedKey)) {
      continue;
    }
    const nextKey = resolveMutableSessionStoreKey(params.nextStore, previousKey);
    if (!nextKey) {
      continue;
    }
    const nextEntry = params.nextStore[nextKey];
    if (!nextEntry || nextEntry.acp) {
      continue;
    }
    params.nextStore[nextKey] = {
      ...nextEntry,
      acp: previousAcp,
    };
  }
}

async function saveSessionStoreUnlocked(
  storePath: string,
  store: Record<string, SessionEntry>,
  opts?: SaveSessionStoreOptions,
): Promise<void> {
  normalizeSessionStore(store);

  if (!opts?.skipMaintenance) {
    // Resolve maintenance config once (avoids repeated loadConfig() calls).
    const maintenance = opts?.maintenanceConfig
      ? { ...opts.maintenanceConfig, ...opts?.maintenanceOverride }
      : { ...resolveMaintenanceConfig(), ...opts?.maintenanceOverride };
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
      const archivedForDeletedSessions = await archiveRemovedSessionTranscripts({
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
        const { cleanupArchivedSessionTranscripts } = await loadSessionArchiveRuntime();
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

      // Rotate the on-disk file if it exceeds the size threshold.
      await rotateSessionFile(storePath, maintenance.rotateBytes);

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

  await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
  const json = JSON.stringify(store, null, 2);
  if (isSessionStoreSerializedSnapshotEqual({ storePath, serialized: json })) {
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
          forgetLoadedSessionStoreSnapshot(store);
          return;
        }
        if (i < 4) {
          await new Promise((r) => setTimeout(r, 50 * (i + 1)));
          continue;
        }
        // Final attempt failed — skip this save. The write lock ensures
        // the next save will retry with fresh data. Log for diagnostics.
        forgetLoadedSessionStoreSnapshot(store);
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
      // In tests the temp session-store directory may be deleted while writes are in-flight.
      // Best-effort: try a direct write (recreating the parent dir), otherwise ignore.
      try {
        await writeSessionStoreAtomic({ storePath, store, serialized: json });
      } catch (err2) {
        const code2 = getErrorCode(err2);
        if (code2 === "ENOENT") {
          forgetLoadedSessionStoreSnapshot(store);
          return;
        }
        forgetLoadedSessionStoreSnapshot(store);
        throw err2;
      }
      return;
    }

    forgetLoadedSessionStoreSnapshot(store);
    throw err;
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
  opts?: UpdateSessionStoreOptions,
): Promise<T> {
  return await withSessionStoreLock(storePath, async () => {
    const reusedBaseStore = tryReuseLoadedSessionStoreSnapshot({
      storePath,
      baseStore: opts?.baseStore,
    });
    // Work on a clone so unrelated mutations on a shared baseStore object do not leak into saves.
    const store = reusedBaseStore
      ? structuredClone(reusedBaseStore)
      : loadSessionStore(storePath, { skipCache: true });
    if (reusedBaseStore) {
      copyLoadedSessionStoreSnapshot({
        source: reusedBaseStore,
        target: store,
      });
    }
    const previousAcpByKey =
      getLoadedSnapshotAcpMetadata(reusedBaseStore) ?? collectAcpMetadataSnapshot(store);
    try {
      const result = await mutator(store);
      preserveExistingAcpMetadata({
        previousAcpByKey,
        nextStore: store,
        allowDropSessionKeys: opts?.allowDropAcpMetaSessionKeys,
      });
      await saveSessionStoreUnlocked(storePath, store, opts);
      if (reusedBaseStore) {
        syncSessionStoreInPlace({
          target: reusedBaseStore,
          source: store,
        });
        copyLoadedSessionStoreSnapshot({
          source: store,
          target: reusedBaseStore,
        });
      }
      return result;
    } catch (error) {
      forgetLoadedSessionStoreSnapshot(store);
      throw error;
    }
  });
}

type SessionStoreLockOptions = {
  timeoutMs?: number;
  pollIntervalMs?: number;
  staleMs?: number;
};

const SESSION_STORE_LOCK_MIN_HOLD_MS = 5_000;
const SESSION_STORE_LOCK_TIMEOUT_GRACE_MS = 5_000;

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

export async function archiveRemovedSessionTranscripts(params: {
  removedSessionFiles: Iterable<[string, string | undefined]>;
  referencedSessionIds: ReadonlySet<string>;
  storePath: string;
  reason: "deleted" | "reset";
  restrictToStoreDir?: boolean;
}): Promise<Set<string>> {
  const { archiveSessionTranscripts } = await loadSessionArchiveRuntime();
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
}): Promise<SessionEntry> {
  params.store[params.resolved.normalizedKey] = params.next;
  for (const legacyKey of params.resolved.legacyKeys) {
    delete params.store[legacyKey];
  }
  await saveSessionStoreUnlocked(params.storePath, params.store, {
    activeSessionKey: params.resolved.normalizedKey,
  });
  return params.next;
}

function lockTimeoutError(storePath: string): Error {
  return new Error(`timeout waiting for session store lock: ${storePath}`);
}

function resolveSessionStoreLockMaxHoldMs(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs == null || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return undefined;
  }
  return resolveSessionLockMaxHoldFromTimeout({
    timeoutMs,
    graceMs: SESSION_STORE_LOCK_TIMEOUT_GRACE_MS,
    minMs: SESSION_STORE_LOCK_MIN_HOLD_MS,
  });
}

function getOrCreateLockQueue(storePath: string): SessionStoreLockQueue {
  const existing = LOCK_QUEUES.get(storePath);
  if (existing) {
    return existing;
  }
  const created: SessionStoreLockQueue = { running: false, pending: [], drainPromise: null };
  LOCK_QUEUES.set(storePath, created);
  return created;
}

async function drainSessionStoreLockQueue(storePath: string): Promise<void> {
  const queue = LOCK_QUEUES.get(storePath);
  if (!queue) {
    return;
  }
  if (queue.drainPromise) {
    await queue.drainPromise;
    return;
  }
  queue.running = true;
  queue.drainPromise = (async () => {
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
          lock = await (sessionWriteLockAcquirerForTests ?? acquireSessionWriteLock)({
            sessionFile: storePath,
            timeoutMs: remainingTimeoutMs,
            staleMs: task.staleMs,
            maxHoldMs: resolveSessionStoreLockMaxHoldMs(task.timeoutMs),
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
      queue.drainPromise = null;
      if (queue.pending.length === 0) {
        LOCK_QUEUES.delete(storePath);
      } else {
        queueMicrotask(() => {
          void drainSessionStoreLockQueue(storePath);
        });
      }
    }
  })();
  await queue.drainPromise;
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
    const store = loadSessionStore(storePath, { skipCache: true });
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
  return await withSessionStoreLock(storePath, async () => {
    const store = loadSessionStore(storePath);
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
    });
  });
}
