import { describe, expect, it, vi } from "vitest";

import { waitForTransportReady } from "./transport-ready.js";

describe("waitForTransportReady", () => {
  it("returns when the check succeeds and logs after the delay", async () => {
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    let attempts = 0;
    await waitForTransportReady({
      label: "test transport",
      timeoutMs: 500,
      logAfterMs: 100,
      logIntervalMs: 100,
      pollIntervalMs: 50,
      runtime,
      check: async () => {
        attempts += 1;
        if (attempts > 3) return { ok: true };
        return { ok: false, error: "not ready" };
      },
    });
    expect(runtime.error).toHaveBeenCalled();
  });

  it("throws after the timeout", async () => {
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    await expect(
      waitForTransportReady({
        label: "test transport",
        timeoutMs: 200,
        logAfterMs: 0,
        logIntervalMs: 100,
        pollIntervalMs: 50,
        runtime,
        check: async () => ({ ok: false, error: "still down" }),
      }),
    ).rejects.toThrow("test transport not ready");
    expect(runtime.error).toHaveBeenCalled();
  });
});
