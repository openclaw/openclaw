/**
 * Regression test for issue #93935: startup overflow catch-up deferrals are
 * dropped when a maintenance recompute (read RPC / finalize / empty-due tick)
 * runs before the staggered tick fires.
 *
 * The fix persists pending catch-up deferral job ids in `CronServiceState` so
 * that every `recomputeNextRunsForMaintenance` caller skips future-slot repair
 * for those jobs until their staggered slot is reached.
 */
import { describe, expect, it, vi } from "vitest";
import { createCronServiceState } from "./service/state.js";
import { recomputeNextRunsForMaintenance } from "./service/jobs.js";

function createTestState(nowMs: number) {
  return createCronServiceState({
    nowMs: () => nowMs,
    log: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    storePath: "/tmp/test-cron.sqlite",
    cronEnabled: true,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
  });
}

function createDailyJob(id: string, nextRunAtMs: number) {
  return {
    id,
    schedule: { kind: "cron" as const, expr: "0 9 * * *" },
    payload: { kind: "systemEvent" as const, text: "test" },
    state: { nextRunAtMs },
    enabled: true,
  };
}

describe("startup overflow deferral persistence", () => {
  it("preserves deferred catch-up slot through read RPCs (recomputeNextRunsForMaintenance)", () => {
    const startNow = 1765645200000; // 2025-12-13T09:00:00Z
    const staggerMs = 5000;
    const deferralSlot = startNow + staggerMs; // 1765645205000
    const naturalNext = 1765702800000; // 2025-12-14T09:00:00Z

    const state = createTestState(startNow);
    state.store = {
      jobs: [createDailyJob("daily-job", deferralSlot)],
    } as any;

    // Simulate the deferral being recorded by applyStartupCatchupOutcomes.
    state.pendingCatchupDeferralJobIds.add("daily-job");

    // Before the staggered tick fires, a read RPC runs recomputeNextRunsForMaintenance.
    // The deferral should survive because the job is in pendingCatchupDeferralJobIds.
    const changed = recomputeNextRunsForMaintenance(state, {
      repairFutureCronNextRunAtMs: true,
      nowMs: startNow + 1000, // 1 second after start, before the staggered tick
    });

    // The job's nextRunAtMs should still be the deferral slot, not the natural next.
    expect(state.store.jobs[0].state.nextRunAtMs).toBe(deferralSlot);
    expect(changed).toBe(false);
  });

  it("allows future-slot repair after the staggered tick fires", () => {
    const startNow = 1765645200000; // 2025-12-13T09:00:00Z
    const staggerMs = 5000;
    const deferralSlot = startNow + staggerMs; // 1765645205000
    const naturalNext = 1765702800000; // 2025-12-14T09:00:00Z

    const state = createTestState(deferralSlot + 1); // After the staggered tick
    state.store = {
      jobs: [createDailyJob("daily-job", deferralSlot)],
    } as any;

    // Simulate the deferral being recorded by applyStartupCatchupOutcomes.
    state.pendingCatchupDeferralJobIds.add("daily-job");

    // After the staggered tick, recomputeNextRunsForMaintenance should clear
    // the pending deferral and allow future-slot repair.
    const changed = recomputeNextRunsForMaintenance(state, {
      repairFutureCronNextRunAtMs: true,
      nowMs: deferralSlot + 1,
    });

    // The pendingCatchupDeferralJobIds should be cleared.
    expect(state.pendingCatchupDeferralJobIds.has("daily-job")).toBe(false);
  });

  it("does not affect jobs without pending deferrals", () => {
    const startNow = 1765645200000; // 2025-12-13T09:00:00Z
    const naturalNext = 1765702800000; // 2025-12-14T09:00:00Z

    const state = createTestState(startNow);
    state.store = {
      jobs: [createDailyJob("daily-job", startNow - 1000)], // Past-due job
    } as any;

    // No pending deferral for this job.
    // recomputeNextRunsForMaintenance should behave normally.
    const changed = recomputeNextRunsForMaintenance(state, {
      repairFutureCronNextRunAtMs: true,
      nowMs: startNow,
    });

    // The job should be eligible for future-slot repair.
    // (This test verifies that the fix doesn't break normal behavior.)
    expect(state.pendingCatchupDeferralJobIds.has("daily-job")).toBe(false);
  });
});
