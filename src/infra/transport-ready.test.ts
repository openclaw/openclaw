import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitForTransportReady } from "./transport-ready.js";

describe("waitForTransportReady", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns when the check succeeds and logs after the delay", async () => {
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    let attempts = 0;
    const readyPromise = waitForTransportReady({
      label: "test transport",
      timeoutMs: 220,
      logAfterMs: 60,
      logIntervalMs: 1_000,
      pollIntervalMs: 50,
      runtime,
      check: async () => {
        attempts += 1;
        if (attempts > 2) {
          return { ok: true };
        }
        return { ok: false, error: "not ready" };
      },
    });

    for (let i = 0; i < 3; i += 1) {
      await vi.advanceTimersByTimeAsync(50);
    }

    await readyPromise;
    expect(runtime.error).toHaveBeenCalled();
  });

  it("throws after the timeout", async () => {
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const waitPromise = waitForTransportReady({
      label: "test transport",
      timeoutMs: 110,
      logAfterMs: 0,
      logIntervalMs: 1_000,
      pollIntervalMs: 50,
      runtime,
      check: async () => ({ ok: false, error: "still down" }),
    });
    await vi.advanceTimersByTimeAsync(200);
    await expect(waitPromise).rejects.toThrow("test transport not ready");
    expect(runtime.error).toHaveBeenCalled();
  });

  it("returns early when aborted", async () => {
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const controller = new AbortController();
    controller.abort();
    await waitForTransportReady({
      label: "test transport",
      timeoutMs: 200,
      runtime,
      abortSignal: controller.signal,
      check: async () => ({ ok: false, error: "still down" }),
    });
    expect(runtime.error).not.toHaveBeenCalled();
  });
});
