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
};

const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_MS = 500;

export function createInboundDebouncer<T>(params: {
  debounceMs: number;
  buildKey: (item: T) => string | null | undefined;
  shouldDebounce?: (item: T) => boolean;
  onFlush: (items: T[]) => Promise<void>;
  onError?: (err: unknown, items: T[]) => void;
  /** Max retry attempts when flush fails (default: 3). */
  retryAttempts?: number;
  /** Base delay in ms for exponential backoff (default: 500). */
  retryBaseMs?: number;
}) {
  const buffers = new Map<string, DebounceBuffer<T>>();
  const debounceMs = Math.max(0, Math.trunc(params.debounceMs));
  const retryAttempts = params.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS;
  const retryBaseMs = params.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;

  const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  const flushBuffer = async (key: string, buffer: DebounceBuffer<T>) => {
    buffers.delete(key);
    if (buffer.timeout) {
      clearTimeout(buffer.timeout);
      buffer.timeout = null;
    }
    if (buffer.items.length === 0) {
      return;
    }
    // Retry with exponential backoff when flush fails (e.g. session store
    // lock contention).  This prevents silent message loss when a cron job
    // or other operation holds the lock temporarily.
    // See: https://github.com/openclaw/openclaw/issues/17421
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retryAttempts; attempt++) {
      try {
        await params.onFlush(buffer.items);
        return;
      } catch (err) {
        lastErr = err;
        if (attempt < retryAttempts) {
          await delay(retryBaseMs * 2 ** attempt);
        }
      }
    }
    params.onError?.(lastErr, buffer.items);
  };

  const flushKey = async (key: string) => {
    const buffer = buffers.get(key);
    if (!buffer) {
      return;
    }
    await flushBuffer(key, buffer);
  };

  const scheduleFlush = (key: string, buffer: DebounceBuffer<T>) => {
    if (buffer.timeout) {
      clearTimeout(buffer.timeout);
    }
    buffer.timeout = setTimeout(() => {
      void flushBuffer(key, buffer);
    }, debounceMs);
    buffer.timeout.unref?.();
  };

  const enqueue = async (item: T) => {
    const key = params.buildKey(item);
    const canDebounce = debounceMs > 0 && (params.shouldDebounce?.(item) ?? true);

    if (!canDebounce || !key) {
      if (key && buffers.has(key)) {
        await flushKey(key);
      }
      // Route non-debounced messages (media, control commands) through
      // flushBuffer so they also benefit from retry-on-lock-contention.
      await flushBuffer("__immediate__", { items: [item], timeout: null });
      return;
    }

    const existing = buffers.get(key);
    if (existing) {
      existing.items.push(item);
      scheduleFlush(key, existing);
      return;
    }

    const buffer: DebounceBuffer<T> = { items: [item], timeout: null };
    buffers.set(key, buffer);
    scheduleFlush(key, buffer);
  };

  return { enqueue, flushKey };
}
