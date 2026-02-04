import { describe, expect, it } from "vitest";
import { recomputeNextRuns } from "./service/jobs.js";
import type { CronServiceState } from "./service/state.js";
import type { CronJob } from "./types.js";

describe("recomputeNextRuns", () => {
  it("preserves nextRunAtMs when it is still in the future", () => {
    const now = Date.parse("2026-02-04T14:00:00.000Z");
    const futureTime = Date.parse("2026-02-04T20:00:00.000Z");
    
    const job: CronJob = {
      id: "job-1",
      name: "Test Job",
      enabled: true,
      createdAtMs: now - 86400_000,
      updatedAtMs: now - 86400_000,
      schedule: { kind: "cron", expr: "0 12,16,20 * * 1-5" }, // 12:00, 16:00, 20:00 on weekdays
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "Test" },
      state: {
        lastRunAtMs: Date.parse("2026-02-03T20:00:00.000Z"), // Last ran at 20:00 yesterday
        nextRunAtMs: futureTime, // Already scheduled for 20:00 today
      },
    };

    const state: CronServiceState = {
      store: { jobs: [job] },
      deps: {
        cronEnabled: true,
        storePath: "/tmp/test",
        nowMs: () => now,
        log: { info: () => {}, warn: () => {} } as any,
        enqueueSystemEvent: () => {},
        runIsolatedAgentJob: async () => {},
        requestHeartbeatNow: () => {},
        runHeartbeatOnce: async () => {},
        onEvent: () => {},
      },
      lock: null as any,
      timer: null,
    };

    recomputeNextRuns(state);

    // Should preserve the future scheduled time (20:00), not recalculate to 16:00
    expect(job.state.nextRunAtMs).toBe(futureTime);
  });

  it("recomputes nextRunAtMs when it is in the past", () => {
    const now = Date.parse("2026-02-04T14:00:00.000Z");
    const pastTime = Date.parse("2026-02-04T12:00:00.000Z");
    
    const job: CronJob = {
      id: "job-2",
      name: "Test Job 2",
      enabled: true,
      createdAtMs: now - 86400_000,
      updatedAtMs: now - 86400_000,
      schedule: { kind: "cron", expr: "0 12,16,20 * * 1-5" },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "Test" },
      state: {
        lastRunAtMs: Date.parse("2026-02-03T20:00:00.000Z"),
        nextRunAtMs: pastTime, // Scheduled for 12:00, but it's now 14:00
      },
    };

    const state: CronServiceState = {
      store: { jobs: [job] },
      deps: {
        cronEnabled: true,
        storePath: "/tmp/test",
        nowMs: () => now,
        log: { info: () => {}, warn: () => {} } as any,
        enqueueSystemEvent: () => {},
        runIsolatedAgentJob: async () => {},
        requestHeartbeatNow: () => {},
        runHeartbeatOnce: async () => {},
        onEvent: () => {},
      },
      lock: null as any,
      timer: null,
    };

    recomputeNextRuns(state);

    // Should recalculate to next occurrence (16:00)
    const expected16 = Date.parse("2026-02-04T16:00:00.000Z");
    expect(job.state.nextRunAtMs).toBe(expected16);
  });

  it("recomputes nextRunAtMs when it is undefined", () => {
    const now = Date.parse("2026-02-04T14:00:00.000Z");
    
    const job: CronJob = {
      id: "job-3",
      name: "Test Job 3",
      enabled: true,
      createdAtMs: now,
      updatedAtMs: now,
      schedule: { kind: "cron", expr: "0 12,16,20 * * 1-5" },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "Test" },
      state: {
        // No nextRunAtMs set
      },
    };

    const state: CronServiceState = {
      store: { jobs: [job] },
      deps: {
        cronEnabled: true,
        storePath: "/tmp/test",
        nowMs: () => now,
        log: { info: () => {}, warn: () => {} } as any,
        enqueueSystemEvent: () => {},
        runIsolatedAgentJob: async () => {},
        requestHeartbeatNow: () => {},
        runHeartbeatOnce: async () => {},
        onEvent: () => {},
      },
      lock: null as any,
      timer: null,
    };

    recomputeNextRuns(state);

    // Should compute next occurrence (16:00)
    const expected16 = Date.parse("2026-02-04T16:00:00.000Z");
    expect(job.state.nextRunAtMs).toBe(expected16);
  });
});
