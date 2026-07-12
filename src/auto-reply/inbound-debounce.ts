// Keyed inbound-message debouncer that preserves same-key delivery order.
import { AsyncLocalStorage } from "node:async_hooks";
import {
  resolveNonNegativeIntegerOption,
  resolveOptionalIntegerOption,
} from "@openclaw/normalization-core/number-coercion";
import type { InboundDebounceByProvider } from "../config/types.messages.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runWithGatewayIndependentRootWorkContinuation } from "../process/gateway-work-admission.js";
import { resolveGlobalMap } from "../shared/global-singleton.js";

const INBOUND_DEBOUNCER_FLUSH = Symbol.for("openclaw.inboundDebouncerFlush");
const INBOUND_DEBOUNCER_PENDING = Symbol.for("openclaw.inboundDebouncerPending");
const MAX_GLOBAL_FLUSH_PASSES = 100;
const MAX_GLOBAL_FLUSH_TIMEOUT_MS = 30_000;
const FLUSH_TIMED_OUT = Symbol("inboundDebouncerFlushTimedOut");

type AsyncContextRunner = ReturnType<typeof AsyncLocalStorage.snapshot>;
type InboundDebouncerFlushPass = {
  completion: Promise<void>;
  flushed: number;
};

type RegisteredInboundDebouncer = {
  [INBOUND_DEBOUNCER_FLUSH]: (runInContext: AsyncContextRunner) => InboundDebouncerFlushPass;
  [INBOUND_DEBOUNCER_PENDING]: () => number;
};

const INBOUND_DEBOUNCERS = resolveGlobalMap<symbol, WeakRef<RegisteredInboundDebouncer>>(
  Symbol.for("openclaw.inboundDebouncers.weak"),
);

function registerInboundDebouncer(debouncer: RegisteredInboundDebouncer): void {
  for (const [key, reference] of INBOUND_DEBOUNCERS) {
    if (!reference.deref()) {
      INBOUND_DEBOUNCERS.delete(key);
    }
  }
  INBOUND_DEBOUNCERS.set(Symbol(), new WeakRef(debouncer));
}

function collectLiveInboundDebouncers(): RegisteredInboundDebouncer[] {
  const live: RegisteredInboundDebouncer[] = [];
  for (const [key, reference] of INBOUND_DEBOUNCERS) {
    const debouncer = reference.deref();
    if (!debouncer) {
      INBOUND_DEBOUNCERS.delete(key);
      continue;
    }
    live.push(debouncer);
  }
  return live;
}

function countPendingInboundDebounceBuffers(): number {
  return collectLiveInboundDebouncers().reduce(
    (pending, debouncer) => pending + debouncer[INBOUND_DEBOUNCER_PENDING](),
    0,
  );
}

async function waitForFlushPass(completion: Promise<void>, timeoutMs: number): Promise<boolean> {
  if (timeoutMs <= 0) {
    return false;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      completion,
      new Promise<typeof FLUSH_TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(FLUSH_TIMED_OUT), timeoutMs);
        timer.unref?.();
      }),
    ]);
    return outcome !== FLUSH_TIMED_OUT;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export type InboundDebouncerDrainResult = {
  drained: boolean;
  flushed: number;
  remaining: number;
};

/**
 * Flush live inbound debounce buffers to their normal channel callbacks.
 *
 * The finite pass and time budgets prevent a still-open transport from keeping
 * restart shutdown in this phase forever. The captured async context transfers
 * pre-created buffer callbacks into the core-owned restart continuation.
 */
export async function flushAllInboundDebouncers(
  timeoutMs?: number,
): Promise<InboundDebouncerDrainResult> {
  const effectiveTimeoutMs = Math.max(
    0,
    Math.min(timeoutMs ?? MAX_GLOBAL_FLUSH_TIMEOUT_MS, MAX_GLOBAL_FLUSH_TIMEOUT_MS),
  );
  const deadline = Date.now() + effectiveTimeoutMs;
  const runInContext = AsyncLocalStorage.snapshot();
  let flushed = 0;
  for (let pass = 0; pass < MAX_GLOBAL_FLUSH_PASSES; pass += 1) {
    const live = collectLiveInboundDebouncers();
    const pending = live.reduce(
      (count, debouncer) => count + debouncer[INBOUND_DEBOUNCER_PENDING](),
      0,
    );
    if (pending === 0) {
      return { drained: true, flushed, remaining: 0 };
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return { drained: false, flushed, remaining: pending };
    }

    const flushPasses = live.map((debouncer) => debouncer[INBOUND_DEBOUNCER_FLUSH](runInContext));
    const flushedThisPass = flushPasses.reduce((count, result) => count + result.flushed, 0);
    flushed += flushedThisPass;
    const completed = await waitForFlushPass(
      Promise.all(flushPasses.map((result) => result.completion)).then(() => undefined),
      remainingMs,
    );
    if (!completed) {
      return {
        drained: false,
        flushed,
        remaining: Math.max(1, countPendingInboundDebounceBuffers()),
      };
    }
  }

  const remaining = countPendingInboundDebounceBuffers();
  return remaining === 0
    ? { drained: true, flushed, remaining: 0 }
    : { drained: false, flushed, remaining };
}

const resolveMs = (value: unknown): number | undefined =>
  resolveOptionalIntegerOption(value, { min: 0 });

const resolveChannelOverride = (params: {
  byChannel?: InboundDebounceByProvider;
  channel: string;
}): number | undefined => {
  if (!params.byChannel) {
    return undefined;
  }
  return resolveMs(params.byChannel[params.channel]);
};

/** Resolve effective inbound debounce milliseconds from explicit, channel, and global config. */
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
  runInFlushContext?: AsyncContextRunner;
  releaseReady: () => void;
  readyReleased: boolean;
  task: Promise<void>;
};

const DEFAULT_MAX_TRACKED_KEYS = 2048;

/** Options for creating a keyed inbound debouncer. */
export type InboundDebounceCreateParams<T> = {
  debounceMs: number;
  maxTrackedKeys?: number;
  buildKey: (item: T) => string | null | undefined;
  shouldDebounce?: (item: T) => boolean;
  resolveDebounceMs?: (item: T) => number | undefined;
  serializeImmediate?: boolean;
  onFlush: (items: T[]) => Promise<void>;
  onError?: (err: unknown, items: T[]) => void;
  onCancel?: (items: T[]) => void;
};

/** Create a keyed debouncer with flush/cancel controls and same-key serialization. */
export function createInboundDebouncer<T>(params: InboundDebounceCreateParams<T>): {
  enqueue: (item: T) => Promise<void>;
  flushKey: (key: string) => Promise<void>;
  cancelKey: (key: string) => boolean;
} {
  const buffers = new Map<string, DebounceBuffer<T>>();
  const inFlightBuffers = new Set<DebounceBuffer<T>>();
  const keyChains = new Map<string, Promise<void>>();
  const defaultDebounceMs = resolveNonNegativeIntegerOption(params.debounceMs, 0);
  const maxTrackedKeys = Math.max(1, Math.trunc(params.maxTrackedKeys ?? DEFAULT_MAX_TRACKED_KEYS));

  const resolveDebounceMs = (item: T) => {
    const resolved = params.resolveDebounceMs?.(item);
    return resolveNonNegativeIntegerOption(resolved, defaultDebounceMs);
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

  const runKeyTaskNow = (key: string, task: () => Promise<void>) => {
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    keyChains.set(key, settled);
    const cleanup = () => {
      resolveSettled();
      if (keyChains.get(key) === settled) {
        keyChains.delete(key);
      }
    };
    let next: Promise<void>;
    try {
      next = task();
    } catch (err) {
      cleanup();
      throw err;
    }
    next.then(cleanup, cleanup);
    return next;
  };

  const enqueueReservedKeyTask = (key: string, task: () => Promise<void>) => {
    let readyReleased = false;
    let releaseReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    const previous = keyChains.get(key) ?? Promise.resolve();
    const next = runWithGatewayIndependentRootWorkContinuation(async () => {
      await previous.catch(() => undefined);
      await ready;
      await task();
    });
    const settled = next.catch(() => undefined);
    keyChains.set(key, settled);
    const cleanup = () => {
      if (keyChains.get(key) === settled) {
        keyChains.delete(key);
      }
    };
    settled.then(cleanup, cleanup);
    return {
      task: next,
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

  const flushBuffer = async (
    key: string,
    buffer: DebounceBuffer<T>,
    runInContext?: AsyncContextRunner,
  ) => {
    inFlightBuffers.add(buffer);
    try {
      if (buffers.get(key) === buffer) {
        buffers.delete(key);
      }
      if (buffer.timeout) {
        clearTimeout(buffer.timeout);
        buffer.timeout = null;
      }
      // Reserve each key's execution slot as soon as the first buffered item
      // arrives, so later same-key work cannot overtake a timer-backed flush.
      if (runInContext) {
        buffer.runInFlushContext = runInContext;
      }
      releaseBuffer(buffer);
      await buffer.task;
    } finally {
      inFlightBuffers.delete(buffer);
    }
  };

  const flushKey = async (key: string) => {
    const buffer = buffers.get(key);
    if (!buffer) {
      return;
    }
    await flushBuffer(key, buffer);
  };

  const flushAll = (runInContext: AsyncContextRunner): InboundDebouncerFlushPass => {
    const pending = [...buffers.entries()];
    const inFlight = [...inFlightBuffers];
    for (const buffer of inFlight) {
      buffer.runInFlushContext ??= runInContext;
    }
    return {
      flushed: pending.length,
      completion: Promise.all([
        ...pending.map(async ([key, buffer]) => await flushBuffer(key, buffer, runInContext)),
        ...inFlight.map(async (buffer) => await buffer.task),
      ]).then(() => undefined),
    };
  };

  const cancelKey = (key: string): boolean => {
    const buffer = buffers.get(key);
    if (!buffer) {
      return false;
    }
    if (buffers.get(key) === buffer) {
      buffers.delete(key);
    }
    if (buffer.timeout) {
      clearTimeout(buffer.timeout);
      buffer.timeout = null;
    }
    const canceledItems = buffer.items;
    buffer.items = [];
    try {
      params.onCancel?.(canceledItems);
    } catch {
      // Cancellation observers release caller-owned resources; debounce state
      // must still drain even if an observer fails.
    }
    releaseBuffer(buffer);
    return true;
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

  const canTrackKey = (key: string) => {
    if (buffers.has(key) || keyChains.has(key)) {
      return true;
    }
    return new Set([...buffers.keys(), ...keyChains.keys()]).size < maxTrackedKeys;
  };

  const enqueue = async (item: T) => {
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
        if (params.serializeImmediate) {
          await runKeyTaskNow(key, async () => {
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
    const reservedTask = enqueueReservedKeyTask(key, async () => {
      const run = async () => {
        if (buffer.items.length === 0) {
          return;
        }
        await runFlush(buffer.items);
      };
      if (buffer.runInFlushContext) {
        await buffer.runInFlushContext(run);
        return;
      }
      await run();
    });
    const buffer: DebounceBuffer<T> = {
      items: [item],
      timeout: null,
      debounceMs,
      releaseReady: reservedTask.release,
      readyReleased: false,
      task: reservedTask.task,
    };
    buffers.set(key, buffer);
    scheduleFlush(key, buffer);
  };

  const debouncer = {
    enqueue,
    flushKey,
    cancelKey,
    [INBOUND_DEBOUNCER_FLUSH]: flushAll,
    [INBOUND_DEBOUNCER_PENDING]: () => buffers.size + inFlightBuffers.size,
  };
  registerInboundDebouncer(debouncer);
  return debouncer;
}
