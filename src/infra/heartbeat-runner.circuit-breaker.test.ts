import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { startHeartbeatRunner } from "./heartbeat-runner.js";

describe("heartbeat runner - circuit breaker", () => {
  // We extract the type directly from the first argument of startHeartbeatRunner
  type RunnerOptions = Parameters<typeof startHeartbeatRunner>[0];
  type RunOnceFn = RunnerOptions["runOnce"];

  function startDefaultRunner(runOnce: RunOnceFn) {
    return startHeartbeatRunner({
      cfg: {
        agents: { defaults: { heartbeat: { every: "30m" } } },
      } as OpenClawConfig,
      runOnce,
    });
  }

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("opens circuit after 5 consecutive failures and uses exponential backoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    // Mock runOnce to fail
    const runSpy = vi.fn().mockResolvedValue({ status: "failed", reason: "auth error" });

    const runner = startDefaultRunner(runSpy);

    // 1st failure
    await vi.advanceTimersByTimeAsync(30 * 60_000 + 100);
    expect(runSpy).toHaveBeenCalledTimes(1);

    // 2nd failure
    await vi.advanceTimersByTimeAsync(30 * 60_000 + 100);
    expect(runSpy).toHaveBeenCalledTimes(2);

    // 3rd failure
    await vi.advanceTimersByTimeAsync(30 * 60_000 + 100);
    expect(runSpy).toHaveBeenCalledTimes(3);

    // 4th failure
    await vi.advanceTimersByTimeAsync(30 * 60_000 + 100);
    expect(runSpy).toHaveBeenCalledTimes(4);

    // 5th failure - this should open the circuit
    await vi.advanceTimersByTimeAsync(30 * 60_000 + 100);
    expect(runSpy).toHaveBeenCalledTimes(5);

    // Now the circuit is open. Next run should be deferred.
    // Base interval is 30m.
    // failureTier = 5 - 5 + 1 = 1
    // multiplier = 2^1 = 2
    // backoff = 30m * 2 = 60m

    // Advance by 30m again - should NOT call runSpy
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(runSpy).toHaveBeenCalledTimes(5);

    // Advance by another 30m (total 60m since last failure) - should call runSpy again
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(runSpy).toHaveBeenCalledTimes(6);

    runner.stop();
  });

  it("resets circuit after a successful run", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    let fail = true;
    const runSpy = vi.fn().mockImplementation(async () => {
      if (fail) {
        return { status: "failed", reason: "error" };
      }
      return { status: "ran", durationMs: 1 };
    });

    const runner = startDefaultRunner(runSpy);

    // Fail 5 times to open circuit
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(30 * 60_000 + 1000);
    }
    expect(runSpy).toHaveBeenCalledTimes(5);

    // Wait for circuit reset period (5 mins) or backoff (60 mins)
    // Actually our resolveNextDue uses backoff which is 60m
    await vi.advanceTimersByTimeAsync(60 * 60_000 + 1000);
    expect(runSpy).toHaveBeenCalledTimes(6);

    // Make next run succeed
    fail = false;
    await vi.advanceTimersByTimeAsync(120 * 60_000 + 1000); // Wait for tier 2 backoff (30m * 4 = 120m)
    expect(runSpy).toHaveBeenCalledTimes(7);

    // Now it succeeded, consecutiveFailures should be 0.
    // Next run should be back to normal 30m interval.
    await vi.advanceTimersByTimeAsync(30 * 60_000 + 1000);
    expect(runSpy).toHaveBeenCalledTimes(8);

    runner.stop();
  });
});
