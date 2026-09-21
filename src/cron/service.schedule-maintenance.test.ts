import { describe, expect, it } from "vitest";
import { createMockCronStateForJobs } from "./service.test-harness.js";
import { recomputeNextRunsForMaintenance } from "./service/jobs-scheduling.js";
import type { CronJob } from "./types.js";

describe("cron schedule maintenance", () => {
  it("backfills missing every anchorMs for loaded jobs", () => {
    const now = Date.parse("2026-03-01T12:00:00.000Z");
    const createdAtMs = now - 120_000;
    const job: CronJob = {
      id: "loaded-every",
      name: "loaded-every",
      enabled: true,
      createdAtMs,
      updatedAtMs: createdAtMs,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "tick" },
      state: {},
    };
    const state = createMockCronStateForJobs({ jobs: [job], nowMs: now });

    expect(
      recomputeNextRunsForMaintenance(state, { recomputeExpired: true, deferredNotifications: [] }),
    ).toBe(true);
    expect(job.schedule.kind).toBe("every");
    if (job.schedule.kind === "every") {
      expect(job.schedule.anchorMs).toBe(createdAtMs);
    }
    expect(job.state.nextRunAtMs).toBe(now + 60_000);
  });

  it("keeps recovered recurring error retries behind run-end backoff", () => {
    const startedAt = Date.parse("2026-03-01T12:00:00.000Z");
    const durationMs = 90_000;
    const now = startedAt + 31_000;
    const job: CronJob = {
      id: "failed-every-long-run",
      name: "failed every long run",
      enabled: true,
      createdAtMs: startedAt - 60_000,
      updatedAtMs: startedAt,
      schedule: { kind: "every", everyMs: 1_000, anchorMs: startedAt - 60_000 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "tick" },
      state: {
        lastRunAtMs: startedAt,
        lastDurationMs: durationMs,
        lastStatus: "error",
        consecutiveErrors: 1,
      },
    };
    const state = createMockCronStateForJobs({ jobs: [job], nowMs: now });

    expect(
      recomputeNextRunsForMaintenance(state, { recomputeExpired: true, deferredNotifications: [] }),
    ).toBe(true);
    expect(job.state.nextRunAtMs).toBe(startedAt + durationMs + 30_000);
  });

  it("repairs future cron nextRunAtMs values that are not schedule slots", () => {
    const now = Date.parse("2026-05-05T12:00:00.000Z");
    const badFuture = Date.parse("2026-05-12T16:00:00.000Z");
    const expected = Date.parse("2026-05-05T13:00:00.000Z");
    const job: CronJob = {
      id: "daily-21-shanghai",
      name: "daily 21 shanghai",
      enabled: true,
      createdAtMs: Date.parse("2026-05-05T00:00:00.000Z"),
      updatedAtMs: Date.parse("2026-05-05T00:00:00.000Z"),
      schedule: { kind: "cron", expr: "0 0 21 * * *", tz: "Asia/Shanghai", staggerMs: 0 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "tick" },
      state: { nextRunAtMs: badFuture },
    };
    const state = createMockCronStateForJobs({ jobs: [job], nowMs: now });

    expect(recomputeNextRunsForMaintenance(state, { deferredNotifications: [] })).toBe(true);
    expect(job.state.nextRunAtMs).toBe(expected);
  });

  it("preserves valid future cron nextRunAtMs values during maintenance", () => {
    const now = Date.parse("2026-05-05T12:00:00.000Z");
    const validFuture = Date.parse("2026-05-05T13:00:00.000Z");
    const job: CronJob = {
      id: "daily-valid-future",
      name: "daily valid future",
      enabled: true,
      createdAtMs: Date.parse("2026-05-05T00:00:00.000Z"),
      updatedAtMs: Date.parse("2026-05-05T00:00:00.000Z"),
      schedule: { kind: "cron", expr: "0 0 21 * * *", tz: "Asia/Shanghai", staggerMs: 0 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "tick" },
      state: { nextRunAtMs: validFuture },
    };
    const state = createMockCronStateForJobs({ jobs: [job], nowMs: now });

    expect(recomputeNextRunsForMaintenance(state, { deferredNotifications: [] })).toBe(false);
    expect(job.state.nextRunAtMs).toBe(validFuture);
  });

  it("repairs future cron nextRunAtMs values that would fire before the next schedule slot", () => {
    const now = Date.parse("2026-05-05T12:00:00.000Z");
    const tooEarly = Date.parse("2026-05-05T12:30:00.000Z");
    const expected = Date.parse("2026-05-05T13:00:00.000Z");
    const job: CronJob = {
      id: "daily-too-early",
      name: "daily too early",
      enabled: true,
      createdAtMs: Date.parse("2026-05-05T00:00:00.000Z"),
      updatedAtMs: Date.parse("2026-05-05T00:00:00.000Z"),
      schedule: { kind: "cron", expr: "0 0 21 * * *", tz: "Asia/Shanghai", staggerMs: 0 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "tick" },
      state: { nextRunAtMs: tooEarly },
    };
    const state = createMockCronStateForJobs({ jobs: [job], nowMs: now });

    expect(recomputeNextRunsForMaintenance(state, { deferredNotifications: [] })).toBe(true);
    expect(job.state.nextRunAtMs).toBe(expected);
  });

  it("preserves deferred agent-turn cron nextRunAtMs values before the next natural slot", () => {
    const now = Date.parse("2026-05-05T12:00:00.000Z");
    const deferred = Date.parse("2026-05-05T12:02:00.000Z");
    const job: CronJob = {
      id: "daily-deferred-agent-turn",
      name: "daily deferred agent turn",
      enabled: true,
      createdAtMs: Date.parse("2026-05-05T00:00:00.000Z"),
      updatedAtMs: Date.parse("2026-05-05T00:00:00.000Z"),
      schedule: { kind: "cron", expr: "0 0 21 * * *", tz: "Asia/Shanghai", staggerMs: 0 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "tick" },
      state: { nextRunAtMs: deferred },
    };
    const state = createMockCronStateForJobs({ jobs: [job], nowMs: now });

    expect(recomputeNextRunsForMaintenance(state, { deferredNotifications: [] })).toBe(false);
    expect(job.state.nextRunAtMs).toBe(deferred);
  });

  it("preserves pending startup catch-up deferrals until the occurrence is consumed", () => {
    const now = Date.parse("2026-05-05T12:00:00.000Z");
    const deferred = Date.parse("2026-05-05T12:02:00.000Z");
    const job: CronJob = {
      id: "daily-pending-startup-deferral",
      name: "daily pending startup deferral",
      enabled: true,
      createdAtMs: Date.parse("2026-05-05T00:00:00.000Z"),
      updatedAtMs: Date.parse("2026-05-05T00:00:00.000Z"),
      schedule: { kind: "cron", expr: "0 0 21 * * *", tz: "Asia/Shanghai", staggerMs: 0 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "tick" },
      state: { nextRunAtMs: deferred, startupCatchupAtMs: deferred },
    };
    const state = createMockCronStateForJobs({ jobs: [job], nowMs: now });

    expect(recomputeNextRunsForMaintenance(state, { deferredNotifications: [] })).toBe(false);
    expect(job.state.nextRunAtMs).toBe(deferred);
    expect(job.state.startupCatchupAtMs).toBe(deferred);

    expect(
      recomputeNextRunsForMaintenance(state, {
        deferredNotifications: [],
        nowMs: deferred,
        repairFutureCronNextRunAtMs: true,
      }),
    ).toBe(false);
    expect(job.state.startupCatchupAtMs).toBe(deferred);
    expect(job.state.nextRunAtMs).toBe(deferred);
  });

  it("drops startup catch-up deferrals for disabled jobs", () => {
    const now = Date.parse("2026-05-05T12:00:00.000Z");
    const deferred = Date.parse("2026-05-05T12:02:00.000Z");
    const disabledJob: CronJob = {
      id: "disabled-pending-startup-deferral",
      name: "disabled pending startup deferral",
      enabled: false,
      createdAtMs: Date.parse("2026-05-05T00:00:00.000Z"),
      updatedAtMs: Date.parse("2026-05-05T00:00:00.000Z"),
      schedule: { kind: "cron", expr: "0 0 21 * * *", tz: "Asia/Shanghai", staggerMs: 0 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "tick" },
      state: { nextRunAtMs: deferred, startupCatchupAtMs: deferred },
    };
    const state = createMockCronStateForJobs({ jobs: [disabledJob], nowMs: now });

    expect(recomputeNextRunsForMaintenance(state, { deferredNotifications: [] })).toBe(true);
    expect(disabledJob.state.startupCatchupAtMs).toBeUndefined();
    expect(disabledJob.state.nextRunAtMs).toBeUndefined();
  });

  it("preserves cron retry backoff nextRunAtMs values during maintenance", () => {
    const now = Date.parse("2025-12-13T04:02:00.000Z");
    const retryAt = Date.parse("2025-12-13T04:10:00.000Z");
    const job: CronJob = {
      id: "backoff-pending",
      name: "backoff pending",
      enabled: true,
      createdAtMs: Date.parse("2025-12-10T12:00:00.000Z"),
      updatedAtMs: Date.parse("2025-12-13T04:01:10.000Z"),
      schedule: { kind: "cron", expr: "* * * * *", tz: "UTC" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "do not run during backoff" },
      state: {
        nextRunAtMs: retryAt,
        lastRunAtMs: Date.parse("2025-12-13T04:01:00.000Z"),
        lastStatus: "error",
        consecutiveErrors: 4,
      },
    };
    const state = createMockCronStateForJobs({ jobs: [job], nowMs: now });

    expect(recomputeNextRunsForMaintenance(state, { deferredNotifications: [] })).toBe(false);
    expect(job.state.nextRunAtMs).toBe(retryAt);
  });

  it("preserves cron retry backoff nextRunAtMs values from the run end time", () => {
    const now = Date.parse("2025-12-13T04:10:00.000Z");
    const retryAt = Date.parse("2025-12-13T04:20:30.000Z");
    const job: CronJob = {
      id: "backoff-from-ended-at",
      name: "backoff from ended at",
      enabled: true,
      createdAtMs: Date.parse("2025-12-10T12:00:00.000Z"),
      updatedAtMs: Date.parse("2025-12-13T04:05:30.000Z"),
      schedule: { kind: "cron", expr: "* * * * *", tz: "UTC" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "preserve run-end retry backoff" },
      state: {
        nextRunAtMs: retryAt,
        lastRunAtMs: Date.parse("2025-12-13T04:01:30.000Z"),
        lastDurationMs: 4 * 60_000,
        lastStatus: "error",
        consecutiveErrors: 4,
      },
    };
    const state = createMockCronStateForJobs({ jobs: [job], nowMs: now });

    expect(recomputeNextRunsForMaintenance(state, { deferredNotifications: [] })).toBe(false);
    expect(job.state.nextRunAtMs).toBe(retryAt);
  });

  it("repairs stale future cron nextRunAtMs values after error backoff has elapsed", () => {
    const now = Date.parse("2026-05-05T12:00:00.000Z");
    const badFuture = Date.parse("2026-05-12T16:00:00.000Z");
    const expected = Date.parse("2026-05-05T13:00:00.000Z");
    const job: CronJob = {
      id: "daily-expired-error",
      name: "daily expired error",
      enabled: true,
      createdAtMs: Date.parse("2026-05-05T00:00:00.000Z"),
      updatedAtMs: Date.parse("2026-05-05T00:00:00.000Z"),
      schedule: { kind: "cron", expr: "0 0 21 * * *", tz: "Asia/Shanghai", staggerMs: 0 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "tick" },
      state: {
        nextRunAtMs: badFuture,
        lastRunAtMs: Date.parse("2026-05-04T00:00:00.000Z"),
        lastStatus: "error",
        consecutiveErrors: 1,
      },
    };
    const state = createMockCronStateForJobs({ jobs: [job], nowMs: now });

    expect(recomputeNextRunsForMaintenance(state, { deferredNotifications: [] })).toBe(true);
    expect(job.state.nextRunAtMs).toBe(expected);
  });

  it("preserves exact-second cron slots that fall multiple intervals into the future (#81691)", () => {
    // Regression for the stale-future repair path. `isStaggeredCronRunAtMs`
    // used to probe the cron library at `runAtMs + 1` to classify whether the
    // persisted timestamp was a real scheduled slot. Croner-style second-
    // granular schedules normalize that 1ms probe back to the candidate's
    // second, so `previousRuns(1, probe)` returns the slot before the
    // candidate rather than the slot itself. The slot then looks "stale" and
    // future-slot repair rebases it, even though it is a perfectly valid
    // schedule slot two-or-more intervals out.
    //
    // The bug only surfaces when nextRun lands two-plus intervals past
    // `naturalNext`, because the closer cases are already saved by the
    // `nextRun === naturalNext` / `followingNaturalNext` guards in
    // shouldRepairFutureCronNextRunAtMs.
    const now = Date.parse("2026-05-05T12:00:00.000Z");
    // "0 9 * * *" Pacific/Honolulu (UTC-10) → 19:00 UTC daily.
    // Honolulu has no DST, so the UTC offset is stable across the window.
    const exactFutureSlot = Date.parse("2026-05-08T19:00:00.000Z");
    const job: CronJob = {
      id: "honolulu-9am-future-slot",
      name: "honolulu 9am future slot",
      enabled: true,
      createdAtMs: Date.parse("2026-05-01T00:00:00.000Z"),
      updatedAtMs: Date.parse("2026-05-01T00:00:00.000Z"),
      schedule: { kind: "cron", expr: "0 9 * * *", tz: "Pacific/Honolulu", staggerMs: 0 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "tick" },
      state: { nextRunAtMs: exactFutureSlot },
    };
    const state = createMockCronStateForJobs({ jobs: [job], nowMs: now });

    expect(recomputeNextRunsForMaintenance(state, { deferredNotifications: [] })).toBe(false);
    expect(job.state.nextRunAtMs).toBe(exactFutureSlot);
  });

  it("keeps future nextRunAtMs while probing malformed cron schedules", () => {
    const now = Date.parse("2026-05-05T12:00:00.000Z");
    const future = Date.parse("2026-05-12T16:00:00.000Z");
    const job: CronJob = {
      id: "malformed-future",
      name: "malformed future",
      enabled: true,
      createdAtMs: Date.parse("2026-05-05T00:00:00.000Z"),
      updatedAtMs: Date.parse("2026-05-05T00:00:00.000Z"),
      schedule: { kind: "cron", expr: "not a valid cron", tz: "UTC" },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "tick" },
      state: { nextRunAtMs: future },
    };
    const state = createMockCronStateForJobs({ jobs: [job], nowMs: now });

    recomputeNextRunsForMaintenance(state, { deferredNotifications: [] });
    expect(job.state.nextRunAtMs).toBe(future);
    expect(job.state.scheduleErrorCount).toBeUndefined();
  });
});
