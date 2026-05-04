import type { InboundDebounceByProvider } from "../config/types.messages.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

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
  maxTimeout: ReturnType<typeof setTimeout> | null;
  debounceMs: number;
  maxDebounceMs?: number;
  maxBatchItems?: number;
  startedAt: number;
  releaseReady: () => void;
  readyReleased: boolean;
  task: Promise<void>;
};

const DEFAULT_MAX_TRACKED_KEYS = 2048;

export type InboundDebounceCreateParams<T> = {
  debounceMs: number;
  maxTrackedKeys?: number;
  buildKey: (item: T) => string | null | undefined;
  shouldDebounce?: (item: T) => boolean;
  resolveDebounceMs?: (item: T) => number | undefined;
  maxDebounceMs?: number;
  resolveMaxDebounceMs?: (item: T) => number | undefined;
  maxBatchItems?: number;
  resolveMaxBatchItems?: (item: T) => number | undefined;
  onFlush: (items: T[]) => Promise<void>;
  onError?: (err: unknown, items: T[]) => void;
};

export function createInboundDebouncer<T>(params: InboundDebounceCreateParams<T>) {
  const buffers = new Map<string, DebounceBuffer<T>>();
  const keyChains = new Map<string, Promise<void>>();
  const defaultDebounceMs = Math.max(0, Math.trunc(params.debounceMs));
  const maxTrackedKeys = Math.max(1, Math.trunc(params.maxTrackedKeys ?? DEFAULT_MAX_TRACKED_KEYS));

  const resolveDebounceMs = (item: T) => {
    const resolved = params.resolveDebounceMs?.(item);
    if (typeof resolved !== "number" || !Number.isFinite(resolved)) {
      return defaultDebounceMs;
    }
    return Math.max(0, Math.trunc(resolved));
  };
  const resolveMaxDebounceMs = (item: T): number | undefined => {
    const resolved = params.resolveMaxDebounceMs?.(item) ?? params.maxDebounceMs;
    if (typeof resolved !== "number" || !Number.isFinite(resolved) || resolved <= 0) {
      return undefined;
    }
    return Math.max(1, Math.trunc(resolved));
  };
  const resolveMaxBatchItems = (item: T): number | undefined => {
    const resolved = params.resolveMaxBatchItems?.(item) ?? params.maxBatchItems;
    if (typeof resolved !== "number" || !Number.isFinite(resolved) || resolved <= 0) {
      return undefined;
    }
    return Math.max(1, Math.trunc(resolved));
  };

  const runFlush = async (items: T[]) => {
    try {
      await params.onFlush(items);
    } catch (err) {
      try {
        params.onError?.(err, items);
      } catch {
        // Flush failures are reported via onError, but this helper stays
        // non-throwing so keyed chains can continue processing later items.
      }
    }
  };

  const enqueueKeyTask = (key: string, task: () => Promise<void>) => {
    const previous = keyChains.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    const settled = next.catch(() => undefined);
    keyChains.set(key, settled);
    const cleanup = () => {
      if (keyChains.get(key) === settled) {
        keyChains.delete(key);
      }
    };
    settled.then(cleanup, cleanup);
    return next;
  };

  const enqueueReservedKeyTask = (key: string, task: () => Promise<void>) => {
    let readyReleased = false;
    let releaseReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    return {
      task: enqueueKeyTask(key, async () => {
        await ready;
        await task();
      }),
      release: () => {
        if (readyReleased) {
          return;
        }
        readyReleased = true;
        releaseReady();
      },
    };
  };

  const releaseBuffer = (buffer: DebounceBuffer<T>) => {
    if (buffer.readyReleased) {
      return;
    }
    buffer.readyReleased = true;
    buffer.releaseReady();
  };

  const flushBuffer = async (key: string, buffer: DebounceBuffer<T>) => {
    if (buffers.get(key) === buffer) {
      buffers.delete(key);
    }
    if (buffer.timeout) {
      clearTimeout(buffer.timeout);
      buffer.timeout = null;
    }
    if (buffer.maxTimeout) {
      clearTimeout(buffer.maxTimeout);
      buffer.maxTimeout = null;
    }
    // Reserve each key's execution slot as soon as the first buffered item
    // arrives, so later same-key work cannot overtake a timer-backed flush.
    releaseBuffer(buffer);
    await buffer.task;
  };

  const flushKey = async (key: string) => {
    const buffer = buffers.get(key);
    if (!buffer) {
      return;
    }
    await flushBuffer(key, buffer);
  };

  const clearKey = (key: string): T[] => {
    const buffer = buffers.get(key);
    if (!buffer) {
      return [];
    }
    buffers.delete(key);
    if (buffer.timeout) {
      clearTimeout(buffer.timeout);
      buffer.timeout = null;
    }
    if (buffer.maxTimeout) {
      clearTimeout(buffer.maxTimeout);
      buffer.maxTimeout = null;
    }
    const items = buffer.items.slice();
    buffer.items = [];
    releaseBuffer(buffer);
    return items;
  };

  const scheduleFlush = (key: string, buffer: DebounceBuffer<T>) => {
    if (buffer.timeout) {
      clearTimeout(buffer.timeout);
    }
    buffer.timeout = setTimeout(async () => {
      await flushBuffer(key, buffer);
    }, buffer.debounceMs);
    buffer.timeout.unref?.();
  };

  const scheduleMaxFlush = (key: string, buffer: DebounceBuffer<T>) => {
    if (buffer.maxTimeout) {
      clearTimeout(buffer.maxTimeout);
      buffer.maxTimeout = null;
    }
    if (buffer.maxDebounceMs === undefined) {
      return;
    }
    const deadline = buffer.startedAt + buffer.maxDebounceMs;
    const delay = Math.max(0, deadline - Date.now());
    buffer.maxTimeout = setTimeout(async () => {
      await flushBuffer(key, buffer);
    }, delay);
    buffer.maxTimeout.unref?.();
  };

  const canTrackKey = (key: string) => {
    if (buffers.has(key) || keyChains.has(key)) {
      return true;
    }
    return new Set([...buffers.keys(), ...keyChains.keys()]).size < maxTrackedKeys;
  };

  const enqueue = async (item: T) => {
    const key = params.buildKey(item);
    const debounceMs = resolveDebounceMs(item);
    const maxDebounceMs = resolveMaxDebounceMs(item);
    const maxBatchItems = resolveMaxBatchItems(item);
    const canDebounce = debounceMs > 0 && (params.shouldDebounce?.(item) ?? true);

    if (!canDebounce || !key) {
      if (key) {
        if (buffers.has(key)) {
          // Reserve the keyed immediate slot before forcing the pending buffer
          // to flush so fire-and-forget callers cannot be overtaken.
          const reservedTask = enqueueReservedKeyTask(key, async () => {
            await runFlush([item]);
          });
          try {
            await flushKey(key);
          } finally {
            reservedTask.release();
          }
          await reservedTask.task;
          return;
        }
        if (keyChains.has(key)) {
          await enqueueKeyTask(key, async () => {
            await runFlush([item]);
          });
          return;
        }
        await runFlush([item]);
      } else {
        await runFlush([item]);
      }
      return;
    }

    const existing = buffers.get(key);
    if (existing) {
      existing.items.push(item);
      existing.debounceMs = debounceMs;
      if (
        maxDebounceMs !== undefined &&
        (existing.maxDebounceMs === undefined || maxDebounceMs < existing.maxDebounceMs)
      ) {
        existing.maxDebounceMs = maxDebounceMs;
        scheduleMaxFlush(key, existing);
      }
      if (
        maxBatchItems !== undefined &&
        (existing.maxBatchItems === undefined || maxBatchItems < existing.maxBatchItems)
      ) {
        existing.maxBatchItems = maxBatchItems;
      }
      if (existing.maxBatchItems !== undefined && existing.items.length >= existing.maxBatchItems) {
        await flushBuffer(key, existing);
        return;
      }
      scheduleFlush(key, existing);
      return;
    }
    if (!canTrackKey(key)) {
      // When the debounce map is saturated, fall back to immediate keyed work
      // instead of buffering, but still preserve same-key ordering.
      await enqueueKeyTask(key, async () => {
        await runFlush([item]);
      });
      return;
    }

    let buffer!: DebounceBuffer<T>;
    const reservedTask = enqueueReservedKeyTask(key, async () => {
      if (buffer.items.length === 0) {
        return;
      }
      await runFlush(buffer.items);
    });
    buffer = {
      items: [item],
      timeout: null,
      maxTimeout: null,
      debounceMs,
      maxDebounceMs,
      maxBatchItems,
      startedAt: Date.now(),
      releaseReady: reservedTask.release,
      readyReleased: false,
      task: reservedTask.task,
    };
    buffers.set(key, buffer);
    scheduleFlush(key, buffer);
    scheduleMaxFlush(key, buffer);
  };

  return { enqueue, flushKey, clearKey };
}
