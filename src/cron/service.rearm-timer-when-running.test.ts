import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CronJob } from "./types.js";
import { createCronStoreHarness, createNoopLogger } from "./service.test-harness.js";
import { createCronServiceState } from "./service/state.js";
import { onTimer } from "./service/timer.js";

const noopLogger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness();

function createDueRecurringJob(params: {
  id: string;
  nowMs: number;
  nextRunAtMs: number;
}): CronJob {
  return {
    id: params.id,
    name: params.id,
    enabled: true,
    deleteAfterRun: false,
    createdAtMs: params.nowMs,
    updatedAtMs: params.nowMs,
    schedule: { kind: "every", everyMs: 5 * 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "test" },
    delivery: { mode: "none" },
    state: { nextRunAtMs: params.nextRunAtMs },
  };
}

describe("CronService - timer re-arm when running (#12025)", () => {
  beforeEach(() => {
    noopLogger.debug.mockClear();
    noopLogger.info.mockClear();
    noopLogger.warn.mockClear();
    noopLogger.error.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("re-arms the timer when onTimer is called while state.running is true", async () => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const store = await makeStorePath();
    const now = Date.parse("2026-02-06T10:05:00.000Z");

    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: "ok", summary: "ok" }),
    });

    // Simulate a job that is currently running.
    state.running = true;
    state.store = {
      version: 1,
      jobs: [
        createDueRecurringJob({
          id: "recurring-job",
          nowMs: now,
          nextRunAtMs: now + 5 * 60_000,
        }),
      ],
    };

    // Before the fix in #12025, this would return without re-arming,
    // silently killing the scheduler.
    await onTimer(state);

    // The timer must be re-armed so the scheduler continues ticking,
    // with a fixed 60s delay to avoid hot-looping.
    expect(state.timer).not.toBeNull();
    expect(timeoutSpy).toHaveBeenCalled();
    const delays = timeoutSpy.mock.calls
      .map(([, delay]) => delay)
      .filter((d): d is number => typeof d === "number");
    expect(delays).toContain(60_000);

    // state.running should still be true (onTimer bailed out, didn't
    // touch it — the original caller's finally block handles that).
    expect(state.running).toBe(true);

    timeoutSpy.mockRestore();
    await store.cleanup();
  });
});
