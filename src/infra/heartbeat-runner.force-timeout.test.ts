import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  setHeartbeatsEnabled,
  startHeartbeatRunner,
} from "./heartbeat-runner.js";
import { resetHeartbeatWakeStateForTests } from "./heartbeat-wake.js";

const HEARTBEAT_INTERVAL_MS = 30 * 60_000;
const HEARTBEAT_FORCE_TIMEOUT_MS = 5 * 60_000;
const FORCE_TIMEOUT_BUFFER_MS = 61_000;
const PRE_TIMEOUT_MS = HEARTBEAT_FORCE_TIMEOUT_MS - FORCE_TIMEOUT_BUFFER_MS;
const RETRY_MS = 1_000;

describe("startHeartbeatRunner force timeout", () => {
  type RunOnce = Parameters<typeof startHeartbeatRunner>[0]["runOnce"];

  function useFakeHeartbeatTime() {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
  }

  function heartbeatConfig(): OpenClawConfig {
    return {
      agents: {
        defaults: { heartbeat: { every: "30m" } },
      },
    } as OpenClawConfig;
  }

  async function advanceToFirstInterval() {
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS + RETRY_MS);
  }

  async function advanceRetries(ms: number) {
    for (let elapsed = 0; elapsed < ms; elapsed += RETRY_MS) {
      await vi.advanceTimersByTimeAsync(RETRY_MS);
    }
  }

  function forcedCalls(runSpy: Mock<NonNullable<RunOnce>>) {
    return runSpy.mock.calls.filter(([opts]) => opts?.forceBypassQueue === true);
  }

  afterEach(() => {
    setHeartbeatsEnabled(true);
    resetHeartbeatWakeStateForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("re-invokes runOnce with forceBypassQueue after 5 minutes of queue contention", async () => {
    useFakeHeartbeatTime();

    const runSpy = vi.fn().mockImplementation(async (opts?: { forceBypassQueue?: boolean }) => {
      if (opts?.forceBypassQueue) {
        return { status: "ran", durationMs: 1 } as const;
      }
      return { status: "skipped", reason: "requests-in-flight" } as const;
    });

    const runner = startHeartbeatRunner({
      cfg: heartbeatConfig(),
      runOnce: runSpy,
    });

    await advanceToFirstInterval();
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(forcedCalls(runSpy)).toHaveLength(0);

    await advanceRetries(PRE_TIMEOUT_MS);
    expect(forcedCalls(runSpy)).toHaveLength(0);

    await advanceRetries(FORCE_TIMEOUT_BUFFER_MS);
    expect(forcedCalls(runSpy)).toHaveLength(1);
    expect(forcedCalls(runSpy)[0]?.[0]).toEqual(
      expect.objectContaining({
        agentId: "main",
        forceBypassQueue: true,
        reason: "interval",
      }),
    );

    runner.stop();
  });

  it("resets forced-timeout tracking after a successful forced execution", async () => {
    useFakeHeartbeatTime();

    const runSpy = vi.fn().mockImplementation(async (opts?: { forceBypassQueue?: boolean }) => {
      if (opts?.forceBypassQueue) {
        return { status: "ran", durationMs: 1 } as const;
      }
      return { status: "skipped", reason: "requests-in-flight" } as const;
    });

    const runner = startHeartbeatRunner({
      cfg: heartbeatConfig(),
      runOnce: runSpy,
    });

    await advanceToFirstInterval();
    await advanceRetries(HEARTBEAT_FORCE_TIMEOUT_MS + RETRY_MS);
    expect(forcedCalls(runSpy)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS + RETRY_MS);
    expect(forcedCalls(runSpy)).toHaveLength(1);

    await advanceRetries(PRE_TIMEOUT_MS);
    expect(forcedCalls(runSpy)).toHaveLength(1);

    await advanceRetries(FORCE_TIMEOUT_BUFFER_MS);
    expect(forcedCalls(runSpy)).toHaveLength(2);

    runner.stop();
  });

  it("resets forced-timeout tracking after a normal non-skip execution", async () => {
    useFakeHeartbeatTime();

    let nonForcedCalls = 0;
    const runSpy = vi.fn().mockImplementation(async (opts?: { forceBypassQueue?: boolean }) => {
      if (opts?.forceBypassQueue) {
        return { status: "ran", durationMs: 1 } as const;
      }
      nonForcedCalls += 1;
      if (nonForcedCalls <= 3) {
        return { status: "skipped", reason: "requests-in-flight" } as const;
      }
      if (nonForcedCalls === 4) {
        return { status: "ran", durationMs: 1 } as const;
      }
      return { status: "skipped", reason: "requests-in-flight" } as const;
    });

    const runner = startHeartbeatRunner({
      cfg: heartbeatConfig(),
      runOnce: runSpy,
    });

    await advanceToFirstInterval();
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(forcedCalls(runSpy)).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS + RETRY_MS);
    expect(forcedCalls(runSpy)).toHaveLength(0);

    await advanceRetries(PRE_TIMEOUT_MS);
    expect(forcedCalls(runSpy)).toHaveLength(0);

    await advanceRetries(FORCE_TIMEOUT_BUFFER_MS);
    expect(forcedCalls(runSpy)).toHaveLength(1);

    runner.stop();
  });
});
