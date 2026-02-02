import { describe, expect, it, vi } from "vitest";
import type { CronJob } from "../types.js";
import type { CronServiceState } from "./state.js";
import { createJob, recomputeNextRuns } from "./jobs.js";

function makeMockState(nowMs: number, jobs: CronJob[] = []): CronServiceState {
  return {
    deps: {
      nowMs: () => nowMs,
      log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    },
    store: { version: 1, jobs },
  } as unknown as CronServiceState;
}

describe("cron jobs anchor fix", () => {
  it("createJob sets anchorMs for every schedule when not provided", () => {
    const now = Date.parse("2025-12-13T00:00:00.000Z");
    const state = makeMockState(now);

    const job = createJob(state, {
      name: "test-job",
      enabled: true,
      schedule: { kind: "every", everyMs: 3600000 }, // 1 hour, no anchorMs
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "test" },
    });

    // anchorMs should be set to creation time
    expect(job.schedule.kind).toBe("every");
    if (job.schedule.kind === "every") {
      expect(job.schedule.anchorMs).toBe(now);
    }
  });

  it("createJob preserves provided anchorMs", () => {
    const now = Date.parse("2025-12-13T00:00:00.000Z");
    const customAnchor = Date.parse("2025-12-12T00:00:00.000Z");
    const state = makeMockState(now);

    const job = createJob(state, {
      name: "test-job",
      enabled: true,
      schedule: { kind: "every", everyMs: 3600000, anchorMs: customAnchor },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "test" },
    });

    if (job.schedule.kind === "every") {
      expect(job.schedule.anchorMs).toBe(customAnchor);
    }
  });
});

describe("cron jobs catch-up logic", () => {
  it("schedules missed job immediately on restart", () => {
    const createdAt = Date.parse("2025-12-13T00:00:00.000Z");
    const interval = 3600000; // 1 hour
    // Restart 2 hours later - job should have run once but didn't
    const restartTime = createdAt + 2 * interval;

    const job: CronJob = {
      id: "test-id",
      name: "test-job",
      enabled: true,
      createdAtMs: createdAt,
      updatedAtMs: createdAt,
      schedule: { kind: "every", everyMs: interval, anchorMs: createdAt },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "test" },
      state: {
        // No lastRunAtMs - never ran
      },
    };

    const state = makeMockState(restartTime, [job]);
    recomputeNextRuns(state);

    // Job was missed, should be scheduled to run now
    expect(job.state.nextRunAtMs).toBe(restartTime);
  });

  it("does not catch-up if job ran recently", () => {
    const createdAt = Date.parse("2025-12-13T00:00:00.000Z");
    const interval = 3600000; // 1 hour
    const lastRan = createdAt + interval; // Ran once
    const restartTime = lastRan + interval / 2; // Restart 30 min later

    const job: CronJob = {
      id: "test-id",
      name: "test-job",
      enabled: true,
      createdAtMs: createdAt,
      updatedAtMs: createdAt,
      schedule: { kind: "every", everyMs: interval, anchorMs: createdAt },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "test" },
      state: {
        lastRunAtMs: lastRan,
      },
    };

    const state = makeMockState(restartTime, [job]);
    recomputeNextRuns(state);

    // Job ran recently, next run should be at the proper interval
    // anchor + 2*interval = createdAt + 2h
    expect(job.state.nextRunAtMs).toBe(createdAt + 2 * interval);
  });
});
