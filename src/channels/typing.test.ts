import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
// Typing tests cover typing indicator start, update, and cleanup behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createTypingCallbacks } from "./typing.js";

type TypingCallbackOverrides = Partial<Parameters<typeof createTypingCallbacks>[0]>;
type TypingHarnessOptions = TypingCallbackOverrides;
type TypingHarnessStart = ReturnType<typeof vi.fn<() => Promise<void>>>;
type TypingHarnessError = ReturnType<typeof vi.fn<(err: unknown) => void>>;

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const activeCallbacks = new Set<ReturnType<typeof createTypingCallbacks>>();

afterEach(async () => {
  for (const callbacks of activeCallbacks) {
    callbacks.onCleanup?.();
  }
  activeCallbacks.clear();
  await flushMicrotasks();
  vi.useRealTimers();
});

async function withFakeTimers(run: () => Promise<void>) {
  vi.useFakeTimers();
  try {
    await run();
  } finally {
    await flushMicrotasks();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
}

function createTypingHarness(overrides: TypingHarnessOptions = {}) {
  const start: TypingHarnessStart = vi.fn<() => Promise<void>>(async () => {});
  const stop: TypingHarnessStart = vi.fn<() => Promise<void>>(async () => {});
  const onStartError: TypingHarnessError = vi.fn<(err: unknown) => void>();
  const onStopError: TypingHarnessError = vi.fn<(err: unknown) => void>();

  if (overrides.start) {
    start.mockImplementation(overrides.start);
  }
  if (overrides.stop) {
    stop.mockImplementation(overrides.stop);
  }
  if (overrides.onStartError) {
    onStartError.mockImplementation(overrides.onStartError);
  }
  if (overrides.onStopError) {
    onStopError.mockImplementation(overrides.onStopError);
  }

  const callbacks = createTypingCallbacks({
    start,
    stop,
    onStartError,
    onStopError,
    ...(overrides.maxConsecutiveFailures !== undefined
      ? { maxConsecutiveFailures: overrides.maxConsecutiveFailures }
      : {}),
    ...(overrides.keepaliveIntervalMs !== undefined
      ? { keepaliveIntervalMs: overrides.keepaliveIntervalMs }
      : {}),
    maxDurationMs: overrides.maxDurationMs ?? 0,
  });
  activeCallbacks.add(callbacks);
  return { start, stop, onStartError, onStopError, callbacks };
}

describe("createTypingCallbacks", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("coalesces concurrent starts without blocking and allows a later start", async () => {
    let resolveStart: (() => void) | undefined;
    const { start, callbacks } = createTypingHarness({
      start: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              resolveStart = resolve;
            }),
        )
        .mockResolvedValue(undefined),
    });

    try {
      await Promise.all(Array.from({ length: 100 }, () => callbacks.onReplyStart()));

      expect(start).toHaveBeenCalledTimes(1);
      if (!resolveStart) {
        throw new Error("Expected typing start resolver to be initialized");
      }
      resolveStart();
      await flushMicrotasks();

      await callbacks.onReplyStart();
      expect(start).toHaveBeenCalledTimes(2);
    } finally {
      callbacks.onCleanup?.();
    }
  });

  it("coalesces explicit starts with a pending keepalive without shifting cadence", async () => {
    await withFakeTimers(async () => {
      let resolvePendingStart: (() => void) | undefined;
      const { start, callbacks } = createTypingHarness({
        start: vi
          .fn()
          .mockResolvedValueOnce(undefined)
          .mockImplementationOnce(
            () =>
              new Promise<void>((resolve) => {
                resolvePendingStart = resolve;
              }),
          )
          .mockResolvedValue(undefined),
      });

      await callbacks.onReplyStart();
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(start).toHaveBeenCalledTimes(2);

      await callbacks.onReplyStart();
      await vi.advanceTimersByTimeAsync(9_000);
      expect(start).toHaveBeenCalledTimes(2);

      if (!resolvePendingStart) {
        throw new Error("Expected pending keepalive resolver to be initialized");
      }
      resolvePendingStart();
      await flushMicrotasks();

      await vi.advanceTimersByTimeAsync(2_999);
      expect(start).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(start).toHaveBeenCalledTimes(3);
    });
  });

  it.each([
    { phase: "initial", finish: "cleanup", rejected: false },
    { phase: "keepalive", finish: "TTL", rejected: false },
    { phase: "keepalive", finish: "cleanup", rejected: true },
  ])(
    "orders $finish stop after the pending $phase start (rejected=$rejected)",
    async ({ phase, finish, rejected }) => {
      await withFakeTimers(async () => {
        const { promise, resolve, reject } = createDeferred();
        const startImplementation = vi.fn<() => Promise<void>>();
        if (phase === "keepalive") {
          startImplementation.mockResolvedValueOnce(undefined);
        }
        startImplementation.mockReturnValueOnce(promise);
        const { start, stop, onStartError, callbacks } = createTypingHarness({
          maxDurationMs: 10_000,
          start: startImplementation,
        });

        await callbacks.onReplyStart();
        if (phase === "keepalive") {
          await vi.advanceTimersByTimeAsync(3_000);
        }
        const admittedStarts = start.mock.calls.length;
        if (finish === "TTL") {
          vi.spyOn(console, "warn").mockImplementation(() => {});
          await vi.advanceTimersByTimeAsync(7_000);
        } else {
          callbacks.onCleanup?.();
        }
        callbacks.onCleanup?.();
        expect(stop).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);

        const failure = new Error("typing unavailable");
        if (rejected) {
          reject(failure);
        } else {
          resolve();
        }
        await flushMicrotasks();
        expect(stop).toHaveBeenCalledTimes(1);
        expect(onStartError).toHaveBeenCalledTimes(rejected ? 1 : 0);
        if (rejected) {
          expect(onStartError).toHaveBeenCalledWith(failure);
        }
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(20_000);
        await callbacks.onReplyStart();
        expect(start).toHaveBeenCalledTimes(admittedStarts);
      });
    },
  );

  it("invokes stop on idle and reports stop errors", async () => {
    const { stop, onStopError, callbacks } = createTypingHarness({
      stop: vi.fn().mockRejectedValue(new Error("stop")),
    });

    callbacks.onIdle?.();
    await flushMicrotasks();

    expect(stop).toHaveBeenCalledTimes(1);
    expect(onStopError).toHaveBeenCalledTimes(1);
  });

  it("keeps coalesced typing alive beyond 60 seconds while the same task refreshes it", async () => {
    await withFakeTimers(async () => {
      vi.setSystemTime(0);
      const acceptedStarts: number[] = [];
      const { callbacks } = createTypingHarness({
        keepaliveIntervalMs: 4_000,
        maxDurationMs: 0,
        start: async () => {
          const now = Date.now();
          const previous = acceptedStarts.at(-1);
          if (previous !== undefined && now - previous < 4_000) {
            return;
          }
          acceptedStarts.push(now);
        },
      });

      await callbacks.onReplyStart();
      for (let elapsedMs = 6_000; elapsedMs <= 132_000; elapsedMs += 6_000) {
        await vi.advanceTimersByTimeAsync(6_000);
        await callbacks.onReplyStart();
      }

      expect(acceptedStarts.at(-1)).toBeGreaterThan(120_000);
      for (let index = 1; index < acceptedStarts.length; index += 1) {
        expect(acceptedStarts[index]! - acceptedStarts[index - 1]!).toBeLessThanOrEqual(4_000);
      }

      callbacks.onIdle?.();
      const countAtTaskCompletion = acceptedStarts.length;
      await vi.advanceTimersByTimeAsync(12_000);
      expect(acceptedStarts).toHaveLength(countAtTaskCompletion);
    });
  });

  it("counts a coalesced rejection once and stops keepalive at the failure breaker", async () => {
    await withFakeTimers(async () => {
      const { start, onStartError, callbacks } = createTypingHarness({
        start: vi.fn().mockRejectedValue(new Error("gone")),
      });
      await Promise.all(Array.from({ length: 100 }, () => callbacks.onReplyStart()));
      await flushMicrotasks();
      expect(start).toHaveBeenCalledTimes(1);
      expect(onStartError).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(3_000);
      expect(start).toHaveBeenCalledTimes(2);
      expect(onStartError).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(9_000);
      expect(start).toHaveBeenCalledTimes(2);
    });
  });

  it("clamps oversized keepalive intervals before arming timers", async () => {
    await withFakeTimers(async () => {
      const { start, callbacks } = createTypingHarness({
        keepaliveIntervalMs: Number.MAX_SAFE_INTEGER,
        maxDurationMs: 0,
      });

      await callbacks.onReplyStart();
      await flushMicrotasks();

      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(MAX_TIMER_TIMEOUT_MS - 1);
      expect(start).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(start).toHaveBeenCalledTimes(2);
      callbacks.onCleanup?.();
    });
  });

  it("stops keepalive when the initial start trips the breaker and resets for a new reply", async () => {
    await withFakeTimers(async () => {
      const { start, onStartError, callbacks } = createTypingHarness({
        start: vi.fn().mockRejectedValue(new Error("gone")),
        maxConsecutiveFailures: 1,
      });

      await callbacks.onReplyStart();
      await flushMicrotasks();
      expect(start).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(9_000);
      expect(start).toHaveBeenCalledTimes(1);
      expect(onStartError).toHaveBeenCalledTimes(1);

      start.mockResolvedValue(undefined);
      await callbacks.onReplyStart();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(start).toHaveBeenCalledTimes(3);
      expect(onStartError).toHaveBeenCalledTimes(1);
    });
  });

  describe("TTL safety", () => {
    it("clamps oversized TTLs before arming timers", async () => {
      await withFakeTimers(async () => {
        const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const { stop, callbacks } = createTypingHarness({
          keepaliveIntervalMs: 0,
          maxDurationMs: Number.MAX_SAFE_INTEGER,
        });

        await callbacks.onReplyStart();
        await flushMicrotasks();

        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(MAX_TIMER_TIMEOUT_MS - 1);
        expect(stop).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(stop).toHaveBeenCalledTimes(1);
        expect(consoleWarn).toHaveBeenCalledWith(
          `[typing] TTL exceeded (${MAX_TIMER_TIMEOUT_MS}ms), auto-stopping typing indicator`,
        );
        callbacks.onCleanup?.();
      });
    });
  });
});
