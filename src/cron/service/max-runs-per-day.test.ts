import { describe, expect, it } from "vitest";
import type { CronJob } from "../types.js";
import { isJobAtDailyLimit, isJobDue } from "./jobs.js";
import { applyJobResult } from "./timer.js";

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "test-job",
    name: "test",
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "test" },
    state: {},
    ...overrides,
  };
}

describe("isJobAtDailyLimit", () => {
  it("returns false when maxRunsPerDay is not set", () => {
    const job = makeJob();
    expect(isJobAtDailyLimit(job, Date.now())).toBe(false);
  });

  it("returns false when runsToday is below limit", () => {
    const job = makeJob({
      maxRunsPerDay: 3,
      state: { runsToday: 2, runsTodayDate: new Date().toISOString().slice(0, 10) },
    });
    // Use UTC midnight of today to match the date
    const now = Date.now();
    const today = new Date(now).toISOString().slice(0, 10);
    job.state.runsTodayDate = today;
    expect(isJobAtDailyLimit(job, now)).toBe(false);
  });

  it("returns true when runsToday equals limit", () => {
    const now = Date.now();
    const today = new Date(now).toISOString().slice(0, 10);
    const job = makeJob({
      maxRunsPerDay: 1,
      state: { runsToday: 1, runsTodayDate: today },
    });
    expect(isJobAtDailyLimit(job, now)).toBe(true);
  });

  it("returns true when runsToday exceeds limit", () => {
    const now = Date.now();
    const today = new Date(now).toISOString().slice(0, 10);
    const job = makeJob({
      maxRunsPerDay: 2,
      state: { runsToday: 5, runsTodayDate: today },
    });
    expect(isJobAtDailyLimit(job, now)).toBe(true);
  });

  it("resets counter when date changes (new day)", () => {
    const job = makeJob({
      maxRunsPerDay: 1,
      state: { runsToday: 5, runsTodayDate: "2026-01-01" },
    });
    // Any date that's not 2026-01-01 should reset
    const now = new Date("2026-03-03T12:00:00Z").getTime();
    expect(isJobAtDailyLimit(job, now)).toBe(false);
  });

  it("respects timezone from cron schedule", () => {
    // 2026-03-03 23:30 UTC = 2026-03-04 in Tokyo (UTC+9)
    const nowMs = new Date("2026-03-03T23:30:00Z").getTime();
    const job = makeJob({
      maxRunsPerDay: 1,
      schedule: { kind: "cron", expr: "0 8 * * *", tz: "Asia/Tokyo" },
      state: { runsToday: 1, runsTodayDate: "2026-03-04" },
    });
    // In Tokyo it's already March 4, and we've hit the limit for March 4
    expect(isJobAtDailyLimit(job, nowMs)).toBe(true);
  });

  it("uses UTC when no timezone is configured (every schedule)", () => {
    const nowMs = new Date("2026-03-03T12:00:00Z").getTime();
    const job = makeJob({
      maxRunsPerDay: 1,
      schedule: { kind: "every", everyMs: 3600_000 },
      state: { runsToday: 1, runsTodayDate: "2026-03-03" },
    });
    expect(isJobAtDailyLimit(job, nowMs)).toBe(true);
  });
});

describe("isJobDue – maxRunsPerDay integration", () => {
  it("returns false when daily limit is reached", () => {
    const now = Date.now();
    const today = new Date(now).toISOString().slice(0, 10);
    const job = makeJob({
      maxRunsPerDay: 1,
      state: {
        nextRunAtMs: now - 1000, // due
        runsToday: 1,
        runsTodayDate: today,
      },
    });
    expect(isJobDue(job, now, { forced: false })).toBe(false);
  });

  it("returns true when forced even if daily limit is reached", () => {
    const now = Date.now();
    const today = new Date(now).toISOString().slice(0, 10);
    const job = makeJob({
      maxRunsPerDay: 1,
      state: {
        nextRunAtMs: now - 1000,
        runsToday: 1,
        runsTodayDate: today,
      },
    });
    expect(isJobDue(job, now, { forced: true })).toBe(true);
  });

  it("returns true when daily limit is not yet reached", () => {
    const now = Date.now();
    const today = new Date(now).toISOString().slice(0, 10);
    const job = makeJob({
      maxRunsPerDay: 3,
      state: {
        nextRunAtMs: now - 1000,
        runsToday: 2,
        runsTodayDate: today,
      },
    });
    expect(isJobDue(job, now, { forced: false })).toBe(true);
  });
});

describe("applyJobResult – forced runs do not consume daily quota", () => {
  function makeState() {
    return {
      deps: {
        cronEnabled: true,
        storePath: "/tmp/cron-test.json",
        log: { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} },
        nowMs: () => Date.now(),
        enqueueSystemEvent: () => {},
        requestHeartbeatNow: () => {},
        runIsolatedAgentJob: () => Promise.resolve({ status: "ok" as const }),
      },
      store: { jobs: [] },
    } as unknown as Parameters<typeof applyJobResult>[0];
  }

  it("increments runsToday for non-forced successful runs", () => {
    const now = Date.now();
    const job = makeJob({ maxRunsPerDay: 3, state: {} });
    applyJobResult(makeState(), job, {
      status: "ok",
      startedAt: now - 1000,
      endedAt: now,
    });
    expect(job.state.runsToday).toBe(1);
  });

  it("does NOT increment runsToday for forced successful runs", () => {
    const now = Date.now();
    const job = makeJob({ maxRunsPerDay: 3, state: {} });
    applyJobResult(
      makeState(),
      job,
      {
        status: "ok",
        startedAt: now - 1000,
        endedAt: now,
      },
      { forced: true },
    );
    expect(job.state.runsToday).toBeUndefined();
  });

  it("forced run at limit does not block subsequent scheduled runs", () => {
    const now = Date.now();
    const today = new Date(now).toISOString().slice(0, 10);
    const job = makeJob({
      maxRunsPerDay: 1,
      state: { runsToday: 0, runsTodayDate: today },
    });

    // Force-run: should NOT increment counter
    applyJobResult(
      makeState(),
      job,
      {
        status: "ok",
        startedAt: now - 1000,
        endedAt: now,
      },
      { forced: true },
    );
    expect(job.state.runsToday).toBe(0);

    // Scheduled run: should still be allowed (limit not consumed)
    expect(isJobAtDailyLimit(job, now)).toBe(false);
  });
});
