import { describe, expect, it, vi } from "vitest";
import {
  createCronStoreHarness,
  createNoopLogger,
  createRunningCronServiceState,
  createStartedCronServiceWithFinishedBarrier,
  installCronTestHooks,
} from "./service.test-harness.js";
import { armTimer } from "./service/timer.js";
import type { CronJob } from "./types.js";

const noopLogger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness({ prefix: "openclaw-cron-race-" });
installCronTestHooks({
  logger: noopLogger,
  baseTimeIso: "2026-02-16T12:00:00.000Z",
});

function createRecurringJob(params: { id: string; nowMs: number; nextRunAtMs: number }): CronJob {
  return {
    id: params.id,
    name: params.id,
    enabled: true,
    deleteAfterRun: false,
    createdAtMs: params.nowMs,
    updatedAtMs: params.nowMs,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "beat" },
    delivery: { mode: "none" },
    state: { nextRunAtMs: params.nextRunAtMs },
  };
}

describe("CronService - rapid create/delete race (#18121)", () => {
  it("armTimer is a no-op when state.running is true, preserving the watchdog", async () => {
    const store = await makeStorePath();
    const now = Date.parse("2026-02-16T12:00:00.000Z");

    const state = createRunningCronServiceState({
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      jobs: [createRecurringJob({ id: "job-1", nowMs: now, nextRunAtMs: now + 60_000 })],
    });

    // state.running is already true via createRunningCronServiceState.
    // Set a sentinel timer to simulate the watchdog armed by armRunningRecheckTimer.
    const sentinelTimer = setTimeout(() => {}, 999_999);
    state.timer = sentinelTimer;

    // Call armTimer — it should skip entirely because state.running is true.
    armTimer(state);

    // The timer must NOT have been replaced.
    expect(state.timer).toBe(sentinelTimer);

    // Verify the debug log was emitted.
    expect(noopLogger.debug).toHaveBeenCalledWith({}, "cron: armTimer skipped - tick in progress");

    clearTimeout(sentinelTimer);
    await store.cleanup();
  });

  it("armTimer does not clear the watchdog even when all jobs are temporarily deleted", async () => {
    const store = await makeStorePath();
    const now = Date.parse("2026-02-16T12:00:00.000Z");

    const state = createRunningCronServiceState({
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      jobs: [], // empty — simulates all jobs deleted mid-tick
    });

    const watchdog = setTimeout(() => {}, 999_999);
    state.timer = watchdog;

    armTimer(state);

    // Watchdog must survive even though there are zero jobs.
    expect(state.timer).toBe(watchdog);

    clearTimeout(watchdog);
    await store.cleanup();
  });

  it("scheduler recovers and fires jobs after bulk delete-then-create cycle", async () => {
    const store = await makeStorePath();
    const { cron, enqueueSystemEvent, finished } = createStartedCronServiceWithFinishedBarrier({
      storePath: store.storePath,
      logger: noopLogger,
    });

    await cron.start();

    // Create 6 jobs (simulating ensure-crons with 6 agents).
    const jobIds: string[] = [];
    for (let i = 0; i < 6; i++) {
      const job = await cron.add({
        name: `agent-${i}`,
        enabled: true,
        schedule: { kind: "every", everyMs: 10_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: `heartbeat-${i}` },
      });
      jobIds.push(job.id);
    }

    // Fire all jobs once.
    const firstJob = (await cron.list())[0];
    const firstDueAt = firstJob.state.nextRunAtMs!;
    vi.setSystemTime(new Date(firstDueAt + 5));
    await vi.runOnlyPendingTimersAsync();
    await finished.waitForOk(firstJob.id);

    expect(enqueueSystemEvent.mock.calls.length).toBeGreaterThanOrEqual(1);

    // Rapid bulk delete of all jobs.
    for (const id of jobIds) {
      await cron.remove(id);
    }

    // Zero jobs momentarily.
    const midStatus = await cron.status();
    expect(midStatus.jobs).toBe(0);

    // Re-create all jobs.
    for (let i = 0; i < 6; i++) {
      await cron.add({
        name: `agent-v2-${i}`,
        enabled: true,
        schedule: { kind: "every", everyMs: 10_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: `heartbeat-v2-${i}` },
      });
    }

    // Advance time past the next scheduled run and fire.
    enqueueSystemEvent.mockClear();
    const newJob = (await cron.list())[0];
    const nextDueAt = newJob.state.nextRunAtMs!;
    vi.setSystemTime(new Date(nextDueAt + 5));
    await vi.runOnlyPendingTimersAsync();
    await finished.waitForOk(newJob.id);

    // The re-created jobs must fire — scheduler must not be frozen.
    expect(enqueueSystemEvent.mock.calls.length).toBeGreaterThanOrEqual(1);

    const finalStatus = await cron.status();
    expect(finalStatus.enabled).toBe(true);
    expect(finalStatus.nextWakeAtMs).not.toBeNull();

    cron.stop();
    await store.cleanup();
  });
});
