import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createTestRuntime } from "../commands/test-runtime-config-helpers.js";

const transportReadyMocks = vi.hoisted(() => ({
  injectedSleepError: null as Error | null,
}));

type TransportReadyModule = typeof import("./transport-ready.js");
let waitForTransportReady: TransportReadyModule["waitForTransportReady"];

vi.mock("./backoff.js", async (importOriginal) => {
  const { sleepWithAbort } = await importOriginal<typeof import("./backoff.js")>();
  return {
    sleepWithAbort: async (ms: number, signal?: AbortSignal) => {
      if (transportReadyMocks.injectedSleepError) {
        throw transportReadyMocks.injectedSleepError;
      }
      return sleepWithAbort(ms, signal);
    },
  };
});

describe("waitForTransportReady", () => {
  let runtime: ReturnType<typeof createTestRuntime>;
  function wait(
    options: Partial<Parameters<TransportReadyModule["waitForTransportReady"]>[0]> = {},
  ) {
    return waitForTransportReady({
      label: "test transport",
      timeoutMs: 500,
      pollIntervalMs: 50,
      runtime,
      check: async () => ({ ok: false, error: "still down" }),
      ...options,
    });
  }
  beforeAll(async () => {
    ({ waitForTransportReady } = await import("./transport-ready.js"));
  });

  beforeEach(() => {
    vi.useFakeTimers();
    runtime = createTestRuntime();
  });

  afterEach(() => {
    vi.useRealTimers();
    transportReadyMocks.injectedSleepError = null;
  });

  it("returns when the check succeeds and logs after the delay", async () => {
    let attempts = 0;
    const readyPromise = wait({
      timeoutMs: 220,
      // Deterministic: first attempt at t=0 won't log; second attempt at t=50 will.
      logAfterMs: 1,
      logIntervalMs: 1_000,
      check: async () => {
        attempts += 1;
        if (attempts > 2) {
          return { ok: true };
        }
        return { ok: false, error: "not ready" };
      },
    });

    await vi.advanceTimersByTimeAsync(200);

    await readyPromise;
    expect(runtime.error).toHaveBeenCalled();
  });

  it("caps oversized timeout values before computing the deadline", async () => {
    vi.setSystemTime(1_000);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const waitPromise = wait({
      timeoutMs: Number.MAX_SAFE_INTEGER,
      logAfterMs: Number.MAX_SAFE_INTEGER,
      pollIntervalMs: Number.MAX_SAFE_INTEGER,
    });
    const asserted = expect(waitPromise).rejects.toThrow("test transport not ready");

    await vi.advanceTimersByTimeAsync(1);
    expect(runtime.error).not.toHaveBeenCalled();
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);

    await vi.runOnlyPendingTimersAsync();
    await asserted;
    expect(runtime.error.mock.calls.at(-1)?.[0]).toContain(
      `not ready after ${MAX_TIMER_TIMEOUT_MS}ms`,
    );
  });

  it("returns early when aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await wait({
      timeoutMs: 200,
      abortSignal: controller.signal,
    });
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it.each([150])("stops quietly when aborted during a probe (%dms elapsed)", async (elapsedMs) => {
    vi.setSystemTime(0);
    const controller = new AbortController();
    const probe = createDeferred<{ ok: boolean; error: string }>();
    const check = vi.fn(() => probe.promise);
    const waitPromise = wait({
      timeoutMs: 100,
      logAfterMs: 0,
      abortSignal: controller.signal,
      check,
    });

    expect(check).toHaveBeenCalledOnce();
    controller.abort();
    vi.setSystemTime(elapsedMs);
    probe.resolve({ ok: false, error: "still down" });

    await expect(waitPromise).resolves.toBeUndefined();
    expect(check).toHaveBeenCalledOnce();
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("stops polling when aborted during the sleep interval", async () => {
    const controller = new AbortController();
    let attempts = 0;

    const waitPromise = wait({
      abortSignal: controller.signal,
      check: async () => {
        attempts += 1;
        setTimeout(() => controller.abort(), 10);
        return { ok: false, error: "still down" };
      },
    });

    await vi.advanceTimersByTimeAsync(100);
    await waitPromise;

    expect(attempts).toBe(1);
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("logs repeated unknown-error retries and the final timeout message", async () => {
    const waitPromise = wait({
      timeoutMs: 120,
      logAfterMs: 0,
      logIntervalMs: 50,
      check: async () => ({ ok: false, error: null }),
    });

    const asserted = expect(waitPromise).rejects.toThrow(
      "test transport not ready (unknown error)",
    );
    await vi.advanceTimersByTimeAsync(200);
    await asserted;

    expect(runtime.error).toHaveBeenCalledTimes(2);
    expect(runtime.error.mock.calls[0]?.[0]).toContain("unknown error");
    expect(runtime.error.mock.calls.at(-1)?.[0]).toContain("not ready after 120ms");
  });

  it("rethrows non-abort sleep failures", async () => {
    transportReadyMocks.injectedSleepError = new Error("sleep exploded");

    await expect(wait()).rejects.toThrow("sleep exploded");

    expect(runtime.error).not.toHaveBeenCalled();
  });
});
