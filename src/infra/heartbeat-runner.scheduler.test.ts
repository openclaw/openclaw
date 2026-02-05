import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { MAX_TIMEOUT_MS, startHeartbeatRunner } from "./heartbeat-runner.js";

describe("startHeartbeatRunner", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("updates scheduling when config changes without restart", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const runSpy = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });

    const runner = startHeartbeatRunner({
      cfg: {
        agents: { defaults: { heartbeat: { every: "30m" } } },
      } as OpenClawConfig,
      runOnce: runSpy,
    });

    await vi.advanceTimersByTimeAsync(30 * 60_000 + 1_000);

    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ agentId: "main", reason: "interval" }),
    );

    runner.updateConfig({
      agents: {
        defaults: { heartbeat: { every: "30m" } },
        list: [
          { id: "main", heartbeat: { every: "10m" } },
          { id: "ops", heartbeat: { every: "15m" } },
        ],
      },
    } as OpenClawConfig);

    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1_000);

    expect(runSpy).toHaveBeenCalledTimes(2);
    expect(runSpy.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ agentId: "main", heartbeat: { every: "10m" } }),
    );

    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1_000);

    expect(runSpy).toHaveBeenCalledTimes(3);
    expect(runSpy.mock.calls[2]?.[0]).toEqual(
      expect.objectContaining({ agentId: "ops", heartbeat: { every: "15m" } }),
    );

    runner.stop();
  });

  it("chains timeouts for large intervals to preserve configured cadence (#8123)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const runSpy = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });

    // 720 hours = 30 days = 2,592,000,000 ms
    // This exceeds MAX_TIMEOUT_MS (2,147,483,647 ms = ~24.8 days)
    // Without the fix, setTimeout would overflow to 1ms and fire immediately.
    // With the fix, timeouts are chained: first fires at ~24.8 days (skipped because
    // not yet due), second fires at remaining ~5.2 days (total 30 days, runs).
    const intervalMs = 720 * 60 * 60_000; // 720h in ms
    const runner = startHeartbeatRunner({
      cfg: {
        agents: { defaults: { heartbeat: { every: "720h" } } },
      } as OpenClawConfig,
      runOnce: runSpy,
    });

    // Advance by 1 hour - heartbeat should NOT have run yet
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(runSpy).toHaveBeenCalledTimes(0);

    // Advance to 25 days (past MAX_TIMEOUT_MS but before 720h interval)
    // The first chained timeout fires at ~24.8 days, but heartbeat is skipped
    // because nextDueMs (30 days) > now (25 days)
    await vi.advanceTimersByTimeAsync(24 * 24 * 60 * 60_000); // 24 more days (total ~25 days)
    expect(runSpy).toHaveBeenCalledTimes(0);

    // Advance to just before the full 720h interval
    await vi.advanceTimersByTimeAsync(4 * 24 * 60 * 60_000); // 4 more days (total ~29 days)
    expect(runSpy).toHaveBeenCalledTimes(0);

    // Advance past the full 720h interval - now it should run
    await vi.advanceTimersByTimeAsync(2 * 24 * 60 * 60_000); // 2 more days (total ~31 days)
    expect(runSpy).toHaveBeenCalledTimes(1);

    runner.stop();
  });

  it("exports MAX_TIMEOUT_MS constant for validation", () => {
    // Verify the constant is the 32-bit signed integer max
    expect(MAX_TIMEOUT_MS).toBe(2_147_483_647);
  });
});
