import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "../service.test-harness.js";
import type { CronJob } from "../types.js";
import { createCronServiceState } from "./state.js";
import { onTimer, runMissedJobs } from "./timer.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-maintenance-window-",
});

function createEveryIsolatedJob(params: {
  id: string;
  now: number;
  nextRunAtMs: number;
  agentId?: string;
  deferredRuns?: number;
  firstDeferredAtMs?: number;
}): CronJob {
  return {
    id: params.id,
    name: params.id,
    enabled: true,
    agentId: params.agentId,
    createdAtMs: params.now - 60_000,
    updatedAtMs: params.now - 60_000,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: params.now - 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: `run:${params.id}` },
    state: {
      nextRunAtMs: params.nextRunAtMs,
      ...(typeof params.deferredRuns === "number"
        ? {
            deferredMaintenanceRuns: params.deferredRuns,
            firstDeferredMaintenanceAtMs: params.firstDeferredAtMs ?? params.now - 1_000,
            lastDeferredMaintenanceAtMs: params.now - 500,
          }
        : {}),
    },
  };
}

function createOneShotIsolatedJob(params: {
  id: string;
  now: number;
  at: string;
  agentId?: string;
  deferredRuns?: number;
  firstDeferredAtMs?: number;
}): CronJob {
  return {
    id: params.id,
    name: params.id,
    enabled: true,
    agentId: params.agentId,
    createdAtMs: params.now - 60_000,
    updatedAtMs: params.now - 60_000,
    schedule: { kind: "at", at: params.at },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: `run:${params.id}` },
    state:
      typeof params.deferredRuns === "number"
        ? {
            deferredMaintenanceRuns: params.deferredRuns,
            firstDeferredMaintenanceAtMs: params.firstDeferredAtMs ?? params.now - 1_000,
            lastDeferredMaintenanceAtMs: params.now - 500,
          }
        : {},
  };
}

describe("cron maintenance window scheduler", () => {
  it("defers due jobs durably when phase/role blocks execution", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-26T02:30:00.000Z");
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const, summary: "ok" }));

    await writeCronStoreSnapshot({
      storePath,
      jobs: [
        createEveryIsolatedJob({
          id: "blocked-due",
          now,
          nextRunAtMs: now - 1,
          agentId: "main",
        }),
      ],
    });

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      cronConfig: {
        maintenance: {
          enabled: true,
          window: {
            start: "00:00",
            end: "23:59",
            timezone: "UTC",
          },
          maintenanceAgents: ["maint"],
        },
      },
      defaultAgentId: "main",
      userTimezone: "UTC",
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob,
    });

    await onTimer(state);

    expect(runIsolatedAgentJob).not.toHaveBeenCalled();
    const persisted = JSON.parse(await fs.readFile(storePath, "utf8")) as {
      jobs: CronJob[];
    };
    const job = persisted.jobs.find((entry) => entry.id === "blocked-due");
    expect(job?.state.deferredMaintenanceRuns).toBe(1);
    expect(job?.state.firstDeferredMaintenanceAtMs).toBe(now);
    expect((job?.state.nextRunAtMs ?? 0) > now).toBe(true);
  });

  it("replays deferred jobs FIFO once phase allows", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-26T05:00:00.000Z");
    const runOrder: string[] = [];

    const runIsolatedAgentJob = vi.fn(async ({ job }: { job: CronJob }) => {
      runOrder.push(job.id);
      return { status: "ok" as const, summary: job.id };
    });

    await writeCronStoreSnapshot({
      storePath,
      jobs: [
        createEveryIsolatedJob({
          id: "job-b",
          now,
          nextRunAtMs: now + 60_000,
          agentId: "main",
          deferredRuns: 1,
          firstDeferredAtMs: now - 5_000,
        }),
        createEveryIsolatedJob({
          id: "job-a",
          now,
          nextRunAtMs: now + 60_000,
          agentId: "main",
          deferredRuns: 1,
          firstDeferredAtMs: now - 15_000,
        }),
      ],
    });

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      cronConfig: {
        maintenance: {
          enabled: true,
          window: {
            start: "00:00",
            end: "01:00",
            timezone: "UTC",
          },
          maintenanceAgents: ["maint"],
        },
      },
      defaultAgentId: "main",
      userTimezone: "UTC",
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob,
    });

    await onTimer(state);

    expect(runOrder).toEqual(["job-a", "job-b"]);
    const persisted = JSON.parse(await fs.readFile(storePath, "utf8")) as {
      jobs: CronJob[];
    };
    const jobA = persisted.jobs.find((entry) => entry.id === "job-a");
    const jobB = persisted.jobs.find((entry) => entry.id === "job-b");
    expect(jobA?.state.deferredMaintenanceRuns).toBeUndefined();
    expect(jobB?.state.deferredMaintenanceRuns).toBeUndefined();
  });

  it("replays deferred one-shot runs exactly once", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-26T05:00:00.000Z");
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const, summary: "ok" }));

    await writeCronStoreSnapshot({
      storePath,
      jobs: [
        createOneShotIsolatedJob({
          id: "one-shot-deferred",
          now,
          at: "2026-03-26T04:00:00.000Z",
          agentId: "main",
          deferredRuns: 1,
          firstDeferredAtMs: now - 20_000,
        }),
      ],
    });

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      cronConfig: {
        maintenance: {
          enabled: true,
          window: {
            start: "00:00",
            end: "01:00",
            timezone: "UTC",
          },
          maintenanceAgents: ["maint"],
        },
      },
      defaultAgentId: "main",
      userTimezone: "UTC",
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob,
    });

    await onTimer(state);

    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
    const persisted = JSON.parse(await fs.readFile(storePath, "utf8")) as {
      jobs: CronJob[];
    };
    const job = persisted.jobs.find((entry) => entry.id === "one-shot-deferred");
    expect(job?.enabled).toBe(false);
    expect(job?.state.deferredMaintenanceRuns).toBeUndefined();
    expect(job?.state.nextRunAtMs).toBeUndefined();
  });

  it("records deferred startup catch-up runs when blocked by maintenance", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-26T02:30:00.000Z");
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const, summary: "ok" }));

    await writeCronStoreSnapshot({
      storePath,
      jobs: [
        createEveryIsolatedJob({
          id: "startup-blocked",
          now,
          nextRunAtMs: now - 1,
          agentId: "main",
        }),
      ],
    });

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      cronConfig: {
        maintenance: {
          enabled: true,
          window: {
            start: "00:00",
            end: "23:59",
            timezone: "UTC",
          },
          maintenanceAgents: ["maint"],
        },
      },
      defaultAgentId: "main",
      userTimezone: "UTC",
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob,
    });

    await runMissedJobs(state);

    expect(runIsolatedAgentJob).not.toHaveBeenCalled();
    const persisted = JSON.parse(await fs.readFile(storePath, "utf8")) as {
      jobs: CronJob[];
    };
    const job = persisted.jobs.find((entry) => entry.id === "startup-blocked");
    expect(job?.state.deferredMaintenanceRuns).toBe(1);
    expect(job?.state.firstDeferredMaintenanceAtMs).toBe(now);
  });
});
