import { createHash } from "node:crypto";
import type { OpenClawConfig } from "../config/config.js";
import type { InboundDebounceByProvider } from "../config/types.messages.js";

const resolveMs = (value: unknown): number | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.trunc(value));
};

const resolveChannelOverride = (params: {
  byChannel?: InboundDebounceByProvider;
  channel: string;
}): number | undefined => {
  if (!params.byChannel) {
    return undefined;
  }
  return resolveMs(params.byChannel[params.channel]);
};

export function resolveInboundDebounceMs(params: {
  cfg: OpenClawConfig;
  channel: string;
  overrideMs?: number;
}): number {
  const inbound = params.cfg.messages?.inbound;
  const override = resolveMs(params.overrideMs);
  const byChannel = resolveChannelOverride({
    byChannel: inbound?.byChannel,
    channel: params.channel,
  });
  const base = resolveMs(inbound?.debounceMs);
  return override ?? byChannel ?? base ?? 0;
}

type DebounceBuffer<T> = {
  items: T[];
  timeout: ReturnType<typeof setTimeout> | null;
  debounceMs: number;
  flushing: boolean;
  consecutiveFailures: number;
};

export type InboundDebounceCreateParams<T> = {
  debounceMs: number;
  buildKey: (item: T) => string | null | undefined;
  shouldDebounce?: (item: T) => boolean;
  resolveDebounceMs?: (item: T) => number | undefined;
  maxKeys?: number;
  maxFlushRetries?: number;
  maxBufferedItems?: number;
  maxRetryDelayMs?: number;
  retryBackoffFactor?: number;
  onFlush: (items: T[]) => Promise<void>;
  onError?: (err: unknown, items: T[]) => void;
};

export function createInboundDebouncer<T>(params: InboundDebounceCreateParams<T>) {
  const buffers = new Map<string, DebounceBuffer<T>>();
  const defaultDebounceMs = Math.max(0, Math.trunc(params.debounceMs));
  const maxKeys = Math.max(1, Math.trunc(params.maxKeys ?? 1000));
  const maxFlushRetries = Math.max(0, Math.trunc(params.maxFlushRetries ?? 20));
  const maxBufferedItems = Math.max(1, Math.trunc(params.maxBufferedItems ?? 500));
  const retryBackoffFactor = Number.isFinite(params.retryBackoffFactor)
    ? Math.max(1, params.retryBackoffFactor ?? 2)
    : 2;
  const maxRetryDelayMs = Number.isFinite(params.maxRetryDelayMs)
    ? Math.max(defaultDebounceMs, Math.trunc(params.maxRetryDelayMs ?? 30_000))
    : Math.max(defaultDebounceMs, 30_000);

  const resolveDebounceMs = (item: T) => {
    const resolved = params.resolveDebounceMs?.(item);
    if (typeof resolved !== "number" || !Number.isFinite(resolved)) {
      return defaultDebounceMs;
    }
    return Math.max(0, Math.trunc(resolved));
  };

  const buildKeyHash = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 12);

  const createDebounceError = (
    code:
      | "INBOUND_DEBOUNCE_BUFFER_OVERFLOW"
      | "INBOUND_DEBOUNCE_MAX_KEYS_EXCEEDED"
      | "INBOUND_DEBOUNCE_MAX_RETRIES_EXCEEDED",
    key: string,
    extra: Record<string, number> = {},
  ) => {
    const message =
      code === "INBOUND_DEBOUNCE_BUFFER_OVERFLOW"
        ? "inbound debounce buffer overflow"
        : code === "INBOUND_DEBOUNCE_MAX_KEYS_EXCEEDED"
          ? "inbound debounce key capacity exceeded"
          : "inbound debounce flush retries exceeded";
    return Object.assign(new Error(message), {
      code,
      debounceKeyHash: buildKeyHash(key),
      ...extra,
    });
  };

  const clearScheduledFlush = (buffer: DebounceBuffer<T>) => {
    if (!buffer.timeout) {
      return;
    }
    clearTimeout(buffer.timeout);
    buffer.timeout = null;
  };

  const emitOverflowError = (key: string, droppedItems: T[]) => {
    if (droppedItems.length === 0) {
      return;
    }
    params.onError?.(
      createDebounceError("INBOUND_DEBOUNCE_BUFFER_OVERFLOW", key, {
        maxBufferedItems,
      }),
      droppedItems,
    );
  };

  const trimBufferToLimit = (key: string, buffer: DebounceBuffer<T>) => {
    const overflow = buffer.items.length - maxBufferedItems;
    if (overflow <= 0) {
      return;
    }
    // Drop newest items to preserve ordering for already-buffered work.
    const droppedItems = buffer.items.splice(maxBufferedItems, overflow);
    emitOverflowError(key, droppedItems);
  };

  const resolveRetryDelayMs = (buffer: DebounceBuffer<T>) => {
    const exponent = Math.max(0, buffer.consecutiveFailures - 1);
    const delay = buffer.debounceMs * retryBackoffFactor ** exponent;
    if (!Number.isFinite(delay)) {
      return maxRetryDelayMs;
    }
    return Math.min(maxRetryDelayMs, Math.max(buffer.debounceMs, Math.trunc(delay)));
  };

  const flushDirect = async (items: T[]) => {
    try {
      await params.onFlush(items);
    } catch (err) {
      params.onError?.(err, items);
    }
  };

  const scheduleFlush = (
    key: string,
    buffer: DebounceBuffer<T>,
    reason: "debounce" | "retry" = "debounce",
  ) => {
    clearScheduledFlush(buffer);
    const delayMs = reason === "retry" ? resolveRetryDelayMs(buffer) : buffer.debounceMs;
    buffer.timeout = setTimeout(() => {
      void flushBuffer(key, buffer);
    }, delayMs);
    buffer.timeout.unref?.();
  };

  const scheduleBufferedFlush = (key: string, buffer: DebounceBuffer<T>) => {
    scheduleFlush(key, buffer, buffer.consecutiveFailures > 0 ? "retry" : "debounce");
  };

  const flushBuffer = async (key: string, buffer: DebounceBuffer<T>): Promise<boolean> => {
    clearScheduledFlush(buffer);
    if (buffer.flushing) {
      if (buffer.items.length > 0) {
        scheduleBufferedFlush(key, buffer);
      }
      return false;
    }
    if (buffer.items.length === 0) {
      buffers.delete(key);
      return true;
    }
    const items = buffer.items.splice(0);
    buffer.flushing = true;
    let flushFailed = false;
    let retriesExceeded = false;
    try {
      await params.onFlush(items);
      buffer.consecutiveFailures = 0;
    } catch (err) {
      flushFailed = true;
      // Preserve ordering when retrying the failed batch.
      buffer.items.unshift(...items);
      buffer.consecutiveFailures += 1;
      params.onError?.(err, items);
      trimBufferToLimit(key, buffer);
      retriesExceeded = buffer.consecutiveFailures > maxFlushRetries;
    } finally {
      buffer.flushing = false;
    }
    if (retriesExceeded) {
      clearScheduledFlush(buffer);
      const droppedItems = buffer.items.splice(0);
      buffers.delete(key);
      params.onError?.(
        createDebounceError("INBOUND_DEBOUNCE_MAX_RETRIES_EXCEEDED", key, {
          maxFlushRetries,
        }),
        droppedItems,
      );
      return true;
    }
    if (flushFailed || buffer.items.length > 0) {
      scheduleFlush(key, buffer, flushFailed ? "retry" : "debounce");
      return false;
    }
    buffers.delete(key);
    return true;
  };

  const flushKeyInternal = async (key: string) => {
    const buffer = buffers.get(key);
    if (!buffer) {
      return true;
    }
    return flushBuffer(key, buffer);
  };

  const enqueue = async (item: T) => {
    const key = params.buildKey(item);
    const debounceMs = resolveDebounceMs(item);
    const canDebounce = debounceMs > 0 && (params.shouldDebounce?.(item) ?? true);

    if (!canDebounce || !key) {
      if (key && buffers.has(key)) {
        const fullyFlushed = await flushKeyInternal(key);
        const pending = buffers.get(key);
        if (!fullyFlushed && pending) {
          // Preserve ordering by appending non-debounced items behind unresolved buffered work.
          pending.items.push(item);
          trimBufferToLimit(key, pending);
          scheduleBufferedFlush(key, pending);
          return;
        }
      }
      await flushDirect([item]);
      return;
    }

    const existing = buffers.get(key);
    if (existing) {
      existing.items.push(item);
      existing.debounceMs = debounceMs;
      trimBufferToLimit(key, existing);
      scheduleBufferedFlush(key, existing);
      return;
    }

    if (buffers.size >= maxKeys) {
      params.onError?.(
        createDebounceError("INBOUND_DEBOUNCE_MAX_KEYS_EXCEEDED", key, {
          maxKeys,
        }),
        [item],
      );
      await flushDirect([item]);
      return;
    }

    const buffer: DebounceBuffer<T> = {
      items: [item],
      timeout: null,
      debounceMs,
      flushing: false,
      consecutiveFailures: 0,
    };
    buffers.set(key, buffer);
    scheduleFlush(key, buffer);
  };

  return {
    enqueue,
    flushKey: async (key: string) => {
      await flushKeyInternal(key);
    },
  };
}
