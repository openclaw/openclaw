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
  ready: Promise<void>;
  releaseReady: () => void;
  readyReleased: boolean;
  task: Promise<void>;
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
  const keyChains = new Map<string, Promise<void>>();
  const defaultDebounceMs = Math.max(0, Math.trunc(params.debounceMs));

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
    } catch (err) {
      params.onError?.(err, items);
    }
  };

  const enqueueKeyTask = (key: string, task: () => Promise<void>) => {
    const previous = keyChains.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    const settled = next.catch(() => undefined);
    keyChains.set(key, settled);
    void settled.finally(() => {
      if (keyChains.get(key) === settled) {
        keyChains.delete(key);
      }
    });
    return next;
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

  const scheduleFlush = (key: string, buffer: DebounceBuffer<T>) => {
    if (buffer.timeout) {
      clearTimeout(buffer.timeout);
    }
    buffer.timeout = setTimeout(async () => {
      await flushBuffer(key, buffer);
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
      if (key) {
        await enqueueKeyTask(key, async () => {
          await runFlush([item]);
        });
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

    let releaseReady!: () => void;
    const buffer: DebounceBuffer<T> = {
      items: [item],
      timeout: null,
      debounceMs,
      ready: new Promise<void>((resolve) => {
        releaseReady = resolve;
      }),
      releaseReady,
      readyReleased: false,
      task: Promise.resolve(),
    };
    buffer.task = enqueueKeyTask(key, async () => {
      await buffer.ready;
      if (buffer.items.length === 0) {
        return;
      }
      await runFlush(buffer.items);
    });
    buffers.set(key, buffer);
    scheduleFlush(key, buffer);
  };

  return { enqueue, flushKey };
}
