import { createHash } from "node:crypto";
import { createDedupeCache } from "../infra/dedupe.js";
import { createPluginStateSyncKeyedStore } from "./plugin-state-runtime.js";

type PersistentDedupeRow = {
  scopeKey: string;
  namespace: string;
  key: string;
  seenAt: number;
};

export type PersistentDedupeOptions = {
  ttlMs: number;
  memoryMaxSize: number;
  maxEntries: number;
  resolveScopeKey: (namespace: string) => string;
  onStorageError?: (error: unknown) => void;
};

export type PersistentDedupeCheckOptions = {
  namespace?: string;
  now?: number;
  onStorageError?: (error: unknown) => void;
};

export type PersistentDedupe = {
  checkAndRecord: (key: string, options?: PersistentDedupeCheckOptions) => Promise<boolean>;
  hasRecent: (key: string, options?: PersistentDedupeCheckOptions) => Promise<boolean>;
  warmup: (namespace?: string, onError?: (error: unknown) => void) => Promise<number>;
  clearMemory: () => void;
  memorySize: () => number;
};

export type ClaimableDedupeClaimResult =
  | { kind: "claimed" }
  | { kind: "duplicate" }
  | { kind: "inflight"; pending: Promise<boolean> };

export type ClaimableDedupeOptions =
  | {
      ttlMs: number;
      memoryMaxSize: number;
      resolveScopeKey: (namespace: string) => string;
      maxEntries: number;
      onStorageError?: (error: unknown) => void;
    }
  | {
      ttlMs: number;
      memoryMaxSize: number;
      resolveScopeKey?: undefined;
      maxEntries?: undefined;
      onStorageError?: undefined;
    };

export type ClaimableDedupe = {
  claim: (
    key: string,
    options?: PersistentDedupeCheckOptions,
  ) => Promise<ClaimableDedupeClaimResult>;
  commit: (key: string, options?: PersistentDedupeCheckOptions) => Promise<boolean>;
  release: (
    key: string,
    options?: {
      namespace?: string;
      error?: unknown;
    },
  ) => void;
  hasRecent: (key: string, options?: PersistentDedupeCheckOptions) => Promise<boolean>;
  warmup: (namespace?: string, onError?: (error: unknown) => void) => Promise<number>;
  clearMemory: () => void;
  memorySize: () => number;
};

const PERSISTENT_DEDUPE_STORE = createPluginStateSyncKeyedStore<PersistentDedupeRow>(
  "persistent-dedupe",
  {
    namespace: "entries",
    maxEntries: 200_000,
  },
);

function resolveNamespace(namespace?: string): string {
  return namespace?.trim() || "global";
}

function resolveScopedKey(namespace: string, key: string): string {
  return `${namespace}:${key}`;
}

function resolveStoreKey(scopeKey: string, namespace: string, key: string): string {
  return createHash("sha256")
    .update(`${scopeKey}\0${namespace}\0${key}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

function prunePersistentRows(
  scopeKey: string,
  now: number,
  ttlMs: number,
  maxEntries: number,
): void {
  const scopedEntries = PERSISTENT_DEDUPE_STORE.entries()
    .filter((entry) => entry.value.scopeKey === scopeKey)
    .toSorted((left, right) => left.value.seenAt - right.value.seenAt);
  for (const entry of scopedEntries) {
    if (ttlMs > 0 && now - entry.value.seenAt >= ttlMs) {
      PERSISTENT_DEDUPE_STORE.delete(entry.key);
    }
  }
  const retained = PERSISTENT_DEDUPE_STORE.entries()
    .filter((entry) => entry.value.scopeKey === scopeKey)
    .toSorted((left, right) => left.value.seenAt - right.value.seenAt);
  if (retained.length <= maxEntries) {
    return;
  }
  for (const entry of retained.slice(0, retained.length - maxEntries)) {
    PERSISTENT_DEDUPE_STORE.delete(entry.key);
  }
}

function isRecentTimestamp(seenAt: number | undefined, ttlMs: number, now: number): boolean {
  return seenAt != null && (ttlMs <= 0 || now - seenAt < ttlMs);
}

/** Create a dedupe helper that combines in-memory fast checks with SQLite-backed storage. */
export function createPersistentDedupe(options: PersistentDedupeOptions): PersistentDedupe {
  const ttlMs = Math.max(0, Math.floor(options.ttlMs));
  const memoryMaxSize = Math.max(0, Math.floor(options.memoryMaxSize));
  const maxEntries = Math.max(1, Math.floor(options.maxEntries));
  const memory = createDedupeCache({ ttlMs, maxSize: memoryMaxSize });
  const inflight = new Map<string, Promise<boolean>>();

  async function checkAndRecordInner(
    key: string,
    namespace: string,
    scopedKey: string,
    now: number,
    onStorageError?: (error: unknown) => void,
  ): Promise<boolean> {
    if (memory.check(scopedKey, now)) {
      return false;
    }

    try {
      const scopeKey = options.resolveScopeKey(namespace);
      const storeKey = resolveStoreKey(scopeKey, namespace, key);
      const existing = PERSISTENT_DEDUPE_STORE.lookup(storeKey);
      const existingSeenAt = existing?.seenAt;
      if (isRecentTimestamp(existingSeenAt, ttlMs, now)) {
        memory.check(scopedKey, existingSeenAt);
        return false;
      }
      PERSISTENT_DEDUPE_STORE.register(
        storeKey,
        { scopeKey, namespace, key, seenAt: now },
        ttlMs > 0 ? { ttlMs } : undefined,
      );
      prunePersistentRows(scopeKey, now, ttlMs, maxEntries);
      memory.check(scopedKey, now);
      return true;
    } catch (error) {
      onStorageError?.(error);
      memory.check(scopedKey, now);
      return true;
    }
  }

  async function hasRecentInner(
    key: string,
    namespace: string,
    scopedKey: string,
    now: number,
    onStorageError?: (error: unknown) => void,
  ): Promise<boolean> {
    if (memory.peek(scopedKey, now)) {
      return true;
    }

    try {
      const scopeKey = options.resolveScopeKey(namespace);
      const storeKey = resolveStoreKey(scopeKey, namespace, key);
      const entry = PERSISTENT_DEDUPE_STORE.lookup(storeKey);
      const seenAt = entry?.seenAt;
      if (!isRecentTimestamp(seenAt, ttlMs, now)) {
        return false;
      }
      memory.check(scopedKey, seenAt);
      return true;
    } catch (error) {
      onStorageError?.(error);
      return memory.peek(scopedKey, now);
    }
  }

  async function warmup(namespace = "global", onError?: (error: unknown) => void): Promise<number> {
    const now = Date.now();
    try {
      const scopeKey = options.resolveScopeKey(namespace);
      let loaded = 0;
      for (const entry of PERSISTENT_DEDUPE_STORE.entries()) {
        if (entry.value.scopeKey !== scopeKey || entry.value.namespace !== namespace) {
          continue;
        }
        if (ttlMs > 0 && now - entry.value.seenAt >= ttlMs) {
          PERSISTENT_DEDUPE_STORE.delete(entry.key);
          continue;
        }
        const scopedKey = `${namespace}:${entry.value.key}`;
        memory.check(scopedKey, entry.value.seenAt);
        loaded++;
      }
      return loaded;
    } catch (error) {
      onError?.(error);
      return 0;
    }
  }

  async function checkAndRecord(
    key: string,
    dedupeOptions?: PersistentDedupeCheckOptions,
  ): Promise<boolean> {
    const trimmed = key.trim();
    if (!trimmed) {
      return true;
    }
    const namespace = resolveNamespace(dedupeOptions?.namespace);
    const scopedKey = resolveScopedKey(namespace, trimmed);
    if (inflight.has(scopedKey)) {
      return false;
    }

    const onStorageError = dedupeOptions?.onStorageError ?? options.onStorageError;
    const now = dedupeOptions?.now ?? Date.now();
    const work = checkAndRecordInner(trimmed, namespace, scopedKey, now, onStorageError);
    inflight.set(scopedKey, work);
    try {
      return await work;
    } finally {
      inflight.delete(scopedKey);
    }
  }

  async function hasRecent(
    key: string,
    dedupeOptions?: PersistentDedupeCheckOptions,
  ): Promise<boolean> {
    const trimmed = key.trim();
    if (!trimmed) {
      return false;
    }
    const namespace = resolveNamespace(dedupeOptions?.namespace);
    const scopedKey = resolveScopedKey(namespace, trimmed);
    const onStorageError = dedupeOptions?.onStorageError ?? options.onStorageError;
    const now = dedupeOptions?.now ?? Date.now();
    return hasRecentInner(trimmed, namespace, scopedKey, now, onStorageError);
  }

  return {
    checkAndRecord,
    hasRecent,
    warmup,
    clearMemory: () => memory.clear(),
    memorySize: () => memory.size(),
  };
}

function createReleasedClaimError(scopedKey: string): Error {
  return new Error(`claim released before commit: ${scopedKey}`);
}

/** Create a claim/commit/release dedupe guard backed by memory and optional persistent storage. */
export function createClaimableDedupe(options: ClaimableDedupeOptions): ClaimableDedupe {
  const ttlMs = Math.max(0, Math.floor(options.ttlMs));
  const memoryMaxSize = Math.max(0, Math.floor(options.memoryMaxSize));
  const memory = createDedupeCache({ ttlMs, maxSize: memoryMaxSize });
  const persistent =
    options.resolveScopeKey != null
      ? createPersistentDedupe({
          ttlMs,
          memoryMaxSize,
          maxEntries: Math.max(1, Math.floor(options.maxEntries)),
          resolveScopeKey: options.resolveScopeKey,
          onStorageError: options.onStorageError,
        })
      : null;

  const inflight = new Map<
    string,
    {
      promise: Promise<boolean>;
      resolve: (result: boolean) => void;
      reject: (error: unknown) => void;
    }
  >();

  async function hasRecent(
    key: string,
    dedupeOptions?: PersistentDedupeCheckOptions,
  ): Promise<boolean> {
    const trimmed = key.trim();
    if (!trimmed) {
      return false;
    }
    const namespace = resolveNamespace(dedupeOptions?.namespace);
    const scopedKey = resolveScopedKey(namespace, trimmed);
    if (persistent) {
      return persistent.hasRecent(trimmed, dedupeOptions);
    }
    return memory.peek(scopedKey, dedupeOptions?.now);
  }

  async function claim(
    key: string,
    dedupeOptions?: PersistentDedupeCheckOptions,
  ): Promise<ClaimableDedupeClaimResult> {
    const trimmed = key.trim();
    if (!trimmed) {
      return { kind: "claimed" };
    }
    const namespace = resolveNamespace(dedupeOptions?.namespace);
    const scopedKey = resolveScopedKey(namespace, trimmed);
    const existing = inflight.get(scopedKey);
    if (existing) {
      return { kind: "inflight", pending: existing.promise };
    }

    let resolve!: (result: boolean) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<boolean>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    void promise.catch(() => {});
    inflight.set(scopedKey, { promise, resolve, reject });
    try {
      if (await hasRecent(trimmed, dedupeOptions)) {
        resolve(false);
        inflight.delete(scopedKey);
        return { kind: "duplicate" };
      }
      return { kind: "claimed" };
    } catch (error) {
      reject(error);
      inflight.delete(scopedKey);
      throw error;
    }
  }

  async function commit(
    key: string,
    dedupeOptions?: PersistentDedupeCheckOptions,
  ): Promise<boolean> {
    const trimmed = key.trim();
    if (!trimmed) {
      return true;
    }
    const namespace = resolveNamespace(dedupeOptions?.namespace);
    const scopedKey = resolveScopedKey(namespace, trimmed);
    const claim = inflight.get(scopedKey);
    try {
      const recorded = persistent
        ? await persistent.checkAndRecord(trimmed, dedupeOptions)
        : !memory.check(scopedKey, dedupeOptions?.now);
      claim?.resolve(recorded);
      return recorded;
    } catch (error) {
      claim?.reject(error);
      throw error;
    } finally {
      inflight.delete(scopedKey);
    }
  }

  function release(
    key: string,
    dedupeOptions?: {
      namespace?: string;
      error?: unknown;
    },
  ): void {
    const trimmed = key.trim();
    if (!trimmed) {
      return;
    }
    const namespace = resolveNamespace(dedupeOptions?.namespace);
    const scopedKey = resolveScopedKey(namespace, trimmed);
    const claim = inflight.get(scopedKey);
    if (!claim) {
      return;
    }
    claim.reject(dedupeOptions?.error ?? createReleasedClaimError(scopedKey));
    inflight.delete(scopedKey);
  }

  return {
    claim,
    commit,
    release,
    hasRecent,
    warmup: persistent?.warmup ?? (async () => 0),
    clearMemory: () => {
      persistent?.clearMemory();
      memory.clear();
    },
    memorySize: () => persistent?.memorySize() ?? memory.size(),
  };
}
