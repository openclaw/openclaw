import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CronJob } from "./types.js";
import { createCronServiceState } from "./service/state.js";
import { armTimer } from "./service/timer.js";

const TIMER_ARMED_MSG = "cron: timer armed";

describe("CronService - timer armed log throttling", () => {
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  beforeEach(() => {
    log.debug.mockClear();
    log.info.mockClear();
    log.warn.mockClear();
    log.error.mockClear();
  });

  it("logs 'timer armed' at most once per second when armTimer is called repeatedly with same schedule", () => {
    const fixedNow = 1_000_000;
    const nextRunAtMs = fixedNow + 60_000;

    const job: CronJob = {
      id: "throttle-test",
      name: "throttle-test",
      enabled: true,
      deleteAfterRun: false,
      createdAtMs: fixedNow,
      updatedAtMs: fixedNow,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "test" },
      delivery: { mode: "none" },
      state: { nextRunAtMs },
    };

    const state = createCronServiceState({
      cronEnabled: true,
      storePath: "/tmp/test-cron/jobs.json",
      log,
      nowMs: () => fixedNow,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(),
    });
    state.store = { version: 1, jobs: [job] };

    // Simulate a burst of armTimer calls (e.g. from many cron.list/update RPCs).
    for (let i = 0; i < 20; i++) {
      armTimer(state);
    }

    const armedCalls = log.debug.mock.calls.filter(
      (call) => (call[1] as string) === TIMER_ARMED_MSG,
    );
    expect(armedCalls.length).toBeLessThanOrEqual(1);
    expect(state.timer).not.toBeNull();
  });
});
