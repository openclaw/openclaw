import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import {
  createStartedCronServiceWithFinishedBarrier,
  createCronStoreHarness,
  createNoopLogger,
  installCronTestHooks,
} from "./service.test-harness.js";

const noopLogger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness();
installCronTestHooks({ logger: noopLogger });

describe("CronService interval/cron jobs fire on time", () => {
  it("fires an every-type main job when the timer fires a few ms late", async () => {
    const store = await makeStorePath();
    const { cron, enqueueSystemEvent, finished } = createStartedCronServiceWithFinishedBarrier({
      storePath: store.storePath,
      logger: noopLogger,
    });

    await cron.start();
    const job = await cron.add({
      name: "every 10s check",
      enabled: true,
      schedule: { kind: "every", everyMs: 10_000 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "tick" },
    });

    const firstDueAt = job.state.nextRunAtMs!;
    expect(firstDueAt).toBe(Date.parse("2025-12-13T00:00:00.000Z") + 10_000);

    // Simulate setTimeout firing 5ms late (the race condition).
    vi.setSystemTime(new Date(firstDueAt + 5));
    await vi.runOnlyPendingTimersAsync();

    await finished.waitForOk(job.id);
    const jobs = await cron.list({ includeDisabled: true });
    const updated = jobs.find((current) => current.id === job.id);

    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      "tick",
      expect.objectContaining({ agentId: undefined }),
    );
    expect(updated?.state.lastStatus).toBe("ok");
    // nextRunAtMs must advance by at least one full interval past the due time.
    expect(updated?.state.nextRunAtMs).toBeGreaterThanOrEqual(firstDueAt + 10_000);

    cron.stop();
    await store.cleanup();
  });

  it("fires a cron-expression job when the timer fires a few ms late", async () => {
    const store = await makeStorePath();
    const { cron, enqueueSystemEvent, finished } = createStartedCronServiceWithFinishedBarrier({
      storePath: store.storePath,
      logger: noopLogger,
    });

    // Set time to just before a minute boundary.
    vi.setSystemTime(new Date("2025-12-13T00:00:59.000Z"));

    await cron.start();
    const job = await cron.add({
      name: "every minute check",
      enabled: true,
      schedule: { kind: "cron", expr: "* * * * *" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "cron-tick" },
    });

    const firstDueAt = job.state.nextRunAtMs!;

    // Simulate setTimeout firing 5ms late.
    vi.setSystemTime(new Date(firstDueAt + 5));
    await vi.runOnlyPendingTimersAsync();

    await finished.waitForOk(job.id);
    const jobs = await cron.list({ includeDisabled: true });
    const updated = jobs.find((current) => current.id === job.id);

    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      "cron-tick",
      expect.objectContaining({ agentId: undefined }),
    );
    expect(updated?.state.lastStatus).toBe("ok");
    // nextRunAtMs should be the next whole-minute boundary (60s later).
    expect(updated?.state.nextRunAtMs).toBe(firstDueAt + 60_000);

    cron.stop();
    await store.cleanup();
  });

  it("keeps legacy every jobs due while minute cron jobs recompute schedules", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    const nowMs = Date.parse("2025-12-13T00:00:00.000Z");

    await fs.mkdir(path.dirname(store.storePath), { recursive: true });
    await fs.writeFile(
      store.storePath,
      JSON.stringify(
        {
          version: 1,
          jobs: [
            {
              id: "legacy-every",
              name: "legacy every",
              enabled: true,
              createdAtMs: nowMs,
              updatedAtMs: nowMs,
              schedule: { kind: "every", everyMs: 120_000 },
              sessionTarget: "main",
              wakeMode: "now",
              payload: { kind: "systemEvent", text: "sf-tick" },
              state: { nextRunAtMs: nowMs + 120_000 },
            },
            {
              id: "minute-cron",
              name: "minute cron",
              enabled: true,
              createdAtMs: nowMs,
              updatedAtMs: nowMs,
              schedule: { kind: "cron", expr: "* * * * *", tz: "UTC" },
              sessionTarget: "main",
              wakeMode: "now",
              payload: { kind: "systemEvent", text: "minute-tick" },
              state: { nextRunAtMs: nowMs + 60_000 },
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
    // Perf: a few recomputation cycles are enough to catch legacy "every" drift.
    for (let minute = 1; minute <= 3; minute++) {
      vi.setSystemTime(new Date(nowMs + minute * 60_000));
      const minuteRun = await cron.run("minute-cron", "force");
      expect(minuteRun).toEqual({ ok: true, ran: true });
    }

    // "every" cadence is 2m; verify it stays due at the 6-minute boundary.
    vi.setSystemTime(new Date(nowMs + 6 * 60_000));
    const sfRun = await cron.run("legacy-every", "due");
    expect(sfRun).toEqual({ ok: true, ran: true });

    const sfRuns = enqueueSystemEvent.mock.calls.filter((args) => args[0] === "sf-tick").length;
    const minuteRuns = enqueueSystemEvent.mock.calls.filter(
      (args) => args[0] === "minute-tick",
    ).length;
    expect(minuteRuns).toBeGreaterThan(0);
    expect(sfRuns).toBeGreaterThan(0);

    const jobs = await cron.list({ includeDisabled: true });
    const sfJob = jobs.find((job) => job.id === "legacy-every");
    expect(sfJob?.state.lastStatus).toBe("ok");
    expect(sfJob?.schedule.kind).toBe("every");
    if (sfJob?.schedule.kind === "every") {
      expect(sfJob.schedule.anchorMs).toBe(nowMs);
    }

    cron.stop();
    await store.cleanup();
  });
});
