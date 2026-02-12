import { afterEach, describe, expect, it, vi } from "vitest";

async function loadWakeModule() {
  vi.resetModules();
  return import("./heartbeat-wake.js");
}

describe("heartbeat-wake", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("coalesces multiple wake requests into one run", async () => {
    vi.useFakeTimers();
    const wake = await loadWakeModule();
    const handler = vi.fn().mockResolvedValue({ status: "skipped", reason: "disabled" });
    wake.setHeartbeatWakeHandler(handler);

    wake.requestHeartbeatNow({ reason: "interval", coalesceMs: 200 });
    wake.requestHeartbeatNow({ reason: "exec-event", coalesceMs: 200 });
    wake.requestHeartbeatNow({ reason: "retry", coalesceMs: 200 });

    expect(wake.hasPendingHeartbeatWake()).toBe(true);

    await vi.advanceTimersByTimeAsync(199);
    expect(handler).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ reason: "retry" });
    expect(wake.hasPendingHeartbeatWake()).toBe(false);
  });

  it("retries requests-in-flight after the default retry delay", async () => {
    vi.useFakeTimers();
    const wake = await loadWakeModule();
    const handler = vi
      .fn()
      .mockResolvedValueOnce({ status: "skipped", reason: "requests-in-flight" })
      .mockResolvedValueOnce({ status: "ran", durationMs: 1 });
    wake.setHeartbeatWakeHandler(handler);

    wake.requestHeartbeatNow({ reason: "interval", coalesceMs: 0 });

    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500);
    expect(handler).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[1]?.[0]).toEqual({ reason: "interval" });
  });

  it("retries thrown handler errors after the default retry delay", async () => {
    vi.useFakeTimers();
    const wake = await loadWakeModule();
    const handler = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ status: "skipped", reason: "disabled" });
    wake.setHeartbeatWakeHandler(handler);

    wake.requestHeartbeatNow({ reason: "exec-event", coalesceMs: 0 });

    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500);
    expect(handler).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[1]?.[0]).toEqual({ reason: "exec-event" });
  });

  it("drains pending wake once a handler is registered", async () => {
    vi.useFakeTimers();
    const wake = await loadWakeModule();

    wake.requestHeartbeatNow({ reason: "manual", coalesceMs: 0 });
    await vi.advanceTimersByTimeAsync(1);
    expect(wake.hasPendingHeartbeatWake()).toBe(true);

    const handler = vi.fn().mockResolvedValue({ status: "skipped", reason: "disabled" });
    wake.setHeartbeatWakeHandler(handler);

    await vi.advanceTimersByTimeAsync(249);
    expect(handler).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ reason: "manual" });
    expect(wake.hasPendingHeartbeatWake()).toBe(false);
  });
});
