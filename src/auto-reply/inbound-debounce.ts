import type { InboundDebounceByProvider } from "../config/types.messages.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGlobalMap } from "../shared/global-singleton.js";

/**
 * Global registry of all active inbound debouncers so they can be flushed
 * collectively during gateway restart (SIGUSR1). Each debouncer registers
 * itself on creation and stays registered until the owning channel explicitly
 * unregisters it during teardown (server.close()). Flushing alone does not
 * unregister — the server may still be accepting connections.
 */
type DebouncerFlushResult = {
  flushedCount: number;
  drained: boolean;
};

type DebouncerFlushHandle = {
  flushAll: (options?: { deadlineMs?: number }) => Promise<DebouncerFlushResult>;
  unregister: () => void;
  /** Epoch ms of last enqueue or creation, whichever is more recent. */
  lastActivityMs: number;
};
const INBOUND_DEBOUNCERS_KEY = Symbol.for("openclaw.inboundDebouncers");
const INBOUND_DEBOUNCERS = resolveGlobalMap<symbol, DebouncerFlushHandle>(INBOUND_DEBOUNCERS_KEY);

/**
 * Clear the global debouncer registry. Intended for test cleanup only.
 */
export function clearInboundDebouncerRegistry(): void {
  INBOUND_DEBOUNCERS.clear();
}

/** Debouncers idle longer than this are auto-removed during flush as a safety
 *  net against channels that forget to call unregister() on teardown. */
const STALE_DEBOUNCER_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Flush all registered inbound debouncers immediately. Called during SIGUSR1
 * restart to push buffered messages into the session before reinitializing.
 * Returns the number of debounce buffers actually flushed so restart logic can
 * skip followup draining when there was no buffered work.
 *
 * Stale debouncers (no enqueue activity for >5 minutes) are auto-evicted as a
 * safety net in case a channel monitor forgot to call unregister() on teardown.
 */
export async function flushAllInboundDebouncers(options?: { timeoutMs?: number }): Promise<number> {
  const entries = [...INBOUND_DEBOUNCERS.entries()];
  if (entries.length === 0) {
    return 0;
  }
  const now = Date.now();
  const deadlineMs =
    typeof options?.timeoutMs === "number" && Number.isFinite(options.timeoutMs)
      ? now + Math.max(0, Math.trunc(options.timeoutMs))
      : undefined;
  const flushedCounts = await Promise.all(
    entries.map(async ([_key, handle]) => {
      let result: DebouncerFlushResult;
      try {
        result = await (deadlineMs !== undefined
          ? Promise.race([
              handle.flushAll({ deadlineMs }),
              new Promise<DebouncerFlushResult>((resolve) => {
                const timer = setTimeout(
                  () => resolve({ flushedCount: 0, drained: false }),
                  Math.max(0, deadlineMs - Date.now()),
                );
                timer.unref?.();
              }),
            ])
          : handle.flushAll({ deadlineMs }));
      } catch {
        // A hung or failing flushAll should not prevent other debouncers
        // from being swept. Keep the handle registered for a future sweep.
        return 0;
      }
      // Do NOT unregister drained debouncers here — the server is still
      // accepting connections and channel monitors still hold the debouncer
      // object. If a message arrives between flush and server.close(), it
      // would be buffered on an unregistered handle with no future global
      // flush to rescue it. Only auto-evict genuinely stale entries whose
      // owning channel never called unregister() (e.g. after reconnect).
      if (now - handle.lastActivityMs >= STALE_DEBOUNCER_MS) {
        handle.unregister();
      }
      return result.flushedCount;
    }),
  );
  return flushedCounts.reduce((total, count) => total + count, 0);
}

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
  releaseReady: () => void;
  readyReleased: boolean;
  delivered: boolean;
  task: Promise<void>;
};

const DEFAULT_MAX_TRACKED_KEYS = 2048;

export type InboundDebounceCreateParams<T> = {
  debounceMs: number;
  maxTrackedKeys?: number;
  buildKey: (item: T) => string | null | undefined;
  shouldDebounce?: (item: T) => boolean;
  resolveDebounceMs?: (item: T) => number | undefined;
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

  const runFlush = async (items: T[]) => {
    try {
      await params.onFlush(items);
      return true;
    } catch (err) {
      try {
        params.onError?.(err, items);
      } catch {
        // Flush failures are reported via onError, but this helper stays
        // non-throwing so keyed chains can continue processing later items.
      }
      return false;
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

  // Returns true when the buffer had pending messages that were delivered.
  const flushBuffer = async (key: string, buffer: DebounceBuffer<T>) => {
    if (buffers.get(key) === buffer) {
      buffers.delete(key);
    }
    if (buffer.timeout) {
      clearTimeout(buffer.timeout);
      buffer.timeout = null;
    }
    const hadMessages = buffer.items.length > 0;
    // Reserve each key's execution slot as soon as the first buffered item
    // arrives, so later same-key work cannot overtake a timer-backed flush.
    releaseBuffer(buffer);
    await buffer.task;
    return hadMessages && buffer.delivered;
  };

  const flushKey = async (key: string) => {
    const buffer = buffers.get(key);
    if (!buffer) {
      return false;
    }
    return flushBuffer(key, buffer);
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

  const canTrackKey = (key: string) => {
    if (buffers.has(key) || keyChains.has(key)) {
      return true;
    }
    return new Set([...buffers.keys(), ...keyChains.keys()]).size < maxTrackedKeys;
  };

  const enqueue = async (item: T) => {
    handle.lastActivityMs = Date.now();
    const key = params.buildKey(item);
    const debounceMs = resolveDebounceMs(item);
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
      buffer.delivered = await runFlush(buffer.items);
    });
    buffer = {
      items: [item],
      timeout: null,
      debounceMs,
      releaseReady: reservedTask.release,
      readyReleased: false,
      delivered: false,
      task: reservedTask.task,
    };
    buffers.set(key, buffer);
    scheduleFlush(key, buffer);
  };

  const flushAllInternal = async (options?: {
    deadlineMs?: number;
  }): Promise<DebouncerFlushResult> => {
    let flushedBufferCount = 0;

    // Keep sweeping until no debounced keys remain. A flush callback can race
    // with late in-flight ingress and create another buffered key before the
    // global registry deregisters this debouncer during restart.
    while (buffers.size > 0) {
      if (options?.deadlineMs !== undefined && Date.now() >= options.deadlineMs) {
        return {
          flushedCount: flushedBufferCount,
          drained: buffers.size === 0,
        };
      }
      const keys = [...buffers.keys()];
      for (const key of keys) {
        if (options?.deadlineMs !== undefined && Date.now() >= options.deadlineMs) {
          return {
            flushedCount: flushedBufferCount,
            drained: buffers.size === 0,
          };
        }
        if (!buffers.has(key)) {
          continue;
        }
        try {
          const hadMessages = await flushKey(key);
          if (hadMessages) {
            flushedBufferCount += 1;
          }
        } catch {
          // flushBuffer already routed the failure through onError; keep
          // sweeping so one bad key cannot strand later buffered messages.
        }
      }
    }

    return {
      flushedCount: flushedBufferCount,
      drained: buffers.size === 0,
    };
  };

  const flushAll = async (options?: { deadlineMs?: number }) => {
    const result = await flushAllInternal(options);
    return result.flushedCount;
  };

  // Register in global registry for SIGUSR1 flush.
  const registryKey = Symbol();
  const unregister = () => {
    INBOUND_DEBOUNCERS.delete(registryKey);
  };
  const handle: DebouncerFlushHandle = {
    flushAll: flushAllInternal,
    unregister,
    lastActivityMs: Date.now(),
  };
  INBOUND_DEBOUNCERS.set(registryKey, handle);

  return { enqueue, flushKey, flushAll, unregister };
}
