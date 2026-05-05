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

// Regression for #77118: cron list returned every job across every agent in
// multi-agent setups, creating prompt noise and accidental cross-agent
// modification risk. listPage now accepts an optional agentId filter that
// restricts the result to jobs owned by that agent. Omitting the filter
// preserves the historical behavior.
describe("cron listPage agentId filter (#77118)", () => {
  it("restricts the result to jobs owned by the given agentId", async () => {
    const jobs = [
      createBaseJob({ id: "main-1", name: "main job 1", agentId: "main" }),
      createBaseJob({ id: "main-2", name: "main job 2", agentId: "main" }),
      createBaseJob({ id: "alpha-1", name: "alpha job", agentId: "alpha" }),
      createBaseJob({ id: "beta-1", name: "beta job", agentId: "beta" }),
    ];
    const state = createMockCronStateForJobs({ jobs });

    const mainPage = await listPage(state, { agentId: "main" });
    expect(mainPage.jobs.map((j) => j.id).toSorted()).toEqual(["main-1", "main-2"]);
    expect(mainPage.total).toBe(2);

    const alphaPage = await listPage(state, { agentId: "alpha" });
    expect(alphaPage.jobs.map((j) => j.id)).toEqual(["alpha-1"]);
  });

  it("returns every job when agentId is omitted (backward compatible)", async () => {
    const jobs = [
      createBaseJob({ id: "main-1", name: "main", agentId: "main" }),
      createBaseJob({ id: "alpha-1", name: "alpha", agentId: "alpha" }),
    ];
    const state = createMockCronStateForJobs({ jobs });

    const page = await listPage(state);
    expect(page.jobs).toHaveLength(2);
    expect(page.total).toBe(2);
  });

  it("treats empty/whitespace agentId as omitted", async () => {
    const jobs = [
      createBaseJob({ id: "main-1", agentId: "main" }),
      createBaseJob({ id: "alpha-1", agentId: "alpha" }),
    ];
    const state = createMockCronStateForJobs({ jobs });

    const page = await listPage(state, { agentId: "   " });
    expect(page.jobs).toHaveLength(2);
  });

  it("returns no jobs when agentId does not match any job", async () => {
    const jobs = [
      createBaseJob({ id: "main-1", agentId: "main" }),
      createBaseJob({ id: "alpha-1", agentId: "alpha" }),
    ];
    const state = createMockCronStateForJobs({ jobs });

    const page = await listPage(state, { agentId: "nonexistent" });
    expect(page.jobs).toHaveLength(0);
    expect(page.total).toBe(0);
  });

  it("composes agentId with the existing query filter", async () => {
    const jobs = [
      createBaseJob({ id: "main-tick", name: "tick", agentId: "main" }),
      createBaseJob({ id: "main-tock", name: "tock", agentId: "main" }),
      createBaseJob({ id: "alpha-tick", name: "tick", agentId: "alpha" }),
    ];
    const state = createMockCronStateForJobs({ jobs });

    const page = await listPage(state, { agentId: "main", query: "tick" });
    expect(page.jobs.map((j) => j.id)).toEqual(["main-tick"]);
  });

  it("treats jobs missing agentId as default-agent jobs (#77118)", async () => {
    const jobs = [
      createBaseJob({ id: "default-implicit", name: "implicit", agentId: undefined }),
      createBaseJob({ id: "default-explicit", name: "explicit", agentId: "main" }),
      createBaseJob({ id: "alpha-only", name: "alpha", agentId: "alpha" }),
    ];
    const state = createMockCronStateForJobs({ jobs, defaultAgentId: "main" });

    const mainPage = await listPage(state, { agentId: "main" });
    expect(mainPage.jobs.map((j) => j.id).toSorted()).toEqual([
      "default-explicit",
      "default-implicit",
    ]);
    expect(mainPage.total).toBe(2);
  });
});
