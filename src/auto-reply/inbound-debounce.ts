import type { OpenClawConfig } from "../config/config.js";
import type { InboundDebounceByProvider } from "../config/types.messages.js";
import { resolveGlobalMap } from "../shared/global-singleton.js";

/**
 * Global registry of all active inbound debouncers so they can be flushed
 * collectively during gateway restart (SIGUSR1). Each debouncer registers
 * itself on creation and stays registered until a complete global flush
 * drains it or the owner explicitly unregisters it during teardown.
 */
type DebouncerFlushResult = {
  flushedCount: number;
  drained: boolean;
};

type DebouncerFlushHandle = {
  flushAll: (options?: { deadlineMs?: number }) => Promise<DebouncerFlushResult>;
  unregister: () => void;
};
const INBOUND_DEBOUNCERS_KEY = Symbol.for("openclaw.inboundDebouncers");
const INBOUND_DEBOUNCERS = resolveGlobalMap<symbol, DebouncerFlushHandle>(INBOUND_DEBOUNCERS_KEY);

/**
 * Clear the global debouncer registry. Intended for test cleanup only.
 */
export function clearInboundDebouncerRegistry(): void {
  INBOUND_DEBOUNCERS.clear();
}

/**
 * Flush all registered inbound debouncers immediately. Called during SIGUSR1
 * restart to push buffered messages into the session before reinitializing.
 * Returns the number of debounce buffers actually flushed so restart logic can
 * skip followup draining when there was no buffered work.
 */
export async function flushAllInboundDebouncers(options?: { timeoutMs?: number }): Promise<number> {
  const entries = [...INBOUND_DEBOUNCERS.entries()];
  if (entries.length === 0) {
    return 0;
  }
  const deadlineMs =
    typeof options?.timeoutMs === "number" && Number.isFinite(options.timeoutMs)
      ? Date.now() + Math.max(0, Math.trunc(options.timeoutMs))
      : undefined;
  const flushedCounts = await Promise.all(
    entries.map(async ([_key, handle]) => {
      const result = await handle.flushAll({ deadlineMs });
      if (result.drained) {
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
};

export type InboundDebounceCreateParams<T> = {
  debounceMs: number;
  buildKey: (item: T) => string | null | undefined;
  shouldDebounce?: (item: T) => boolean;
  resolveDebounceMs?: (item: T) => number | undefined;
  onFlush: (items: T[]) => Promise<void>;
  onError?: (err: unknown, items: T[]) => void;
};

export function createInboundDebouncer<T>(params: InboundDebounceCreateParams<T>) {
  const buffers = new Map<string, DebounceBuffer<T>>();
  const defaultDebounceMs = Math.max(0, Math.trunc(params.debounceMs));

  const resolveDebounceMs = (item: T) => {
    const resolved = params.resolveDebounceMs?.(item);
    if (typeof resolved !== "number" || !Number.isFinite(resolved)) {
      return defaultDebounceMs;
    }
    return Math.max(0, Math.trunc(resolved));
  };

  // Returns true when the buffer had pending messages that were delivered.
  const flushBuffer = async (key: string, buffer: DebounceBuffer<T>) => {
    buffers.delete(key);
    if (buffer.timeout) {
      clearTimeout(buffer.timeout);
      buffer.timeout = null;
    }
    if (buffer.items.length === 0) {
      return false;
    }
    let delivered = false;
    try {
      await params.onFlush(buffer.items);
      delivered = true;
    } catch (err) {
      params.onError?.(err, buffer.items);
    }
    return delivered;
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
    buffer.timeout = setTimeout(() => {
      void flushBuffer(key, buffer);
    }, buffer.debounceMs);
    buffer.timeout.unref?.();
  };

  const enqueue = async (item: T) => {
    const key = params.buildKey(item);
    const debounceMs = resolveDebounceMs(item);
    const canDebounce = debounceMs > 0 && (params.shouldDebounce?.(item) ?? true);

    if (!canDebounce || !key) {
      if (key && buffers.has(key)) {
        await flushKey(key);
      }
      try {
        await params.onFlush([item]);
      } catch (err) {
        params.onError?.(err, [item]);
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

    const buffer: DebounceBuffer<T> = {
      items: [item],
      timeout: null,
      debounceMs,
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
  INBOUND_DEBOUNCERS.set(registryKey, {
    flushAll: flushAllInternal,
    unregister,
  });

  return { enqueue, flushKey, flushAll, unregister };
}
