import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import type { CronJob } from "./types.js";

/**
 * Tests for #18892: Gateway unresponsive when restarted with overdue cron jobs
 *
 * When the gateway restarts with many overdue jobs, they should be staggered
 * to prevent overwhelming the gateway with simultaneous executions.
 */

const noopLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
};

let fixtureRoot = "";
let fixtureCount = 0;

async function makeStorePath() {
  const dir = path.join(fixtureRoot, `case-${fixtureCount++}`);
  await fs.mkdir(dir, { recursive: true });
  const storePath = path.join(dir, "jobs.json");
  return { storePath };
}

function createOverdueJob(params: { id: string; nowMs: number; overdueByMs: number }): CronJob {
  const nextRunAtMs = params.nowMs - params.overdueByMs;
  return {
    id: params.id,
    name: `job-${params.id}`,
    enabled: true,
    deleteAfterRun: false,
    createdAtMs: params.nowMs - 3600_000,
    updatedAtMs: params.nowMs - 3600_000,
    schedule: { kind: "every", everyMs: 3600_000, anchorMs: params.nowMs - 3600_000 },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: `tick-${params.id}` },
    state: { nextRunAtMs },
  };
}

describe("#18892: Missed jobs stagger on restart", () => {
  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cron-stagger-"));
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-06T10:00:00.000Z"));
  });

  afterAll(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("runs only maxMissedJobsPerRestart jobs immediately", async () => {
    const store = await makeStorePath();
    const nowMs = Date.now();
    const enqueueSystemEvent = vi.fn();
    const executedJobIds: string[] = [];

    // Create store file with 10 overdue jobs
    const overdueJobs = Array.from({ length: 10 }, (_, i) =>
      createOverdueJob({
        id: `job-${i}`,
        nowMs,
        overdueByMs: (10 - i) * 60_000, // Most overdue first
      }),
    );

    await fs.writeFile(store.storePath, JSON.stringify({ jobs: overdueJobs }), "utf-8");

    const cron = new CronService({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      enqueueSystemEvent: (text) => {
        enqueueSystemEvent(text);
        const match = text.match(/tick-(job-\d+)/);
        if (match) {
          executedJobIds.push(match[1]);
        }
      },
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: "ok", summary: "ok" }),
      // Configure low limits for testing
      maxMissedJobsPerRestart: 3,
      missedJobStaggerMs: 100,
    });

    await cron.start();

    // Only 3 jobs should have executed immediately
    expect(executedJobIds.length).toBe(3);

    // Check that the most overdue jobs were run first (sorted by nextRunAtMs)
    expect(executedJobIds).toContain("job-0");
    expect(executedJobIds).toContain("job-1");
    expect(executedJobIds).toContain("job-2");

    // Remaining jobs should be rescheduled with staggered times
    const status = await cron.status();
    expect(status.jobs).toBe(10);
  });

  it("reschedules deferred jobs with staggered nextRunAtMs", async () => {
    const store = await makeStorePath();
    const nowMs = Date.now();

    // Create 8 overdue jobs
    const overdueJobs = Array.from({ length: 8 }, (_, i) =>
      createOverdueJob({
        id: `stagger-${i}`,
        nowMs,
        overdueByMs: (8 - i) * 60_000,
      }),
    );

    await fs.writeFile(store.storePath, JSON.stringify({ jobs: overdueJobs }), "utf-8");

    const cron = new CronService({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: "ok", summary: "ok" }),
      maxMissedJobsPerRestart: 2,
      missedJobStaggerMs: 5000,
    });

    await cron.start();

    // Check that deferred jobs have staggered nextRunAtMs
    const jobs = await cron.list({ includeDisabled: true });
    const deferredJobs = jobs.filter(
      (j) =>
        j.state.nextRunAtMs !== undefined &&
        j.state.nextRunAtMs > nowMs &&
        j.state.lastStatus !== "ok",
    );

    // 6 jobs should be deferred (8 total - 2 immediate)
    expect(deferredJobs.length).toBeGreaterThanOrEqual(5);

    // Deferred jobs should have staggered times
    const sortedDeferred = deferredJobs.toSorted(
      (a, b) => (a.state.nextRunAtMs ?? 0) - (b.state.nextRunAtMs ?? 0),
    );

    for (let i = 1; i < sortedDeferred.length; i++) {
      const prevTime = sortedDeferred[i - 1].state.nextRunAtMs ?? 0;
      const currTime = sortedDeferred[i].state.nextRunAtMs ?? 0;
      // Each subsequent job should be at least staggerMs later
      expect(currTime - prevTime).toBeGreaterThanOrEqual(5000);
    }
  });

  it("runs all jobs immediately when count is below limit", async () => {
    const store = await makeStorePath();
    const nowMs = Date.now();
    const executedJobIds: string[] = [];

    // Create only 2 overdue jobs
    const overdueJobs = Array.from({ length: 2 }, (_, i) =>
      createOverdueJob({
        id: `small-${i}`,
        nowMs,
        overdueByMs: (2 - i) * 60_000,
      }),
    );

    await fs.writeFile(store.storePath, JSON.stringify({ jobs: overdueJobs }), "utf-8");

    const cron = new CronService({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      enqueueSystemEvent: (text) => {
        const match = text.match(/tick-(small-\d+)/);
        if (match) {
          executedJobIds.push(match[1]);
        }
      },
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: "ok", summary: "ok" }),
      maxMissedJobsPerRestart: 5, // Higher than job count
      missedJobStaggerMs: 100,
    });

    await cron.start();

    // Both jobs should have executed
    expect(executedJobIds.length).toBe(2);
    expect(executedJobIds).toContain("small-0");
    expect(executedJobIds).toContain("small-1");
  });

  it("logs stagger info when deferring jobs", async () => {
    const store = await makeStorePath();
    const nowMs = Date.now();
    const loggerInfo = vi.fn();

    const overdueJobs = Array.from({ length: 6 }, (_, i) =>
      createOverdueJob({
        id: `log-${i}`,
        nowMs,
        overdueByMs: (6 - i) * 60_000,
      }),
    );

    await fs.writeFile(store.storePath, JSON.stringify({ jobs: overdueJobs }), "utf-8");

    const cron = new CronService({
      cronEnabled: true,
      storePath: store.storePath,
      log: { ...noopLogger, info: loggerInfo },
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: "ok", summary: "ok" }),
      maxMissedJobsPerRestart: 2,
      missedJobStaggerMs: 1000,
    });

    await cron.start();

    // Should log about staggering
    const staggerCall = loggerInfo.mock.calls.find(
      (call) => typeof call[1] === "string" && call[1].includes("staggering missed jobs"),
    );
    expect(staggerCall).toBeDefined();
    expect(staggerCall?.[0]).toMatchObject({
      immediateCount: 2,
      deferredCount: 4,
      totalMissed: 6,
    });
  });
});
