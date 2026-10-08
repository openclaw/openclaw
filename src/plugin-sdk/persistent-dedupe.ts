// Persistent dedupe helpers give plugins bounded replay protection across process restarts.
import { resolveNonNegativeIntegerOption } from "../../packages/normalization-core/src/number-coercion.js";
import { createDedupeCache } from "../infra/dedupe.js";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";
import {
  createChannelReplayGuardWithDedupe,
  type ChannelReplayGuard,
  type ChannelReplayClaimHandle,
  type ChannelReplayGuardParams,
} from "./channel-replay-guard.js";
import { KeyedAsyncQueue } from "./keyed-async-queue.js";
import {
  createPersistentStoreResolver,
  hasPluginStateOptions,
  resolveEntryKey,
  resolveNamespace,
  resolveScopedKey,
} from "./persistent-dedupe-store.js";
import type {
  ClaimableDedupe,
  ClaimableDedupeClaimResult,
  ClaimableDedupeOptions,
  PersistentDedupe,
  PersistentDedupeCheckOptions,
  PersistentDedupeLegacyPathOptions,
  PersistentDedupeOptions,
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

function isRecentTimestamp(seenAt: number | undefined, ttlMs: number, now: number): boolean {
  return seenAt != null && (ttlMs <= 0 || now - seenAt < ttlMs);
}

function resolveUnknownEntrySeenAt(value: unknown): number | undefined {
  if (!value || typeof value !== "object" || !("seenAt" in value)) {
    return undefined;
  }
  return typeof value.seenAt === "number" && Number.isFinite(value.seenAt)
    ? value.seenAt
    : undefined;
}

function hasLegacyPathOptions(
  options: ClaimableDedupeOptions | PersistentDedupeOptions,
): options is PersistentDedupeLegacyPathOptions {
  return typeof options.resolveFilePath === "function";
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

  async function warmup(namespace = "global", onError?: (error: unknown) => void): Promise<number> {
    const now = Date.now();
    const normalizedNamespace = resolveNamespace(namespace);
    const generation = memoryGeneration;
    const store = captureStore(normalizedNamespace);
    return operations.enqueue(store.namespace, async () => {
      try {
        let loaded = 0;
        for (const entry of await store.get().entries()) {
          const ts = resolveUnknownEntrySeenAt(entry.value);
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
    const work = operations.enqueue(store.namespace, async () => {
      const cached = memory.peek(scopedKey, now);
      if (generation === memoryGeneration) {
        memory.check(scopedKey, now);
      }
      if (cached) {
        return false;
      }

      try {
        const entryKey = resolveEntryKey(trimmed);
        let observed = await store.get().observe(entryKey);
        for (;;) {
          const seenAt = resolveUnknownEntrySeenAt(observed.value);
          const duplicate = isRecentTimestamp(seenAt, ttlMs, now);
          const outcome = await store.get().compareAndApply(
            entryKey,
            observed.comparison,
            duplicate
              ? { operation: "update", action: "keep" }
              : {
                  operation: "update",
                  action: "set",
                  value: { key: trimmed, seenAt: now },
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
    });
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
    return operations.enqueue(store.namespace, async () => {
      if (memory.peek(scopedKey, now)) {
        return true;
      }

      try {
        const seenAt = resolveUnknownEntrySeenAt(
          await store.get().lookup(resolveEntryKey(trimmed)),
        );
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
    });
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
  const persistent =
    hasPluginStateOptions(options) || hasLegacyPathOptions(options)
      ? createPersistentDedupe({ ...options, ttlMs, memoryMaxSize })
      : null;

  const inflight = new Map<string, Deferred<boolean>>();

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

    const { promise, resolve, reject } = createDeferredCore<boolean>();
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
