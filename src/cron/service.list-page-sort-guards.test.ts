import { performance } from "node:perf_hooks";
import { isMainThread, threadId } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import { createMockCronStateForJobs } from "./service.test-harness.js";
import { locked } from "./service/locked.js";
import { listPage } from "./service/ops-read.js";
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
    state: { nextRunAtMs: Date.parse("2030-02-27T15:30:00.000Z") },
    createdAtMs: Date.parse("2026-02-27T15:00:00.000Z"),
    updatedAtMs: Date.parse("2026-02-27T15:05:00.000Z"),
    ...overrides,
  };
}

describe("cron listPage sort guards", () => {
  it.each([
    { sortDir: "asc" as const, scheduledIds: ["earlier", "later"] },
    { sortDir: "desc" as const, scheduledIds: ["later", "earlier"] },
  ])(
    "keeps unscheduled jobs after the scheduled $sortDir page",
    async ({ sortDir, scheduledIds }) => {
      const jobs = [
        createBaseJob({ id: "paused-z", enabled: false, state: {} }),
        createBaseJob({ id: "later", state: { nextRunAtMs: 200 } }),
        createBaseJob({ id: "paused-a", enabled: false, state: {} }),
        createBaseJob({ id: "earlier", state: { nextRunAtMs: 100 } }),
      ];
      const state = createMockCronStateForJobs({ jobs });
      const options = {
        enabled: "all" as const,
        sortBy: "nextRunAtMs" as const,
        sortDir,
        limit: 2,
      };

      const firstPage = await listPage(state, { ...options, offset: 0 });
      const secondPage = await listPage(state, { ...options, offset: 2 });

      expect(firstPage.jobs.map((job) => job.id)).toEqual(scheduledIds);
      expect(firstPage.hasMore).toBe(true);
      expect(secondPage.jobs.map((job) => job.id)).toEqual(["paused-a", "paused-z"]);
      expect(secondPage.hasMore).toBe(false);
      expect(secondPage.snapshotRevision).toBe(firstPage.snapshotRevision);
    },
  );

  it("preserves phrase searches across existing cron job fields", async () => {
    const job = createBaseJob({
      id: "report-job",
      name: "Daily report",
      description: "Quarterly summary",
      displayName: "Executive overview",
    });
    const state = createMockCronStateForJobs({ jobs: [job, createBaseJob({ id: "other" })] });

    const page = await listPage(state, { query: "report Quarterly" });

    expect(page.jobs.map((entry) => entry.id)).toEqual(["report-job"]);
  });

  it("filters normalized agent owners across explicit, session-scoped, and default jobs", async () => {
    const jobs = [
      createBaseJob({ id: "job-main", agentId: "main", name: "main" }),
      createBaseJob({ id: "job-ops", agentId: "ops", name: "ops" }),
      createBaseJob({ id: "job-unset", agentId: undefined, name: "unset" }),
      createBaseJob({ id: "job-scoped", sessionKey: "agent:ops:main" }),
    ];
    const state = createMockCronStateForJobs({ jobs });
    state.deps.defaultAgentId = " Ops ";

    const page = await listPage(state, { agentId: " OPS " });

    expect(page.jobs.map((job) => job.id)).toEqual(["job-ops", "job-scoped", "job-unset"]);
  });

  it("listPage does not clone the complete store, detaches only requested rows, and revisions cover off-page changes", async () => {
    const jobs = [
      createBaseJob({ id: "job-a", name: "alpha" }),
      createBaseJob({ id: "job-b", name: "beta" }),
      createBaseJob({ id: "job-c", name: "gamma" }),
    ];
    const state = createMockCronStateForJobs({ jobs });
    const clone = vi.spyOn(globalThis, "structuredClone");
    state.schedulerStarted = true;

    try {
      const options = { limit: 1, offset: 1, sortBy: "name" as const };
      const page = await listPage(state, options);
      const clonedArrays = clone.mock.calls.filter(([value]) => Array.isArray(value));

      expect(clone).not.toHaveBeenCalledWith(state.store);
      expect(clonedArrays).toHaveLength(1);
      expect(clonedArrays[0]?.[0]).toEqual([jobs[1]]);
      expect(page.jobs[0]).not.toBe(jobs[1]);
      jobs[1]!.state.lastStatus = "ok";
      expect(page.jobs[0]?.state.lastStatus).toBeUndefined();

      await locked(state, async () => {
        jobs[2]!.state.lastStatus = "ok";
      });
      const changed = await listPage(state, options);

      expect(changed.jobs.map((job) => job.id)).toEqual(["job-b"]);
      expect(changed.snapshotRevision).not.toBe(page.snapshotRevision);
    } finally {
      clone.mockRestore();
    }
  });

  it("applies schedule, status, and trigger filters before paging", async () => {
    const nextRunAtMs = Date.parse("2030-02-27T15:30:00.000Z");
    const jobs = [
      createBaseJob({
        id: "at-unknown",
        schedule: { kind: "at", at: "2030-02-27T15:30:00.000Z" },
      }),
      createBaseJob({
        id: "cron-error",
        state: { nextRunAtMs, lastStatus: "error" },
      }),
      createBaseJob({
        id: "cron-unknown",
        trigger: { script: "json({ fire: true })" },
      }),
      createBaseJob({ id: "cron-unknown-plain" }),
    ];
    const state = createMockCronStateForJobs({ jobs });
    const page = await listPage(state, {
      scheduleKind: "cron",
      lastRunStatus: "unknown",
      trigger: "conditional",
      limit: 1,
    });
    expect(page.jobs.map((job) => job.id)).toEqual(["cron-unknown"]);
    expect(page.total).toBe(1);
    expect(page.hasMore).toBe(false);
  });
});

describe("cron listPage slow diagnostics", () => {
  it("preserves callback failure and subsequent reads when the logger throws", async () => {
    let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const state = createMockCronStateForJobs({ jobs: [createBaseJob()] });
    const failure = new Error("synthetic selected-row failure");
    const warn = vi.fn(() => {
      throw new Error("synthetic logger failure");
    });
    state.deps.log.warn = warn;
    state.deps.resolveDefaultAgentId = () => {
      now = 1_200;
      throw failure;
    };
    try {
      await expect(listPage(state, { agentId: "main" })).rejects.toBe(failure);
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        {
          operation: "cron.listPage",
          pid: process.pid,
          threadId,
          isMainThread,
          elapsedMs: 1_200,
          waitToCallbackMs: 0,
          callbackMs: 1_200,
          completionDelayMs: 0,
          sourceCount: 1,
          matchedCount: undefined,
          returnedCount: undefined,
          outcome: "error",
          thresholdMs: 1_000,
        },
        "cron: slow list page",
      );
      expect((await listPage(state)).jobs.map((job) => job.id)).toEqual(["job-1"]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      await state.op;
      clock.mockRestore();
    }
  });
});
