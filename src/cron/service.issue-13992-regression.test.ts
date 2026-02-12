import { describe, expect, it } from "vitest";
import type { CronServiceState } from "./service/state.js";
import type { CronJob } from "./types.js";
import { recomputeNextRunsForMaintenance } from "./service/jobs.js";

describe("issue #13992 regression - cron jobs skip execution", () => {
  function createMockState(jobs: CronJob[]): CronServiceState {
    return {
      store: { version: 1, jobs },
      running: false,
      timer: null,
      storeLoadedAtMs: Date.now(),
      deps: {
        storePath: "/mock/path",
        cronEnabled: true,
        nowMs: () => Date.now(),
        log: {
          debug: () => {},
          info: () => {},
          warn: () => {},
          error: () => {},
        } as never,
      },
    };
  }

  it("should NOT recompute nextRunAtMs for past-due jobs during maintenance", () => {
    const now = Date.now();
    const pastDue = now - 60_000; // 1 minute ago

    const job: CronJob = {
      id: "test-job",
      name: "test job",
      enabled: true,
      schedule: { kind: "cron", expr: "0 8 * * *", tz: "UTC" },
      payload: { kind: "systemEvent", text: "test" },
      sessionTarget: "main",
      createdAtMs: now - 3600_000,
      updatedAtMs: now - 3600_000,
      state: {
        nextRunAtMs: pastDue, // This is in the past and should NOT be recomputed
      },
    };

    const state = createMockState([job]);
    recomputeNextRunsForMaintenance(state);

    // Should not have changed the past-due nextRunAtMs
    expect(job.state.nextRunAtMs).toBe(pastDue);
  });

  it("should compute missing nextRunAtMs during maintenance", () => {
    const now = Date.now();

    const job: CronJob = {
      id: "test-job",
      name: "test job",
      enabled: true,
      schedule: { kind: "cron", expr: "0 8 * * *", tz: "UTC" },
      payload: { kind: "systemEvent", text: "test" },
      sessionTarget: "main",
      createdAtMs: now,
      updatedAtMs: now,
      state: {
        // nextRunAtMs is missing
      },
    };

    const state = createMockState([job]);
    recomputeNextRunsForMaintenance(state);

    // Should have computed a nextRunAtMs
    expect(typeof job.state.nextRunAtMs).toBe("number");
    expect(job.state.nextRunAtMs).toBeGreaterThan(now);
  });

  it("should clear nextRunAtMs for disabled jobs during maintenance", () => {
    const now = Date.now();
    const futureTime = now + 3600_000;

    const job: CronJob = {
      id: "test-job",
      name: "test job",
      enabled: false, // Disabled
      schedule: { kind: "cron", expr: "0 8 * * *", tz: "UTC" },
      payload: { kind: "systemEvent", text: "test" },
      sessionTarget: "main",
      createdAtMs: now,
      updatedAtMs: now,
      state: {
        nextRunAtMs: futureTime,
      },
    };

    const state = createMockState([job]);
    recomputeNextRunsForMaintenance(state);

    // Should have cleared nextRunAtMs for disabled job
    expect(job.state.nextRunAtMs).toBeUndefined();
  });

  it("should clear stuck running markers during maintenance", () => {
    const now = Date.now();
    const stuckTime = now - 20 * 60_000; // 20 minutes ago (> 10 min threshold)
    const futureTime = now + 3600_000;

    const job: CronJob = {
      id: "test-job",
      name: "test job",
      enabled: true,
      schedule: { kind: "cron", expr: "0 8 * * *", tz: "UTC" },
      payload: { kind: "systemEvent", text: "test" },
      sessionTarget: "main",
      createdAtMs: now,
      updatedAtMs: now,
      state: {
        nextRunAtMs: futureTime,
        runningAtMs: stuckTime, // Stuck running marker
      },
    };

    const state = createMockState([job]);
    recomputeNextRunsForMaintenance(state);

    // Should have cleared stuck running marker
    expect(job.state.runningAtMs).toBeUndefined();
    // But should NOT have changed nextRunAtMs (it's still future)
    expect(job.state.nextRunAtMs).toBe(futureTime);
  });
});
