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

  it("clamps large intervals to MAX_TIMEOUT_MS to avoid setTimeout overflow (#8123)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const runSpy = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });

    // 720 hours = 2,592,000,000 ms, which exceeds 32-bit signed int max (2,147,483,647)
    // Without the fix, this would overflow and setTimeout would fire immediately
    const runner = startHeartbeatRunner({
      cfg: {
        agents: { defaults: { heartbeat: { every: "720h" } } },
      } as OpenClawConfig,
      runOnce: runSpy,
    });

    // Advance by 1 hour - heartbeat should NOT have run yet
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(runSpy).toHaveBeenCalledTimes(0);

    // Advance by another 23 hours (total 24h) - still shouldn't run
    await vi.advanceTimersByTimeAsync(23 * 60 * 60_000);
    expect(runSpy).toHaveBeenCalledTimes(0);

    // Advance to just before MAX_TIMEOUT_MS (which is the clamped value)
    // MAX_TIMEOUT_MS is ~24.8 days, so after ~24 days we should still not have run
    await vi.advanceTimersByTimeAsync(23 * 24 * 60 * 60_000); // 23 more days
    expect(runSpy).toHaveBeenCalledTimes(0);

    // Advance past MAX_TIMEOUT_MS - now it should run
    await vi.advanceTimersByTimeAsync(2 * 24 * 60 * 60_000); // 2 more days (total ~25 days)
    expect(runSpy).toHaveBeenCalledTimes(1);

    runner.stop();
  });

  it("exports MAX_TIMEOUT_MS constant for validation", () => {
    // Verify the constant is the 32-bit signed integer max
    expect(MAX_TIMEOUT_MS).toBe(2_147_483_647);
  });
});
