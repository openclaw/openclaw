import { expect, it } from "vitest";
import { createMockCronStateForJobs } from "./service.test-harness.js";
import { recomputeNextRunsForMaintenance } from "./service/jobs-scheduling.js";
import type { CronJob } from "./types.js";

it("advances an already executed daily slot during recovery (#17852)", () => {
  const threeAM = Date.parse("2026-02-16T03:00:00.000Z");
  const dayMs = 24 * 3_600_000;
  const job: CronJob = {
    id: "daily-job",
    name: "daily 3am",
    enabled: true,
    schedule: { kind: "cron", expr: "0 3 * * *", tz: "UTC" },
    payload: { kind: "systemEvent", text: "daily task" },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    createdAtMs: threeAM - dayMs,
    updatedAtMs: threeAM - dayMs,
    state: { nextRunAtMs: threeAM, lastRunAtMs: threeAM + 1 },
  };
  const state = createMockCronStateForJobs({ jobs: [job], nowMs: threeAM + 1_000 });
  recomputeNextRunsForMaintenance(state, { deferredNotifications: [], recomputeExpired: true });
  expect(job.state.nextRunAtMs).toBe(threeAM + dayMs);
});
