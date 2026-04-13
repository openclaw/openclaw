import { createHash } from "node:crypto";
import fs from "node:fs";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { normalizeSessionDeliveryFields } from "../../utils/delivery-context.shared.js";
import { getFileStatSnapshot } from "../cache-utils.js";
import {
  resolveSessionObjectCacheMaxBytes,
  SESSION_OBJECT_CACHE_MAX_BYTES_ENV,
} from "./store-cache-limit.js";
import {
  dropSessionStoreObjectCache,
  getSerializedSessionStore,
  getSessionStoreTtl,
  isSessionStoreCacheEnabled,
  readSessionStoreCache,
  setSerializedSessionStore,
  writeSessionStoreCache,
} from "./store-cache.js";
import {
  capEntryCount,
  pruneStaleEntries,
  resolveMaintenanceConfigFromInput,
  type ResolvedSessionMaintenanceConfig,
} from "./store-maintenance.js";
import { applySessionStoreMigrations } from "./store-migrations.js";
import { normalizeSessionRuntimeModelFields, type SessionEntry } from "./types.js";

export type LoadSessionStoreOptions = {
  skipCache?: boolean;
  maintenanceConfig?: ResolvedSessionMaintenanceConfig;
};

const log = createSubsystemLogger("sessions/store");
const WARNED_SESSION_OBJECT_CACHE_LIMIT_PATHS = new Set<string>();
type LoadedSessionStoreSnapshot = {
  serializedFromDisk?: string;
  serializedDigest?: string;
  acpByKey: Map<string, NonNullable<SessionEntry["acp"]>>;
};
let loadedSessionStoreSnapshots = new WeakMap<
  Record<string, SessionEntry>,
  LoadedSessionStoreSnapshot
>();

export function clearSessionObjectCacheLimitWarningsForTest(): void {
  WARNED_SESSION_OBJECT_CACHE_LIMIT_PATHS.clear();
}

export function clearLoadedSessionStoreSnapshotsForTest(): void {
  loadedSessionStoreSnapshots = new WeakMap();
}

export function rememberLoadedSessionStoreSnapshot(params: {
  store: Record<string, SessionEntry>;
  serializedFromDisk?: string;
  retainSerializedFromDisk?: boolean;
}): void {
  const retainSerializedFromDisk = params.retainSerializedFromDisk ?? true;
  loadedSessionStoreSnapshots.set(params.store, {
    serializedFromDisk: retainSerializedFromDisk ? params.serializedFromDisk : undefined,
    serializedDigest:
      !retainSerializedFromDisk && params.serializedFromDisk
        ? createHash("sha256").update(params.serializedFromDisk).digest("hex")
        : undefined,
    acpByKey: collectAcpMetadataSnapshot(params.store),
  });
}

export function getLoadedSessionStoreSnapshot(
  store: Record<string, SessionEntry> | undefined,
): LoadedSessionStoreSnapshot | undefined {
  if (!store) {
    return undefined;
  }
  return loadedSessionStoreSnapshots.get(store);
}

export function forgetLoadedSessionStoreSnapshot(
  store: Record<string, SessionEntry> | undefined,
): void {
  if (!store) {
    return;
  }
  loadedSessionStoreSnapshots.delete(store);
}

function isSessionStoreRecord(value: unknown): value is Record<string, SessionEntry> {
  return !!value && typeof value === "object" && !Array.isArray(value);
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

function warnSessionObjectCacheLimitHit(params: {
  storePath: string;
  sizeBytes: number;
  limitBytes: number;
}): void {
  if (WARNED_SESSION_OBJECT_CACHE_LIMIT_PATHS.has(params.storePath)) {
    return;
  }
  WARNED_SESSION_OBJECT_CACHE_LIMIT_PATHS.add(params.storePath);
  log.warn("session object cache disabled for large store", {
    storePath: params.storePath,
    sizeBytes: params.sizeBytes,
    limitBytes: params.limitBytes,
    envVar: SESSION_OBJECT_CACHE_MAX_BYTES_ENV,
  });
}

export function isSessionStoreObjectCacheEligible(params: {
  storePath: string;
  sizeBytes?: number;
}): boolean {
  if (!isSessionStoreCacheEnabled()) {
    return false;
  }
  const maxBytes = resolveSessionObjectCacheMaxBytes();
  if (maxBytes === 0) {
    dropSessionStoreObjectCache(params.storePath);
    return false;
  }
  if (params.sizeBytes !== undefined && params.sizeBytes > maxBytes) {
    warnSessionObjectCacheLimitHit({
      storePath: params.storePath,
      sizeBytes: params.sizeBytes,
      limitBytes: maxBytes,
    });
    dropSessionStoreObjectCache(params.storePath);
    return false;
  }
  return true;
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

export function normalizeSessionStore(store: Record<string, SessionEntry>): void {
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

export function loadSessionStore(
  storePath: string,
  opts: LoadSessionStoreOptions = {},
): Record<string, SessionEntry> {
  if (!opts.skipCache) {
    const currentFileStat = getFileStatSnapshot(storePath);
    if (
      isSessionStoreObjectCacheEligible({
        storePath,
        sizeBytes: currentFileStat?.sizeBytes,
      })
    ) {
      const cached = readSessionStoreCache({
        storePath,
        mtimeMs: currentFileStat?.mtimeMs,
        sizeBytes: currentFileStat?.sizeBytes,
      });
      if (cached) {
        rememberLoadedSessionStoreSnapshot({
          store: cached,
          serializedFromDisk: getSerializedSessionStore({
            storePath,
            ttlMs: getSessionStoreTtl(),
          }),
        });
        return cached;
      }
    }
  }

  // Retry a few times on Windows because readers can briefly observe empty or
  // transiently invalid content while another process is swapping the file.
  let store: Record<string, SessionEntry> = {};
  let fileStat = getFileStatSnapshot(storePath);
  let mtimeMs = fileStat?.mtimeMs;
  let serializedFromDisk: string | undefined;
  const maxReadAttempts = process.platform === "win32" ? 3 : 1;
  const retryBuf = maxReadAttempts > 1 ? new Int32Array(new SharedArrayBuffer(4)) : undefined;
  for (let attempt = 0; attempt < maxReadAttempts; attempt += 1) {
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
      mtimeMs = fileStat?.mtimeMs;
      break;
    } catch {
      if (attempt < maxReadAttempts - 1) {
        Atomics.wait(retryBuf!, 0, 0, 50);
        continue;
      }
    }
  }

  if (
    serializedFromDisk !== undefined &&
    shouldRetainSessionStoreSerializedCache(fileStat?.sizeBytes)
  ) {
    setSerializedSessionStore(storePath, serializedFromDisk);
  } else {
    setSerializedSessionStore(storePath, undefined);
  }

  applySessionStoreMigrations(store);
  normalizeSessionStore(store);
  const maintenance = opts.maintenanceConfig ?? resolveMaintenanceConfigFromInput();
  if (maintenance.mode === "enforce" && Object.keys(store).length > maintenance.maxEntries) {
    const beforeCount = Object.keys(store).length;
    const pruned = pruneStaleEntries(store, maintenance.pruneAfterMs, { log: false });
    const capped = capEntryCount(store, maintenance.maxEntries, { log: false });
    const afterCount = Object.keys(store).length;
    if (pruned > 0 || capped > 0) {
      serializedFromDisk = undefined;
      setSerializedSessionStore(storePath, undefined);
      log.info("applied load-time maintenance to oversized session store", {
        storePath,
        before: beforeCount,
        after: afterCount,
        pruned,
        capped,
        maxEntries: maintenance.maxEntries,
      });
    }
  }

  if (
    !opts.skipCache &&
    isSessionStoreObjectCacheEligible({
      storePath,
      sizeBytes: fileStat?.sizeBytes,
    })
  ) {
    writeSessionStoreCache({
      storePath,
      store,
      mtimeMs,
      sizeBytes: fileStat?.sizeBytes,
      serialized: serializedFromDisk,
    });
  } else if (!opts.skipCache) {
    dropSessionStoreObjectCache(storePath);
  }

  const clonedStore = structuredClone(store);
  const retainSerializedFromDisk = shouldRetainSessionStoreSerializedCache(fileStat?.sizeBytes);
  rememberLoadedSessionStoreSnapshot({
    store: clonedStore,
    serializedFromDisk,
    retainSerializedFromDisk,
  });
  return clonedStore;
}
