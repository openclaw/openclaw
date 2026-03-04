import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import { setupCronServiceSuite } from "./service.test-harness.js";

const { logger: noopLogger, makeStorePath } = setupCronServiceSuite({
  prefix: "openclaw-cron-",
  baseTimeIso: "2025-12-13T17:00:00.000Z",
});

describe("CronService restart catch-up", () => {
  async function writeStoreJobs(storePath: string, jobs: unknown[]) {
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, JSON.stringify({ version: 1, jobs }, null, 2), "utf-8");
  }

  function createRestartCronService(params: {
    storePath: string;
    enqueueSystemEvent: ReturnType<typeof vi.fn>;
    requestHeartbeatNow: ReturnType<typeof vi.fn>;
  }) {
    return new CronService({
      storePath: params.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: params.enqueueSystemEvent as never,
      requestHeartbeatNow: params.requestHeartbeatNow as never,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })) as never,
    });
  }

  it("executes an overdue recurring job immediately on start", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    const dueAt = Date.parse("2025-12-13T15:00:00.000Z");
    const lastRunAt = Date.parse("2025-12-12T15:00:00.000Z");

    await writeStoreJobs(store.storePath, [
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
    ]);

    const cron = createRestartCronService({
      storePath: store.storePath,
      enqueueSystemEvent,
      requestHeartbeatNow,
    });

    await cron.start();

    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      "digest now",
      expect.objectContaining({ agentId: undefined }),
    );
    expect(requestHeartbeatNow).toHaveBeenCalled();

    const jobs = await cron.list({ includeDisabled: true });
    const updated = jobs.find((job) => job.id === "restart-overdue-job");
    expect(updated?.state.lastStatus).toBe("ok");
    expect(updated?.state.lastRunAtMs).toBe(Date.parse("2025-12-13T17:00:00.000Z"));
    expect(updated?.state.nextRunAtMs).toBeGreaterThan(Date.parse("2025-12-13T17:00:00.000Z"));

    cron.stop();
    await store.cleanup();
  });

  it("schedules interrupted past-due jobs for immediate timer pickup instead of silently advancing (#34432)", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    const dueAt = Date.parse("2025-12-13T16:00:00.000Z");
    const staleRunningAt = Date.parse("2025-12-13T16:30:00.000Z");

    await writeStoreJobs(store.storePath, [
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
    ]);

    const cron = createRestartCronService({
      storePath: store.storePath,
      enqueueSystemEvent,
      requestHeartbeatNow,
    });

    await cron.start();

    // The stale running marker should be cleared on startup.
    expect(noopLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "restart-stale-running" }),
      "cron: clearing stale running marker on startup",
    );

    // runMissedJobs skips interrupted jobs to avoid duplicates during
    // overlapping restarts, so the job should NOT have been executed yet.
    expect(enqueueSystemEvent).not.toHaveBeenCalled();

    // However, nextRunAtMs must be set to "now" (not silently advanced to
    // the next occurrence) so the timer picks it up immediately (#34432).
    const jobs = await cron.list({ includeDisabled: true });
    const updated = jobs.find((job) => job.id === "restart-stale-running");
    expect(updated?.state.runningAtMs).toBeUndefined();
    // nextRunAtMs should be set to "now" (17:00:00 fake time), not advanced
    // to the next cron occurrence (which would be 16:00 tomorrow).
    expect(updated?.state.nextRunAtMs).toBe(Date.parse("2025-12-13T17:00:00.000Z"));

    cron.stop();
    await store.cleanup();
  });
});
