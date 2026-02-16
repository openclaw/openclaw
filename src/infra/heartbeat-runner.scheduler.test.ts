import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { startHeartbeatRunner } from "./heartbeat-runner.js";

describe("startHeartbeatRunner", () => {
  function startDefaultRunner(runOnce: (typeof startHeartbeatRunner)[0]["runOnce"]) {
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

  it("updates scheduling when config changes without restart", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const runSpy = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });

    const runner = startDefaultRunner(runSpy);

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

  it("continues scheduling after runOnce throws an unhandled error", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    let callCount = 0;
    const runSpy = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // First call throws (simulates crash during session compaction)
        throw new Error("session compaction error");
      }
      return { status: "ran", durationMs: 1 };
    });

    const runner = startDefaultRunner(runSpy);

    // First heartbeat fires and throws
    await vi.advanceTimersByTimeAsync(30 * 60_000 + 1_000);
    expect(runSpy).toHaveBeenCalledTimes(1);

    // Second heartbeat should still fire (scheduler must not be dead)
    await vi.advanceTimersByTimeAsync(30 * 60_000 + 1_000);
    expect(runSpy).toHaveBeenCalledTimes(2);

    runner.stop();
  });

  it("cleanup is idempotent and does not clear a newer runner's handler", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const runSpy1 = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    const runSpy2 = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });

    const cfg = {
      agents: { defaults: { heartbeat: { every: "30m" } } },
    } as OpenClawConfig;

    // Start runner A
    const runnerA = startHeartbeatRunner({ cfg, runOnce: runSpy1 });

    // Start runner B (simulates lifecycle reload)
    const runnerB = startHeartbeatRunner({ cfg, runOnce: runSpy2 });

    // Stop runner A (stale cleanup) — should NOT kill runner B's handler
    runnerA.stop();

    // Runner B should still fire
    await vi.advanceTimersByTimeAsync(30 * 60_000 + 1_000);
    expect(runSpy2).toHaveBeenCalledTimes(1);
    expect(runSpy1).not.toHaveBeenCalled();

    // Double-stop should be safe (idempotent)
    runnerA.stop();

    runnerB.stop();
  });

  it("run() returns skipped when runner is stopped", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const runSpy = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });

    const runner = startDefaultRunner(runSpy);

    runner.stop();

    // After stopping, no heartbeats should fire
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(runSpy).not.toHaveBeenCalled();
  });

  it("reschedules timer when runOnce returns requests-in-flight", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    let callCount = 0;
    const runSpy = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return { status: "skipped", reason: "requests-in-flight" };
      }
      return { status: "ran", durationMs: 1 };
    });

    const runner = startHeartbeatRunner({
      cfg: {
        agents: { defaults: { heartbeat: { every: "30m" } } },
      } as OpenClawConfig,
      runOnce: runSpy,
    });

    // First heartbeat returns requests-in-flight
    await vi.advanceTimersByTimeAsync(30 * 60_000 + 1_000);
    expect(runSpy).toHaveBeenCalledTimes(1);

    // Timer should be rescheduled; next heartbeat should still fire
    await vi.advanceTimersByTimeAsync(30 * 60_000 + 1_000);
    expect(runSpy).toHaveBeenCalledTimes(2);

    runner.stop();
  });
});
