// Keyed inbound-message debouncer that preserves same-key delivery order.
import {
  resolveNonNegativeIntegerOption,
  resolveOptionalIntegerOption,
} from "@openclaw/normalization-core/number-coercion";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { toErrorObject } from "../infra/errors.js";
import { createDeferredCore } from "../shared/deferred.js";

/** Resolve effective inbound debounce milliseconds from explicit, channel, and global config. */
export function resolveInboundDebounceMs(params: {
  cfg: OpenClawConfig;
  channel: string;
  overrideMs?: number;
}): number {
  const inbound = params.cfg.messages?.inbound;
  for (const value of [
    params.overrideMs,
    inbound?.byChannel?.[params.channel],
    inbound?.debounceMs,
  ]) {
    const resolved = resolveOptionalIntegerOption(value, { min: 0 });
    if (resolved !== undefined) {
      return resolved;
    }
  }
  return 0;
}

type DebounceBuffer<T> = {
  items: T[];
  timeout: ReturnType<typeof setTimeout> | null;
  debounceMs: number;
  flushDeadlineMs: number;
  releaseReady: () => void;
  task: Promise<void>;
};

/** A flush releases its debounce lane at admission while completion remains drainable. */
type InboundDebounceFlush = {
  admission: Promise<void>;
  completion: Promise<void>;
};

type InboundDebounceAdmissionLifecycleInput = {
  abortSignal?: AbortSignal;
  onAdopted?: () => void | Promise<void>;
  onDeferred?: () => boolean | void;
  onDeferredHeartbeat?: () => void;
  deferredHeartbeatIntervalMs?: number;
  onAdoptionFinalizing?: () => void;
  onFailed?: (error: unknown) => void | Promise<void>;
  onAbandoned?: () => void | Promise<void>;
};

/** Lifecycle shape passed to a channel dispatch so it can signal session-lane admission. */
type InboundDebounceAdmissionLifecycle = {
  abortSignal: AbortSignal;
  onAdopted: () => Promise<void>;
  onDeferred: () => boolean | void;
  onDeferredHeartbeat?: () => void;
  deferredHeartbeatIntervalMs?: number;
  onAdoptionFinalizing: () => void;
  onFailed?: (error: unknown) => Promise<void>;
  onAbandoned: () => Promise<void>;
};

/**
 * Start one flush and bind its admission signal to the turn lifecycle.
 * Completion also releases admission for gated work that never enters a session lane.
 */
function createInboundDebounceFlush(params: {
  lifecycle?: InboundDebounceAdmissionLifecycleInput;
  dispatch: (lifecycle: InboundDebounceAdmissionLifecycle) => Promise<void>;
}): InboundDebounceFlush {
  let admitted = false;
  const { promise: admission, resolve: resolveAdmission } = createDeferredCore();
  const markAdmitted = () => {
    admitted = true;
    resolveAdmission();
  };
  const source = params.lifecycle;
  const lifecycle: InboundDebounceAdmissionLifecycle = {
    abortSignal: source?.abortSignal ?? new AbortController().signal,
    onAdopted: async () => {
      await source?.onAdopted?.();
      markAdmitted();
    },
    onDeferred: () => {
      const accepted = source?.onDeferred?.();
      if (accepted !== false) {
        markAdmitted();
      }
      return accepted;
    },
    onDeferredHeartbeat: () => source?.onDeferredHeartbeat?.(),
    deferredHeartbeatIntervalMs: source?.deferredHeartbeatIntervalMs,
    onAdoptionFinalizing: () => source?.onAdoptionFinalizing?.(),
    onFailed: source?.onFailed
      ? async (error) => {
          try {
            await source.onFailed?.(error);
          } finally {
            markAdmitted();
          }
        }
      : undefined,
    onAbandoned: async () => {
      await source?.onAbandoned?.();
    },
  };
  let completion: Promise<void>;
  try {
    completion = params.dispatch(lifecycle);
  } catch (error) {
    completion = Promise.reject(toErrorObject(error, "Inbound debounce dispatch failed"));
  }
  // A failed dispatch must settle its source claim before releasing the keyed
  // lane; an already-admitted turn owns its later completion failure.
  completion = completion.then(markAdmitted).catch(async (error: unknown) => {
    if (!admitted && lifecycle.onFailed) {
      await Promise.allSettled([lifecycle.onFailed(error)]);
    }
    markAdmitted();
    throw error;
  });
  return { admission, completion };
}

const DEFAULT_MAX_TRACKED_KEYS = 2048;
const MAX_DEBOUNCE_WINDOW_MULTIPLIER = 5;

/** Options for creating a keyed inbound debouncer. */
export type InboundDebounceCreateParams<T> = {
  debounceMs: number;
  maxTrackedKeys?: number;
  maxWaitMs?: number | ((item: T) => number | undefined);
  buildKey: (item: T) => string | null | undefined;
  shouldDebounce?: (item: T) => boolean;
  /** Hold a quiet-period flush before its deadline; explicit flushes bypass this check. */
  shouldHoldFlush?: (items: readonly T[]) => boolean | Promise<boolean>;
  resolveDebounceMs?: (item: T, pending?: readonly T[]) => number | undefined;
  canAppend?: (item: T, pending: readonly T[]) => boolean;
  serializeImmediate?: boolean;
  onFlush: (items: T[], createFlush: typeof createInboundDebounceFlush) => InboundDebounceFlush;
  onError?: (err: unknown, items: T[]) => void;
  onCancel?: (items: T[]) => void;
};

/** Create a keyed debouncer with flush/cancel controls and same-key serialization. */
export function createInboundDebouncer<T>(params: InboundDebounceCreateParams<T>) {
  const buffers = new Map<string, DebounceBuffer<T>>();
  const pendingBuffers = new Map<string, Set<DebounceBuffer<T>>>();
  const pendingImmediate = new Map<string, Set<T[]>>();
  const keyChains = new Map<string, Promise<void>>();
  const activeCompletions = new Set<Promise<void>>();
  const defaultDebounceMs = resolveNonNegativeIntegerOption(params.debounceMs, 0);
  const maxTrackedKeys = Math.max(1, Math.trunc(params.maxTrackedKeys ?? DEFAULT_MAX_TRACKED_KEYS));

  const resolveDebounceMs = (item: T, pending?: readonly T[]) => {
    const resolved = params.resolveDebounceMs?.(item, pending);
    return resolveNonNegativeIntegerOption(resolved, defaultDebounceMs);
  };

  const resolvePending = (item: T, key: string) => {
    const buffer = buffers.get(key);
    return buffer && (params.canAppend?.(item, buffer.items) ?? true) ? buffer : undefined;
  };
  const shouldBuffer = (item: T): boolean => {
    const key = params.buildKey(item);
    return Boolean(
      key &&
      resolveDebounceMs(item, resolvePending(item, key)?.items) > 0 &&
      (params.shouldDebounce?.(item) ?? true),
    );
  };

  const notifyObserver = (notify: () => void) => {
    try {
      notify();
    } catch {
      // Observer failures must not strand cancellation resources or keyed flushes.
    }
  };
  const reportFlushError = (error: unknown, items: T[]) =>
    notifyObserver(() => params.onError?.(error, items));
  const cancelItems = (items: T[]) => notifyObserver(() => params.onCancel?.(items));

  const runFlush = async (items: T[]) => {
    let flush: InboundDebounceFlush;
    try {
      flush = params.onFlush(items, createInboundDebounceFlush);
    } catch (err) {
      reportFlushError(err, items);
      return;
    }
    let reported = false;
    const reportOnce = (err: unknown) => {
      if (reported) {
        return;
      }
      reported = true;
      reportFlushError(err, items);
    };
    const admission = flush.admission.catch(reportOnce);
    const completion = flush.completion.catch(reportOnce);
    activeCompletions.add(completion);
    void completion.then(() => activeCompletions.delete(completion));
    await Promise.race([admission, completion]);
  };

  const untrackKeyTask = (key: string, settled: Promise<void>) => {
    if (keyChains.get(key) === settled) {
      keyChains.delete(key);
    }
  };

  const enqueueKeyTask = (key: string, task: () => Promise<void>) => {
    const previous = keyChains.get(key);
    const next = previous ? previous.then(task) : task();
    const settled = next.catch(() => undefined);
    keyChains.set(key, settled);
    void settled.then(() => untrackKeyTask(key, settled));
    return next;
  };

  const enqueueImmediate = (key: string, item: T) => {
    const items = [item];
    const pending = pendingImmediate.get(key) ?? new Set<T[]>();
    pending.add(items);
    pendingImmediate.set(key, pending);
    return enqueueKeyTask(key, async () => {
      pending.delete(items);
      if (pending.size === 0) {
        pendingImmediate.delete(key);
      }
      if (items.length > 0) {
        await runFlush(items);
      }
    });
  };

  const detachBuffer = (key: string, buffer: DebounceBuffer<T>) => {
    if (buffers.get(key) === buffer) {
      buffers.delete(key);
    }
    if (buffer.timeout) {
      clearTimeout(buffer.timeout);
      buffer.timeout = null;
    }
  };

  const flushBuffer = async (key: string, buffer: DebounceBuffer<T>) => {
    detachBuffer(key, buffer);
    // Reserve each key's execution slot as soon as the first buffered item
    // arrives, so later same-key work cannot overtake a timer-backed flush.
    buffer.releaseReady();
    await buffer.task;
  };

  const flushKey = async (key: string) => {
    const buffer = buffers.get(key);
    if (!buffer) {
      return;
    }
    await flushBuffer(key, buffer);
  };

  const cancelKey = (key: string): boolean => {
    const pending = pendingBuffers.get(key);
    if (!pending?.size && !keyChains.has(key)) {
      return false;
    }
    for (const buffer of pending ?? []) {
      detachBuffer(key, buffer);
      const canceledItems = buffer.items;
      buffer.items = [];
      cancelItems(canceledItems);
      buffer.releaseReady();
    }
    for (const items of pendingImmediate.get(key) ?? []) {
      if (items.length > 0) {
        cancelItems(items.splice(0));
      }
    }
    pendingBuffers.delete(key);
    return true;
  };

  const settleQuietFlush = async (key: string, buffer: DebounceBuffer<T>): Promise<void> => {
    if (!params.shouldHoldFlush || performance.now() >= buffer.flushDeadlineMs) {
      await flushBuffer(key, buffer);
      return;
    }
    // A slow hold check cannot extend the batch's fixed deadline.
    buffer.timeout = setTimeout(
      () => {
        void flushBuffer(key, buffer);
      },
      Math.max(0, buffer.flushDeadlineMs - performance.now()),
    );
    buffer.timeout.unref?.();
    let shouldHold: boolean;
    try {
      shouldHold = await params.shouldHoldFlush(buffer.items);
    } catch {
      shouldHold = false;
    }
    if (buffers.get(key) !== buffer) {
      return;
    }
    if (shouldHold) {
      scheduleFlush(key, buffer);
    } else {
      await flushBuffer(key, buffer);
    }
  };

  const scheduleFlush = (key: string, buffer: DebounceBuffer<T>) => {
    if (buffer.timeout) {
      clearTimeout(buffer.timeout);
    }
    // Keep the first item's monotonic deadline fixed so continuous arrivals
    // and wall-clock changes cannot hold a reserved ingress lane indefinitely.
    const delayMs = Math.min(
      buffer.debounceMs,
      Math.max(0, buffer.flushDeadlineMs - performance.now()),
    );
    buffer.timeout = setTimeout(() => {
      if (params.shouldHoldFlush) {
        void settleQuietFlush(key, buffer);
      } else {
        void flushBuffer(key, buffer);
      }
    }, delayMs);
    buffer.timeout.unref?.();
  };

  const enqueue = async (item: T) => {
    const key = params.buildKey(item);
    const existing = key ? resolvePending(item, key) : undefined;
    const debounceMs = resolveDebounceMs(item, existing?.items);
    const canDebounce = debounceMs > 0 && (params.shouldDebounce?.(item) ?? true);

    if (!canDebounce || !key) {
      if (key && (buffers.has(key) || keyChains.has(key) || params.serializeImmediate)) {
        // Releasing the buffer is synchronous; its reserved slot stays ahead
        // of this immediate item and any later enqueue.
        void flushKey(key);
        await enqueueImmediate(key, item);
        return;
      }
      await runFlush([item]);
      return;
    }

    if (existing) {
      existing.items.push(item);
      existing.debounceMs = debounceMs;
      scheduleFlush(key, existing);
      return;
    }
    if (buffers.has(key)) {
      // Seal a full batch without waiting for its turn; the new batch reserves
      // the following FIFO slot while later ingress remains free to append.
      void flushKey(key);
    }
    // Buffers reserve a chain before insertion and release it only after removal,
    // so chain keys already cover every tracked debounce key.
    if (!(keyChains.has(key) || keyChains.size < maxTrackedKeys)) {
      // When the debounce map is saturated, fall back to immediate keyed work
      // instead of buffering, but still preserve same-key ordering.
      await enqueueImmediate(key, item);
      return;
    }
    const { promise: ready, resolve: releaseReady } = createDeferredCore();
    const task = enqueueKeyTask(key, async () => {
      await ready;
      const pending = pendingBuffers.get(key);
      pending?.delete(buffer);
      if (pending?.size === 0) {
        pendingBuffers.delete(key);
      }
      if (buffer.items.length === 0) {
        return;
      }
      await runFlush(buffer.items);
    });
    const buffer: DebounceBuffer<T> = {
      items: [item],
      timeout: null,
      debounceMs,
      flushDeadlineMs:
        performance.now() +
        Math.max(
          debounceMs,
          resolveNonNegativeIntegerOption(
            typeof params.maxWaitMs === "function" ? params.maxWaitMs(item) : params.maxWaitMs,
            debounceMs * MAX_DEBOUNCE_WINDOW_MULTIPLIER,
          ),
        ),
      releaseReady,
      task,
    };
    buffers.set(key, buffer);
    const pending = pendingBuffers.get(key) ?? new Set<DebounceBuffer<T>>();
    pending.add(buffer);
    pendingBuffers.set(key, pending);
    scheduleFlush(key, buffer);
  };

  const drain = async () => {
    // Callers flush or cancel buffers first. Waiting both registries closes the
    // handoff gap before a queued same-key task registers its completion.
    while (keyChains.size > 0 || activeCompletions.size > 0) {
      await Promise.all([...keyChains.values(), ...activeCompletions]);
    }
  };

  return { enqueue, shouldBuffer, flushKey, cancelKey, drain };
}
