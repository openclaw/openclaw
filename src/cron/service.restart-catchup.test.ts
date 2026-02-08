import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";

const noopLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

async function makeStorePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-"));
  return {
    storePath: path.join(dir, "cron", "jobs.json"),
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

describe("CronService restart catch-up", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-12-13T17:00:00.000Z"));
    noopLogger.debug.mockClear();
    noopLogger.info.mockClear();
    noopLogger.warn.mockClear();
    noopLogger.error.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("executes an overdue recurring job immediately on start", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    const dueAt = Date.parse("2025-12-13T15:00:00.000Z");
    const lastRunAt = Date.parse("2025-12-12T15:00:00.000Z");

    await fs.mkdir(path.dirname(store.storePath), { recursive: true });
    await fs.writeFile(
      store.storePath,
      JSON.stringify(
        {
          version: 1,
          jobs: [
            {
              id: "restart-overdue-job",
              name: "daily digest",
              enabled: true,
              createdAtMs: Date.parse("2025-12-10T12:00:00.000Z"),
              updatedAtMs: Date.parse("2025-12-12T15:00:00.000Z"),
              schedule: { kind: "cron", expr: "0 15 * * *", tz: "UTC" },
              sessionTarget: "main",
              wakeMode: "next-heartbeat",
              payload: { kind: "systemEvent", text: "digest now" },
              state: {
                nextRunAtMs: dueAt,
                lastRunAtMs: lastRunAt,
                lastStatus: "ok",
              },
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" })),
    });

    await cron.start();

    expect(enqueueSystemEvent).toHaveBeenCalledWith("digest now", { agentId: undefined });
    expect(requestHeartbeatNow).toHaveBeenCalled();

    const jobs = await cron.list({ includeDisabled: true });
    const updated = jobs.find((job) => job.id === "restart-overdue-job");
    expect(updated?.state.lastStatus).toBe("ok");
    expect(updated?.state.lastRunAtMs).toBe(Date.parse("2025-12-13T17:00:00.000Z"));
    expect(updated?.state.nextRunAtMs).toBeGreaterThan(Date.parse("2025-12-13T17:00:00.000Z"));

    cron.stop();
    await store.cleanup();
  });

  it("clears stale running markers and catches up overdue jobs on startup", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    const dueAt = Date.parse("2025-12-13T16:00:00.000Z");
    const staleRunningAt = Date.parse("2025-12-13T16:30:00.000Z");

    await fs.mkdir(path.dirname(store.storePath), { recursive: true });
    await fs.writeFile(
      store.storePath,
      JSON.stringify(
        {
          version: 1,
          jobs: [
            {
              id: "restart-stale-running",
              name: "daily stale marker",
              enabled: true,
              createdAtMs: Date.parse("2025-12-10T12:00:00.000Z"),
              updatedAtMs: Date.parse("2025-12-13T16:30:00.000Z"),
              schedule: { kind: "cron", expr: "0 16 * * *", tz: "UTC" },
              sessionTarget: "main",
              wakeMode: "next-heartbeat",
              payload: { kind: "systemEvent", text: "resume stale marker" },
              state: {
                nextRunAtMs: dueAt,
                runningAtMs: staleRunningAt,
              },
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" })),
    });

    await cron.start();

    expect(enqueueSystemEvent).toHaveBeenCalledWith("resume stale marker", { agentId: undefined });
    expect(noopLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "restart-stale-running" }),
      "cron: clearing stale running marker on startup",
    );

    const jobs = await cron.list({ includeDisabled: true });
    const updated = jobs.find((job) => job.id === "restart-stale-running");
    expect(updated?.state.runningAtMs).toBeUndefined();
    expect(updated?.state.lastStatus).toBe("ok");
    expect(updated?.state.lastRunAtMs).toBe(Date.parse("2025-12-13T17:00:00.000Z"));

    cron.stop();
    await store.cleanup();
  });

  it("recomputes stale future nextRunAtMs on restart after extended downtime", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    // Simulate extended downtime: job was last run Feb 6 20:00 UTC,
    // nextRunAtMs was persisted as Feb 8 14:00 UTC (incorrectly far future).
    // Gateway restarts at Feb 7 10:00 UTC.
    // Cron expression: 0 8,11,14,17,20 * * * (runs at 08:00,11:00,14:00,17:00,20:00 daily)
    vi.setSystemTime(new Date("2025-12-14T10:00:00.000Z")); // restart time

    const staleNextRun = Date.parse("2025-12-16T14:00:00.000Z"); // incorrectly far future
    const lastRunAt = Date.parse("2025-12-13T20:00:00.000Z");

    await fs.mkdir(path.dirname(store.storePath), { recursive: true });
    await fs.writeFile(
      store.storePath,
      JSON.stringify(
        {
          version: 1,
          jobs: [
            {
              id: "stale-future-job",
              name: "trend scout",
              enabled: true,
              createdAtMs: Date.parse("2025-12-10T12:00:00.000Z"),
              updatedAtMs: Date.parse("2025-12-13T20:00:00.000Z"),
              schedule: { kind: "cron", expr: "0 8,11,14,17,20 * * *", tz: "UTC" },
              sessionTarget: "main",
              wakeMode: "next-heartbeat",
              payload: { kind: "systemEvent", text: "trend search" },
              state: {
                nextRunAtMs: staleNextRun,
                lastRunAtMs: lastRunAt,
                lastStatus: "ok",
              },
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" })),
    });

    await cron.start();

    const jobs = await cron.list({ includeDisabled: true });
    const updated = jobs.find((job) => job.id === "stale-future-job");

    // nextRunAtMs should be recomputed to the next occurrence from now
    // (Dec 14 11:00 UTC), not the stale Dec 16 14:00 UTC value
    expect(updated?.state.nextRunAtMs).toBeLessThan(staleNextRun);
    expect(updated?.state.nextRunAtMs).toBe(Date.parse("2025-12-14T11:00:00.000Z"));

    cron.stop();
    await store.cleanup();
  });
});
