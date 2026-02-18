import { describe, expect, it } from "vitest";
import { computeJobNextRunAtMs } from "./jobs.js";
import type { CronJob } from "./types.js";

function makeAtJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "test-at-job",
    enabled: true,
    createdAtMs: 1000,
    schedule: { kind: "at", at: "2026-02-20T00:00:00Z" },
    delivery: { mode: "agentTurn", text: "test" },
    state: {
      lastStatus: undefined,
      lastRunAtMs: undefined,
      nextRunAtMs: undefined,
    },
    ...overrides,
  } as CronJob;
}

describe("computeJobNextRunAtMs — at-job rescheduling (#19676)", () => {
  const nowMs = Date.now();

  it("returns atMs for a fresh at-job that has not run", () => {
    const job = makeAtJob();
    const next = computeJobNextRunAtMs(job, nowMs);
    expect(next).toBeDefined();
    expect(next).toBeGreaterThan(0);
  });

  it("returns undefined after a successful run at the scheduled time", () => {
    const scheduledMs = new Date("2026-02-20T00:00:00Z").getTime();
    const job = makeAtJob({
      state: {
        lastStatus: "ok",
        lastRunAtMs: scheduledMs,
        nextRunAtMs: undefined,
      },
    });
    const next = computeJobNextRunAtMs(job, nowMs);
    expect(next).toBeUndefined();
  });

  it("returns new atMs when rescheduled after a successful run (#19676)", () => {
    const oldScheduledMs = new Date("2026-02-19T00:00:00Z").getTime();
    const newScheduledMs = new Date("2026-02-21T00:00:00Z").getTime();
    const job = makeAtJob({
      schedule: { kind: "at", at: "2026-02-21T00:00:00Z" },
      state: {
        lastStatus: "ok",
        lastRunAtMs: oldScheduledMs, // ran at old time
        nextRunAtMs: undefined,
      },
    });
    const next = computeJobNextRunAtMs(job, nowMs);
    // Should fire again because lastRunAtMs < new atMs
    expect(next).toBe(newScheduledMs);
  });

  it("returns undefined when lastRunAtMs equals the current schedule", () => {
    const scheduledMs = new Date("2026-02-20T00:00:00Z").getTime();
    const job = makeAtJob({
      state: {
        lastStatus: "ok",
        lastRunAtMs: scheduledMs,
        nextRunAtMs: undefined,
      },
    });
    const next = computeJobNextRunAtMs(job, nowMs);
    expect(next).toBeUndefined();
  });
});
