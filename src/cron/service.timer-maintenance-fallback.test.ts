import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CronJob } from "./types.js";
import { createCronStoreHarness, createNoopLogger } from "./service.test-harness.js";
import { createCronServiceState } from "./service/state.js";
import { armTimer } from "./service/timer.js";

const noopLogger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness();

function createEnabledJobWithoutNextRun(params: { id: string; nowMs: number }): CronJob {
  return {
    id: params.id,
    name: params.id,
    enabled: true,
    deleteAfterRun: false,
    createdAtMs: params.nowMs,
    updatedAtMs: params.nowMs,
    schedule: { kind: "cron", expr: "0 3 * * *" },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "test" },
    delivery: { mode: "none" },
    // nextRunAtMs is intentionally undefined — simulates the transient state
    // where schedule computation failed or the store was reloaded with stale data.
    state: {},
  };
}

describe("CronService - armTimer maintenance fallback (#23628)", () => {
  beforeEach(() => {
    noopLogger.debug.mockClear();
    noopLogger.info.mockClear();
    noopLogger.warn.mockClear();
    noopLogger.error.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("arms a maintenance timer when enabled jobs exist but none have nextRunAtMs", async () => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const store = await makeStorePath();
    const now = Date.parse("2026-02-22T07:00:00.000Z");

    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: "ok" }),
    });
    state.store = {
      version: 1,
      jobs: [createEnabledJobWithoutNextRun({ id: "nightly-job", nowMs: now })],
    };

    armTimer(state);

    // The timer MUST be armed even though nextWakeAtMs returns undefined,
    // because there are enabled jobs that could recover their nextRunAtMs
    // on the next tick.
    expect(state.timer).not.toBeNull();

    const delays = timeoutSpy.mock.calls
      .map(([, delay]) => delay)
      .filter((d): d is number => typeof d === "number");
    // Should use MAX_TIMER_DELAY_MS (60_000) for the maintenance fallback.
    expect(delays).toContain(60_000);

    timeoutSpy.mockRestore();
    await store.cleanup();
  });

  it("does NOT arm a timer when there are no enabled jobs at all", async () => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const store = await makeStorePath();
    const now = Date.parse("2026-02-22T07:00:00.000Z");

    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: "ok" }),
    });
    state.store = {
      version: 1,
      jobs: [
        {
          ...createEnabledJobWithoutNextRun({ id: "disabled-job", nowMs: now }),
          enabled: false,
        },
      ],
    };

    armTimer(state);

    // No enabled jobs → no timer should be armed.
    expect(state.timer).toBeNull();

    timeoutSpy.mockRestore();
    await store.cleanup();
  });
});
