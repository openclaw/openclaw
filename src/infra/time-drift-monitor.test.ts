import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the time-drift module before importing the monitor.
vi.mock("./time-drift.js", () => ({
  checkTimeDrift: vi.fn(),
  formatDriftForLog: vi.fn((r: { exceeds: boolean }) => (r.exceeds ? "clock drifted" : "clock ok")),
}));

import { createTimeDriftMonitor } from "./time-drift-monitor.js";
import { checkTimeDrift } from "./time-drift.js";

function makeLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("createTimeDriftMonitor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("logs info when drift is within tolerance", async () => {
    vi.mocked(checkTimeDrift).mockResolvedValueOnce({
      driftMs: 100,
      absDriftMs: 100,
      exceeds: false,
      source: "https://www.google.com",
      thresholdMs: 60_000,
    });

    const log = makeLog();
    const monitor = createTimeDriftMonitor({ log });
    const exceeds = await monitor.checkOnce();

    expect(exceeds).toBe(false);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("time-drift:"));
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("logs warn when drift exceeds threshold", async () => {
    vi.mocked(checkTimeDrift).mockResolvedValueOnce({
      driftMs: 120_000,
      absDriftMs: 120_000,
      exceeds: true,
      source: "https://www.google.com",
      thresholdMs: 60_000,
    });

    const log = makeLog();
    const monitor = createTimeDriftMonitor({ log });
    const exceeds = await monitor.checkOnce();

    expect(exceeds).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("time-drift:"));
  });

  it("logs error and returns false on fetch failure", async () => {
    vi.mocked(checkTimeDrift).mockRejectedValueOnce(new Error("network error"));

    const log = makeLog();
    const monitor = createTimeDriftMonitor({ log });
    const exceeds = await monitor.checkOnce();

    expect(exceeds).toBe(false);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("check failed"));
  });

  it("start/stop lifecycle with periodic checks", async () => {
    vi.mocked(checkTimeDrift).mockResolvedValue({
      driftMs: 0,
      absDriftMs: 0,
      exceeds: false,
      source: "https://www.google.com",
      thresholdMs: 60_000,
    });

    const log = makeLog();
    const monitor = createTimeDriftMonitor({ log, intervalMinutes: 1 });

    monitor.start();
    // Advance past one interval (1 minute).
    await vi.advanceTimersByTimeAsync(60_001);
    expect(checkTimeDrift).toHaveBeenCalled();

    const callCount = vi.mocked(checkTimeDrift).mock.calls.length;
    monitor.stop();
    // Advance again — should not fire after stop.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(vi.mocked(checkTimeDrift).mock.calls.length).toBe(callCount);
  });

  it("does not start periodic checks when intervalMinutes is 0", () => {
    const log = makeLog();
    const monitor = createTimeDriftMonitor({ log, intervalMinutes: 0 });
    monitor.start();
    // No error, just a no-op.
    monitor.stop();
  });
});
