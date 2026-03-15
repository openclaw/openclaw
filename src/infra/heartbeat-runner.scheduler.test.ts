import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { startHeartbeatRunner } from "./heartbeat-runner.js";
import { requestHeartbeatNow, resetHeartbeatWakeStateForTests } from "./heartbeat-wake.js";

describe("startHeartbeatRunner", () => {
  type RunOnce = Parameters<typeof startHeartbeatRunner>[0]["runOnce"];

  function useFakeHeartbeatTime() {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
  }

  function startDefaultRunner(runOnce: RunOnce) {
    return startHeartbeatRunner({
      cfg: heartbeatConfig(),
      runOnce,
    });
  }

  function heartbeatConfig(
    list?: NonNullable<NonNullable<OpenClawConfig["agents"]>["list"]>,
  ): OpenClawConfig {
    return {
      agents: {
        defaults: { heartbeat: { every: "30m" } },
        ...(list ? { list } : {}),
      },
    } as OpenClawConfig;
  }

  function createRequestsInFlightRunSpy(skipCount: number) {
    let callCount = 0;
    return vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount <= skipCount) {
        return { status: "skipped", reason: "requests-in-flight" } as const;
      }
      return { status: "ran", durationMs: 1 } as const;
    });
  }

  async function expectWakeDispatch(params: {
    cfg: OpenClawConfig;
    runSpy: RunOnce;
    wake: { reason: string; agentId?: string; sessionKey?: string; coalesceMs: number };
    expectedCall: Record<string, unknown>;
  }) {
    const runner = startHeartbeatRunner({
      cfg: params.cfg,
      runOnce: params.runSpy,
    });

    requestHeartbeatNow(params.wake);
    await vi.advanceTimersByTimeAsync(1);

    expect(params.runSpy).toHaveBeenCalledTimes(1);
    expect(params.runSpy).toHaveBeenCalledWith(expect.objectContaining(params.expectedCall));

    return runner;
  }

  afterEach(() => {
    resetHeartbeatWakeStateForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("updates scheduling when config changes without restart", async () => {
    useFakeHeartbeatTime();

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
    useFakeHeartbeatTime();

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
    useFakeHeartbeatTime();

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
    useFakeHeartbeatTime();

    const runSpy = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });

    const runner = startDefaultRunner(runSpy);

    runner.stop();

    // After stopping, no heartbeats should fire
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(runSpy).not.toHaveBeenCalled();
  });

  it("reschedules timer when runOnce returns requests-in-flight", async () => {
    useFakeHeartbeatTime();

    const runSpy = createRequestsInFlightRunSpy(1);

    const runner = startHeartbeatRunner({
      cfg: heartbeatConfig(),
      runOnce: runSpy,
    });

    // First heartbeat returns requests-in-flight
    await vi.advanceTimersByTimeAsync(30 * 60_000 + 1_000);
    expect(runSpy).toHaveBeenCalledTimes(1);

    // The wake layer retries after DEFAULT_RETRY_MS (1 s).  No scheduleNext()
    // is called inside runOnce, so we must wait for the full cooldown.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runSpy).toHaveBeenCalledTimes(2);

    runner.stop();
  });

  it("does not push nextDueMs forward on repeated requests-in-flight skips", async () => {
    useFakeHeartbeatTime();

    // Simulate a long-running heartbeat: the first 5 calls return
    // requests-in-flight (retries from the wake layer), then the 6th succeeds.
    const runSpy = createRequestsInFlightRunSpy(5);

    const runner = startHeartbeatRunner({
      cfg: heartbeatConfig(),
      runOnce: runSpy,
    });

    // Trigger the first heartbeat at t=30m — returns requests-in-flight.
    await vi.advanceTimersByTimeAsync(30 * 60_000 + 1_000);
    expect(runSpy).toHaveBeenCalledTimes(1);

    // Simulate 4 more retries at short intervals (wake layer retries).
    for (let i = 0; i < 4; i++) {
      requestHeartbeatNow({ reason: "retry", coalesceMs: 0 });
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(runSpy).toHaveBeenCalledTimes(5);

    // The next interval tick at ~t=60m should still fire — the schedule
    // must not have been pushed to t=30m * 6 = 180m by the 5 retries.
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(runSpy).toHaveBeenCalledTimes(6);

    runner.stop();
  });

  it("routes targeted wake requests to the requested agent/session", async () => {
    useFakeHeartbeatTime();
    const runSpy = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    const runner = await expectWakeDispatch({
      cfg: {
        ...heartbeatConfig([
          { id: "main", heartbeat: { every: "30m" } },
          { id: "ops", heartbeat: { every: "15m" } },
        ]),
      } as OpenClawConfig,
      runSpy,
      wake: {
        reason: "cron:job-123",
        agentId: "ops",
        sessionKey: "agent:ops:discord:channel:alerts",
        coalesceMs: 0,
      },
      expectedCall: {
        agentId: "ops",
        reason: "cron:job-123",
        sessionKey: "agent:ops:discord:channel:alerts",
      },
    });

    runner.stop();
  });

  it("does not fan out to unrelated agents for session-scoped exec wakes", async () => {
    useFakeHeartbeatTime();
    const runSpy = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    const runner = await expectWakeDispatch({
      cfg: {
        ...heartbeatConfig([
          { id: "main", heartbeat: { every: "30m" } },
          { id: "finance", heartbeat: { every: "30m" } },
        ]),
      } as OpenClawConfig,
      runSpy,
      wake: {
        reason: "exec-event",
        sessionKey: "agent:main:main",
        coalesceMs: 0,
      },
      expectedCall: {
        agentId: "main",
        reason: "exec-event",
        sessionKey: "agent:main:main",
      },
    });
    expect(runSpy.mock.calls.some((call) => call[0]?.agentId === "finance")).toBe(false);

    runner.stop();
  });

  it('allows event-driven heartbeats with exec:* prefix through when requests-in-flight', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const runSpy = vi.fn().mockResolvedValue({ status: 'ran', durationMs: 1 });

    const runner = startHeartbeatRunner({
      cfg: {
        agents: { defaults: { heartbeat: { every: '30m' } } },
      } as OpenClawConfig,
      runOnce: runSpy,
    });

    // exec:* prefix patterns should be classified as exec-event and allowed
    // through even when the command lane has requests in flight
    requestHeartbeatNow({ reason: 'exec:abc123:exit', coalesceMs: 0 });
    await vi.advanceTimersByTimeAsync(1);

    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'exec:abc123:exit' }),
    );

    runner.stop();
  });

});
