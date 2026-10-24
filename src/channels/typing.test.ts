import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createTypingCallbacks } from "./typing.js";

type TypingHarnessOptions = Partial<Parameters<typeof createTypingCallbacks>[0]>;

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const activeCallbacks = new Set<ReturnType<typeof createTypingCallbacks>>();

beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  for (const callbacks of activeCallbacks) {
    callbacks.onCleanup?.();
  }
  activeCallbacks.clear();
  await flushMicrotasks();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function createTypingHarness(overrides: TypingHarnessOptions = {}) {
  const start = vi.fn(overrides.start ?? (async () => {}));
  const stop = vi.fn(overrides.stop ?? (async () => {}));
  const onStartError = vi.fn(overrides.onStartError ?? ((_err: unknown) => {}));
  const onStopError = vi.fn(overrides.onStopError ?? ((_err: unknown) => {}));
  const callbacks = createTypingCallbacks({
    ...overrides,
    start,
    stop,
    onStartError,
    onStopError,
    maxDurationMs: overrides.maxDurationMs ?? 0,
  });
  activeCallbacks.add(callbacks);
  return { start, stop, onStartError, onStopError, callbacks };
}

describe("createTypingCallbacks", () => {
  it("coalesces concurrent starts without blocking and allows a later start", async () => {
    const { promise, resolve } = createDeferred();
    const { start, callbacks } = createTypingHarness({
      start: vi.fn().mockReturnValueOnce(promise).mockResolvedValue(undefined),
    });

    await Promise.all(Array.from({ length: 100 }, () => callbacks.onReplyStart()));
    expect(start).toHaveBeenCalledTimes(1);
    resolve();
    await flushMicrotasks();
    await callbacks.onReplyStart();
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("coalesces explicit starts with a pending keepalive without shifting cadence", async () => {
    const { promise, resolve } = createDeferred();
    const { start, callbacks } = createTypingHarness({
      start: vi
        .fn(async () => {})
        .mockResolvedValueOnce(undefined)
        .mockReturnValueOnce(promise),
    });

    await callbacks.onReplyStart();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(start).toHaveBeenCalledTimes(2);

    await callbacks.onReplyStart();
    await vi.advanceTimersByTimeAsync(9_000);
    expect(start).toHaveBeenCalledTimes(2);

    resolve();
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(2_999);
    expect(start).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(start).toHaveBeenCalledTimes(3);
  });

  it.each([
    { phase: "initial", finish: "cleanup", rejected: false },
    { phase: "keepalive", finish: "TTL", rejected: false },
    { phase: "keepalive", finish: "cleanup", rejected: true },
  ])(
    "orders $finish stop after the pending $phase start (rejected=$rejected)",
    async ({ phase, finish, rejected }) => {
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
      expect(onStartError.mock.calls).toEqual(rejected ? [[failure]] : []);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(20_000);
      await callbacks.onReplyStart();
      expect(start).toHaveBeenCalledTimes(admittedStarts);
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
    vi.setSystemTime(0);
    const acceptedStarts: number[] = [];
    const { callbacks } = createTypingHarness({
      keepaliveIntervalMs: 4_000,
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

  it.each([1, 2])(
    "coalesces failures, stops at breaker %i, and resets for a new reply",
    async (limit) => {
      const { start, onStartError, callbacks } = createTypingHarness({
        start: vi.fn().mockRejectedValue(new Error("gone")),
        maxConsecutiveFailures: limit === 1 ? 1 : undefined,
      });
      await Promise.all(Array.from({ length: 100 }, () => callbacks.onReplyStart()));
      await flushMicrotasks();
      expect(start).toHaveBeenCalledTimes(1);
      expect(onStartError).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(3_000);
      expect(start).toHaveBeenCalledTimes(limit);
      expect(onStartError).toHaveBeenCalledTimes(limit);

      await vi.advanceTimersByTimeAsync(9_000);
      expect(start).toHaveBeenCalledTimes(limit);

      start.mockResolvedValue(undefined);
      await callbacks.onReplyStart();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(start).toHaveBeenCalledTimes(limit + 2);
      expect(onStartError).toHaveBeenCalledTimes(limit);
    },
  );

  it.each(["keepalive", "TTL"])("clamps oversized %s before arming timers", async (mode) => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { start, stop, callbacks } = createTypingHarness(
      mode === "TTL"
        ? { keepaliveIntervalMs: 0, maxDurationMs: Number.MAX_SAFE_INTEGER }
        : { keepaliveIntervalMs: Number.MAX_SAFE_INTEGER },
    );
    const observed = mode === "TTL" ? stop : start;
    const initialCalls = mode === "TTL" ? 0 : 1;
    await callbacks.onReplyStart();
    await flushMicrotasks();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(MAX_TIMER_TIMEOUT_MS - 1);
    expect(observed).toHaveBeenCalledTimes(initialCalls);
    await vi.advanceTimersByTimeAsync(1);
    expect(observed).toHaveBeenCalledTimes(initialCalls + 1);
    if (mode === "TTL") {
      expect(consoleWarn).toHaveBeenCalledWith(
        `[typing] TTL exceeded (${MAX_TIMER_TIMEOUT_MS}ms), auto-stopping typing indicator`,
      );
    }
  });
});
