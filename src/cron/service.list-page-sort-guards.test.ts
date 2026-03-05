import { describe, expect, it } from "vitest";
import { createMockCronStateForJobs } from "./service.test-harness.js";
import { listPage } from "./service/ops.js";
import type { CronJob } from "./types.js";

function createBaseJob(overrides?: Partial<CronJob>): CronJob {
  return {
    id: "job-1",
    name: "job",
    enabled: true,
    schedule: { kind: "cron", expr: "*/5 * * * *", tz: "UTC" },
    sessionTarget: "main",
    wakeMode: "now",
    payload: { kind: "systemEvent", text: "tick" },
    state: { nextRunAtMs: Date.parse("2026-02-27T15:30:00.000Z") },
    createdAtMs: Date.parse("2026-02-27T15:00:00.000Z"),
    updatedAtMs: Date.parse("2026-02-27T15:05:00.000Z"),
    ...overrides,
  };
}

describe("cron listPage sort guards", () => {
  it("does not throw when sorting by name with malformed name fields", async () => {
    const jobs = [
      createBaseJob({ id: "job-a", name: undefined as unknown as string }),
      createBaseJob({ id: "job-b", name: "beta" }),
    ];
    const state = createMockCronStateForJobs({ jobs });

    const page = await listPage(state, { sortBy: "name", sortDir: "asc" });
    expect(page.jobs).toHaveLength(2);
  });

  it("does not throw when tie-break sorting encounters missing ids", async () => {
    const nextRunAtMs = Date.parse("2026-02-27T15:30:00.000Z");
    const jobs = [
      createBaseJob({
        id: undefined as unknown as string,
        name: "alpha",
        state: { nextRunAtMs },
      }),
      createBaseJob({
        id: undefined as unknown as string,
        name: "alpha",
        state: { nextRunAtMs },
      }),
    ];
    const state = createMockCronStateForJobs({ jobs });

    const page = await listPage(state, { sortBy: "nextRunAtMs", sortDir: "asc" });
    expect(page.jobs).toHaveLength(2);
  });
});

describe("cron listPage descending tie-breaker", () => {
  it("uses id descending when names tie in desc order", async () => {
    const jobs = [
      createBaseJob({ id: "job-a", name: "same", updatedAtMs: 1, state: { nextRunAtMs: 1 } }),
      createBaseJob({ id: "job-b", name: "same", updatedAtMs: 1, state: { nextRunAtMs: 1 } }),
    ];
    const state = createMockCronStateForJobs({ jobs });

    const page = await listPage(state, { sortBy: "name", sortDir: "desc" });
    expect(page.jobs.map((job) => job.id)).toEqual(["job-b", "job-a"]);
  });

  it("uses id descending when updatedAtMs ties in desc order", async () => {
    const jobs = [
      createBaseJob({ id: "job-a", name: "alpha", updatedAtMs: 42 }),
      createBaseJob({ id: "job-b", name: "beta", updatedAtMs: 42 }),
    ];
    const state = createMockCronStateForJobs({ jobs });

    const page = await listPage(state, { sortBy: "updatedAtMs", sortDir: "desc" });
    expect(page.jobs.map((job) => job.id)).toEqual(["job-b", "job-a"]);
  });

  it("uses id descending when nextRunAtMs ties in desc order", async () => {
    const nextRunAtMs = Date.parse("2026-02-27T15:30:00.000Z");
    const jobs = [
      createBaseJob({ id: "job-a", name: "alpha", state: { nextRunAtMs } }),
      createBaseJob({ id: "job-b", name: "beta", state: { nextRunAtMs } }),
    ];
    const state = createMockCronStateForJobs({ jobs });

    const page = await listPage(state, { sortBy: "nextRunAtMs", sortDir: "desc" });
    expect(page.jobs.map((job) => job.id)).toEqual(["job-b", "job-a"]);
  });
});
