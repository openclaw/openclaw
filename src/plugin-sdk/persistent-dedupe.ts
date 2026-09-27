// Persistent dedupe helpers give plugins bounded replay protection across process restarts.
import fs from "node:fs/promises";
import { resolveNonNegativeIntegerOption } from "../../packages/normalization-core/src/number-coercion.js";
import { createDedupeCache } from "../infra/dedupe.js";
import {
  createChannelReplayGuardWithDedupe,
  type ChannelReplayGuard,
  type ChannelReplayClaimHandle,
  type ChannelReplayGuardParams,
} from "./channel-replay-guard.js";
import { KeyedAsyncQueue } from "./keyed-async-queue.js";
import {
  createPersistentStoreResolver,
  createPersistentDedupeImportEntry,
  hasPluginStateOptions,
  resolveEntryKey,
  resolveNamespace,
  resolveScopedKey,
  type CapturedPersistentStore,
} from "./persistent-dedupe-store.js";
import type {
  ClaimableDedupe,
  ClaimableDedupeClaimResult,
  ClaimableDedupeOptions,
  PersistentDedupe,
  PersistentDedupeCheckOptions,
  PersistentDedupeLegacyPathOptions,
  PersistentDedupeOptions,
  PersistentDedupeEntry,
  PersistentDedupeLegacyJsonImportEntry,
  PersistentDedupePluginStateOptions,
} from "./persistent-dedupe.types.js";

export {
  createPersistentDedupeImportEntry,
  resolvePersistentDedupePluginStateNamespace,
} from "./persistent-dedupe-store.js";
export type { ChannelReplayClaimHandle };
export type {
  ClaimableDedupe,
  ClaimableDedupeClaimResult,
  ClaimableDedupeOptions,
  PersistentDedupe,
  PersistentDedupeCheckOptions,
  PersistentDedupeLegacyPathOptions,
  PersistentDedupeOptions,
  PersistentDedupeEntry,
  PersistentDedupeLegacyJsonImportEntry,
  PersistentDedupePluginStateOptions,
} from "./persistent-dedupe.types.js";

export type PersistentDedupeLegacyJsonMigrationResult = {
  imported: number;
  skippedExpired: number;
  skippedInvalid: number;
  skippedExisting: number;
  removed: boolean;
};

export type PersistentDedupeLegacyJsonMigrationOptions = PersistentDedupePluginStateOptions & {
  filePath: string;
  namespace: string;
  now?: number;
  removeFile?: boolean;
};

type PersistentDedupeLegacyJsonEntriesResult = {
  entries: PersistentDedupeLegacyJsonImportEntry[];
  skippedExpired: number;
  skippedInvalid: number;
};

function isRecentTimestamp(seenAt: number | undefined, ttlMs: number, now: number): boolean {
  return seenAt != null && (ttlMs <= 0 || now - seenAt < ttlMs);
}

function resolveEntrySeenAt(entry: PersistentDedupeEntry | undefined): number | undefined {
  return typeof entry?.seenAt === "number" && Number.isFinite(entry.seenAt)
    ? entry.seenAt
    : undefined;
}

function resolveUnknownEntrySeenAt(value: unknown): number | undefined {
  if (!value || typeof value !== "object" || !("seenAt" in value)) {
    return undefined;
  }
  return typeof value.seenAt === "number" && Number.isFinite(value.seenAt)
    ? value.seenAt
    : undefined;
}

function resolveRemainingTtlMs(
  seenAt: number,
  ttlMs: number,
  now: number,
): { ttlMs: number } | undefined | null {
  if (ttlMs <= 0) {
    return undefined;
  }
  const remaining = ttlMs - (now - seenAt);
  return remaining > 0 ? { ttlMs: Math.max(1, Math.floor(remaining)) } : null;
}

function hasLegacyPathOptions(
  options: ClaimableDedupeOptions | PersistentDedupeOptions,
): options is PersistentDedupeLegacyPathOptions {
  return typeof options.resolveFilePath === "function";
}

function parseLegacyDedupeData(raw: string): {
  data: Record<string, number>;
  invalidCount: number;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { data: {}, invalidCount: 0 };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { data: {}, invalidCount: 0 };
  }
  const data: Record<string, number> = {};
  let invalidCount = 0;
  for (const [key, seenAt] of Object.entries(parsed)) {
    if (typeof seenAt === "number" && Number.isFinite(seenAt) && seenAt > 0) {
      data[key] = seenAt;
    } else {
      invalidCount++;
    }
  }
  return { data, invalidCount };
}

async function readPersistentDedupeLegacyJsonFileEntries(options: {
  filePath: string;
  ttlMs: number;
  now?: number;
}): Promise<PersistentDedupeLegacyJsonEntriesResult> {
  const raw = await fs.readFile(options.filePath, "utf8");
  const { data, invalidCount } = parseLegacyDedupeData(raw);
  const ttlMs = resolveNonNegativeIntegerOption(options.ttlMs, 0);
  const now = options.now ?? Date.now();
  const entries: PersistentDedupeLegacyJsonImportEntry[] = [];
  let skippedExpired = 0;

  for (const [key, seenAt] of Object.entries(data)) {
    const ttlOption = resolveRemainingTtlMs(seenAt, ttlMs, now);
    if (ttlOption === null) {
      skippedExpired++;
      continue;
    }
    entries.push(createPersistentDedupeImportEntry({ key, seenAt, ...ttlOption }));
  }

  return { entries, skippedExpired, skippedInvalid: invalidCount };
}

export async function listPersistentDedupeLegacyJsonFileEntries(options: {
  filePath: string;
  ttlMs: number;
  now?: number;
}): Promise<PersistentDedupeLegacyJsonImportEntry[]> {
  return (await readPersistentDedupeLegacyJsonFileEntries(options)).entries;
}

export function shouldReplacePersistentDedupeEntry(params: {
  existingValue: unknown;
  incomingValue: unknown;
}): boolean {
  const incomingSeenAt = resolveUnknownEntrySeenAt(params.incomingValue);
  return (
    incomingSeenAt != null &&
    incomingSeenAt > (resolveUnknownEntrySeenAt(params.existingValue) ?? 0)
  );
}

/** Import one retired JSON dedupe cache file into plugin-state SQLite during doctor repair. */
export async function migratePersistentDedupeLegacyJsonFile(
  options: PersistentDedupeLegacyJsonMigrationOptions,
): Promise<PersistentDedupeLegacyJsonMigrationResult> {
  const store = createPersistentStoreResolver(options)(resolveNamespace(options.namespace));
  const legacy = await readPersistentDedupeLegacyJsonFileEntries(options);
  const result: PersistentDedupeLegacyJsonMigrationResult = {
    imported: 0,
    skippedExpired: legacy.skippedExpired,
    skippedInvalid: legacy.skippedInvalid,
    skippedExisting: 0,
    removed: false,
  };

  for (const entry of legacy.entries) {
    let observed = await store.get().observe(entry.key);
    for (;;) {
      const currentSeenAt = resolveEntrySeenAt(observed.value);
      const outcome = await store
        .get()
        .compareAndApply(
          entry.key,
          observed.comparison,
          currentSeenAt != null && currentSeenAt >= entry.value.seenAt
            ? { operation: "update", action: "keep" }
            : { operation: "update", action: "set", value: entry.value, ttlMs: entry.ttlMs },
        );
      if (outcome.status === "conflict") {
        observed = outcome.current;
        continue;
      }
      if (outcome.status === "applied") {
        result.imported++;
      } else {
        result.skippedExisting++;
      }
      break;
    }
  }

  if (options.removeFile !== false) {
    if (legacy.entries.length > 0) {
      // Durable completion must still belong to this database before retiring its source.
      store.get();
    }
    await fs.rm(options.filePath, { force: true });
    result.removed = true;
  }
  return result;
}

/** Create a dedupe helper that combines in-memory fast checks with SQLite-backed state. */
export function createPersistentDedupe(options: PersistentDedupeOptions): PersistentDedupe {
  const ttlMs = resolveNonNegativeIntegerOption(options.ttlMs, 0);
  const memoryMaxSize = resolveNonNegativeIntegerOption(options.memoryMaxSize, 0);
  const captureStore = createPersistentStoreResolver(options);
  const memory = createDedupeCache({ ttlMs, maxSize: memoryMaxSize });
  const inflight = new Map<string, Promise<boolean>>();
  // Namespace ordering keeps a queued forget after earlier writes and warmup reads.
  const operations = new KeyedAsyncQueue();
  // A synchronous clear/forget must fence memory publication from older worker results.
  let memoryGeneration = 0;

  async function checkAndRecordInner(
    key: string,
    store: CapturedPersistentStore,
    scopedKey: string,
    now: number,
    generation: number,
    onDiskError?: (error: unknown) => void,
  ): Promise<boolean> {
    const cached = memory.peek(scopedKey, now);
    if (generation === memoryGeneration) {
      memory.check(scopedKey, now);
    }
    if (cached) {
      return false;
    }

    try {
      const entryKey = resolveEntryKey(key);
      let observed = await store.get().observe(entryKey);
      for (;;) {
        const seenAt = resolveEntrySeenAt(observed.value);
        const duplicate = isRecentTimestamp(seenAt, ttlMs, now);
        const outcome = await store.get().compareAndApply(
          entryKey,
          observed.comparison,
          duplicate
            ? { operation: "update", action: "keep" }
            : {
                operation: "update",
                action: "set",
                value: { key, seenAt: now },
                ...(ttlMs > 0 ? { ttlMs } : {}),
              },
        );
        if (outcome.status === "conflict") {
          observed = outcome.current;
          continue;
        }
        if (generation === memoryGeneration) {
          memory.check(scopedKey, duplicate ? seenAt : now);
        }
        return !duplicate;
      }
    } catch (error) {
      onDiskError?.(error);
      if (generation === memoryGeneration) {
        memory.check(scopedKey, now);
      }
      return true;
    }
  }

  async function hasRecentInner(
    key: string,
    store: CapturedPersistentStore,
    scopedKey: string,
    now: number,
    generation: number,
    onDiskError?: (error: unknown) => void,
  ): Promise<boolean> {
    if (memory.peek(scopedKey, now)) {
      return true;
    }

    try {
      const seenAt = resolveEntrySeenAt(await store.get().lookup(resolveEntryKey(key)));
      if (!isRecentTimestamp(seenAt, ttlMs, now)) {
        return false;
      }
      if (generation === memoryGeneration) {
        memory.check(scopedKey, seenAt);
      }
      return true;
    } catch (error) {
      onDiskError?.(error);
      return memory.peek(scopedKey, now);
    }
  }

  async function warmup(namespace = "global", onError?: (error: unknown) => void): Promise<number> {
    const now = Date.now();
    const normalizedNamespace = resolveNamespace(namespace);
    const generation = memoryGeneration;
    const store = captureStore(normalizedNamespace);
    return operations.enqueue(store.namespace, async () => {
      try {
        let loaded = 0;
        for (const entry of await store.get().entries()) {
          const ts = resolveEntrySeenAt(entry.value);
          if (ts == null) {
            continue;
          }
          if (ttlMs > 0 && now - ts >= ttlMs) {
            continue;
          }
          if (generation === memoryGeneration) {
            memory.check(resolveScopedKey(normalizedNamespace, entry.value.key), ts);
            loaded++;
          }
        }
        return loaded;
      } catch (error) {
        onError?.(error);
        return 0;
      }
    });
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

    const onDiskError = dedupeOptions?.onDiskError ?? options.onDiskError;
    const now = dedupeOptions?.now ?? Date.now();
    const generation = memoryGeneration;
    const store = captureStore(namespace);
    const work = operations.enqueue(store.namespace, () =>
      checkAndRecordInner(trimmed, store, scopedKey, now, generation, onDiskError),
    );
    inflight.set(scopedKey, work);
    try {
      return await work;
    } finally {
      if (inflight.get(scopedKey) === work) {
        inflight.delete(scopedKey);
      }
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
    const onDiskError = dedupeOptions?.onDiskError ?? options.onDiskError;
    const now = dedupeOptions?.now ?? Date.now();
    const generation = memoryGeneration;
    const store = captureStore(namespace);
    return operations.enqueue(store.namespace, () =>
      hasRecentInner(trimmed, store, scopedKey, now, generation, onDiskError),
    );
  }

  async function forget(
    key: string,
    dedupeOptions?: PersistentDedupeCheckOptions,
  ): Promise<boolean> {
    const trimmed = key.trim();
    if (!trimmed) {
      return false;
    }
    const namespace = resolveNamespace(dedupeOptions?.namespace);
    const scopedKey = resolveScopedKey(namespace, trimmed);
    memoryGeneration++;
    memory.delete(scopedKey);
    inflight.delete(scopedKey);
    const store = captureStore(namespace);
    return operations.enqueue(store.namespace, async () => {
      try {
        return await store.get().delete(resolveEntryKey(trimmed));
      } catch (error) {
        (dedupeOptions?.onDiskError ?? options.onDiskError)?.(error);
        return false;
      }
    });
  }

  return {
    checkAndRecord,
    hasRecent,
    forget,
    warmup,
    clearMemory: () => {
      memoryGeneration++;
      memory.clear();
    },
    memorySize: () => memory.size(),
  };
}

function createReleasedClaimError(scopedKey: string): Error {
  return new Error(`claim released before commit: ${scopedKey}`);
}

type ClaimLoopInflight = { kind: "inflight"; pending: Promise<boolean> };
type ClaimLoopSettled = { kind: "claimed" } | { kind: "duplicate" } | { kind: "invalid" };

/** Resolve a claim, waiting on an active owner and retrying only when its release allows it. */
export async function runClaimableDedupeClaimLoop<TClaim extends ClaimLoopSettled>(
  claimNext: () => Promise<TClaim | ClaimLoopInflight>,
  retryAfterRejection: (error: unknown, rejectionCount: number) => boolean,
): Promise<TClaim | { kind: "duplicate" }> {
  let rejectionCount = 0;
  while (true) {
    const claim = await claimNext();
    if (claim.kind !== "inflight") {
      return claim;
    }
    try {
      await claim.pending;
      return { kind: "duplicate" };
    } catch (error) {
      if (!retryAfterRejection(error, ++rejectionCount)) {
        return { kind: "duplicate" };
      }
    }
  }
}

/** Create a claim/commit/release dedupe guard backed by memory and optional persistent storage. */
export function createClaimableDedupe(
  options: ClaimableDedupeOptions,
): ClaimableDedupe & Required<Pick<ClaimableDedupe, "forget">> {
  const ttlMs = resolveNonNegativeIntegerOption(options.ttlMs, 0);
  const memoryMaxSize = resolveNonNegativeIntegerOption(options.memoryMaxSize, 0);
  const memory = createDedupeCache({ ttlMs, maxSize: memoryMaxSize });
  let persistent: PersistentDedupe | null = null;
  if (hasPluginStateOptions(options)) {
    persistent = createPersistentDedupe({
      ttlMs,
      memoryMaxSize,
      pluginId: options.pluginId,
      stateMaxEntries: Math.max(1, resolveNonNegativeIntegerOption(options.stateMaxEntries, 1)),
      ...(options.namespacePrefix ? { namespacePrefix: options.namespacePrefix } : {}),
      ...(options.env ? { env: options.env } : {}),
      ...(options.onDiskError ? { onDiskError: options.onDiskError } : {}),
    });
  } else if (hasLegacyPathOptions(options)) {
    persistent = createPersistentDedupe({
      ttlMs,
      memoryMaxSize,
      fileMaxEntries: Math.max(1, resolveNonNegativeIntegerOption(options.fileMaxEntries, 1)),
      resolveFilePath: options.resolveFilePath,
      ...(options.env ? { env: options.env } : {}),
      ...(options.lockOptions ? { lockOptions: options.lockOptions } : {}),
      ...(options.onDiskError ? { onDiskError: options.onDiskError } : {}),
    });
  }

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

  async function forget(
    key: string,
    dedupeOptions?: PersistentDedupeCheckOptions,
  ): Promise<boolean> {
    const trimmed = key.trim();
    if (!trimmed) {
      return false;
    }
    const namespace = resolveNamespace(dedupeOptions?.namespace);
    const scopedKey = resolveScopedKey(namespace, trimmed);
    const claimValue = inflight.get(scopedKey);
    claimValue?.reject(createReleasedClaimError(scopedKey));
    inflight.delete(scopedKey);
    if (persistent) {
      return persistent.forget(trimmed, dedupeOptions);
    }
    memory.delete(scopedKey);
    return true;
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
    const claimValue = { promise, resolve, reject };
    inflight.set(scopedKey, claimValue);
    try {
      const recent = await hasRecent(trimmed, dedupeOptions);
      if (inflight.get(scopedKey) !== claimValue) {
        // Release/forget can replace this owner during the read. Preserve its settlement error.
        await promise;
        return { kind: "duplicate" };
      }
      if (recent) {
        resolve(false);
        inflight.delete(scopedKey);
        return { kind: "duplicate" };
      }
      return { kind: "claimed" };
    } catch (error) {
      if (inflight.get(scopedKey) !== claimValue) {
        await promise;
        return { kind: "duplicate" };
      }
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
    const claimValue = inflight.get(scopedKey);
    try {
      const recorded = persistent
        ? await persistent.checkAndRecord(trimmed, dedupeOptions)
        : !memory.check(scopedKey, dedupeOptions?.now);
      claimValue?.resolve(recorded);
      return recorded;
    } catch (error) {
      claimValue?.reject(error);
      throw error;
    } finally {
      if (inflight.get(scopedKey) === claimValue) {
        inflight.delete(scopedKey);
      }
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
    const claimLocal = inflight.get(scopedKey);
    if (!claimLocal) {
      return;
    }
    claimLocal.reject(dedupeOptions?.error ?? createReleasedClaimError(scopedKey));
    inflight.delete(scopedKey);
  }

  return {
    claim,
    commit,
    release,
    hasRecent,
    forget,
    warmup: persistent?.warmup ?? (async () => 0),
    clearMemory: () => {
      persistent?.clearMemory();
      memory.clear();
    },
    memorySize: () => persistent?.memorySize() ?? memory.size(),
  };
}

/**
 * Create an event-keyed replay guard whose claims own their settlement handles.
 *
 * Layering contract vs the durable ingress drain (`src/channels/message/ingress-queue.ts`):
 * the drain already rejects duplicate event ids durably — `complete()` tombstones the row
 * and enqueue is `ON CONFLICT DO NOTHING` for the tombstone retention window. A replay
 * guard on a drained channel is justified only when its identity or retention exceeds the
 * queue's: a *logical* message key that differs from the transport delivery id (Telegram:
 * `chat_id:message_id` vs `update_id` — debounce/media-group merges can re-surface a
 * constituent message under a fresh update_id only the guard sees), or a window longer
 * than the channel's tombstone retention. If the guard key would equal the drain event_id
 * and retention fits the tombstone window, delete the guard when adopting the drain.
 */
export function createChannelReplayGuard<TEvent>(
  params: ChannelReplayGuardParams<TEvent>,
): ChannelReplayGuard<TEvent> {
  return createChannelReplayGuardWithDedupe(params, createClaimableDedupe(params.dedupe));
}
