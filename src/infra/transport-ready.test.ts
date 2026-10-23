import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createTestRuntime } from "../commands/test-runtime-config-helpers.js";
import { sleepWithAbort } from "./backoff.js";
import { waitForTransportReady } from "./transport-ready.js";

vi.mock("./backoff.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./backoff.js")>();
  return { ...actual, sleepWithAbort: vi.fn(actual.sleepWithAbort) };
});

describe("waitForTransportReady", () => {
  let runtime: ReturnType<typeof createTestRuntime>;
  function wait(options: Partial<Parameters<typeof waitForTransportReady>[0]> = {}) {
    return waitForTransportReady({
      label: "test transport",
      timeoutMs: 500,
      pollIntervalMs: 50,
      runtime,
      check: async () => ({ ok: false, error: "still down" }),
      ...options,
    });
  }
  beforeEach(() => {
    vi.useFakeTimers();
    runtime = createTestRuntime();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns when the check succeeds and logs after the delay", async () => {
    let attempts = 0;
    const readyPromise = wait({
      timeoutMs: 220,
      // First attempt at t=0 won't log; second attempt at t=50 will.
      logAfterMs: 1,
      logIntervalMs: 1_000,
      check: async () => (++attempts > 2 ? { ok: true } : { ok: false, error: "not ready" }),
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

  it.each(["before", "probe", "sleep"] as const)(
    "stops quietly when aborted during %s",
    async (phase) => {
      vi.setSystemTime(0);
      const controller = new AbortController();
      const probe = createDeferred<{ ok: boolean; error: string }>();
      const check = vi.fn(async () => {
        if (phase === "probe") {
          return probe.promise;
        }
        setTimeout(() => controller.abort(), 10);
        return { ok: false, error: "still down" };
      });
      if (phase === "before") {
        controller.abort();
      }
      const waiting = wait({
        timeoutMs: 100,
        logAfterMs: phase === "probe" ? 0 : 100,
        abortSignal: controller.signal,
        check,
      });
      const attempts = phase === "before" ? 0 : 1;
      expect(check).toHaveBeenCalledTimes(attempts);
      if (phase === "probe") {
        controller.abort();
        vi.setSystemTime(150);
        probe.resolve({ ok: false, error: "still down" });
      } else {
        await vi.advanceTimersByTimeAsync(100);
      }
      await expect(waiting).resolves.toBeUndefined();
      expect(check).toHaveBeenCalledTimes(attempts);
      expect(runtime.error).not.toHaveBeenCalled();
    },
  );

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
    vi.mocked(sleepWithAbort).mockRejectedValueOnce(new Error("sleep exploded"));

    await expect(wait()).rejects.toThrow("sleep exploded");

    expect(runtime.error).not.toHaveBeenCalled();
  });
});
