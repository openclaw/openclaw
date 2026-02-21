import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import {
  createCronStoreHarness,
  createNoopLogger,
  installCronTestHooks,
} from "./service.test-harness.js";

const noopLogger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness({ prefix: "openclaw-cron-22895-" });
installCronTestHooks({
  logger: noopLogger,
  baseTimeIso: "2025-12-13T17:00:00.000Z",
});

describe("CronService restart with every-30m job (#22895)", () => {
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

  it("preserves correct nextRunAtMs for every-30m job after restart (last ran 6m ago)", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    const nowMs = Date.parse("2025-12-13T17:00:00.000Z");
    const everyMs = 30 * 60 * 1000; // 30 min
    const createdAtMs = Date.parse("2025-12-10T12:00:00.000Z");
    const lastRunAtMs = nowMs - 6 * 60 * 1000; // 6 min ago

    // Compute what nextRunAtMs should have been after the last run:
    // anchor = createdAtMs, elapsed = lastRunAtMs - createdAtMs
    const elapsed = lastRunAtMs - createdAtMs;
    const steps = Math.max(1, Math.floor((elapsed + everyMs - 1) / everyMs));
    const correctNextRunAtMs = createdAtMs + steps * everyMs;

    await writeStoreJobs(store.storePath, [
      {
        id: "every-30m-job",
        name: "check-health",
        enabled: true,
        createdAtMs,
        updatedAtMs: lastRunAtMs,
        schedule: { kind: "every", everyMs, anchorMs: createdAtMs },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "health check" },
        state: {
          nextRunAtMs: correctNextRunAtMs,
          lastRunAtMs,
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

    const jobs = await cron.list({ includeDisabled: true });
    const job = jobs.find((j) => j.id === "every-30m-job");

    // The nextRunAtMs should be at most everyMs (30 min) from now
    const nextRunAtMs = job?.state.nextRunAtMs ?? 0;
    const nextInMs = nextRunAtMs - nowMs;

    console.log("correctNextRunAtMs:", new Date(correctNextRunAtMs).toISOString());
    console.log("actual nextRunAtMs:", new Date(nextRunAtMs).toISOString());
    console.log("next in:", nextInMs / 60000, "min");

    // Key assertion: next run should be <= 30 min from now, never > everyMs
    expect(nextInMs).toBeLessThanOrEqual(everyMs);
    expect(nextInMs).toBeGreaterThan(0);

    cron.stop();
    await store.cleanup();
  });

  it("handles restart when every-30m job was running (stale runningAtMs)", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    const nowMs = Date.parse("2025-12-13T17:00:00.000Z");
    const everyMs = 30 * 60 * 1000;
    const createdAtMs = Date.parse("2025-12-10T12:00:00.000Z");
    const lastRunAtMs = nowMs - 6 * 60 * 1000;

    // Job was running when gateway crashed — nextRunAtMs is the OLD (past-due) value
    const oldNextRunAtMs = lastRunAtMs; // was due when it started running

    await writeStoreJobs(store.storePath, [
      {
        id: "every-30m-stale",
        name: "stale-health",
        enabled: true,
        createdAtMs,
        updatedAtMs: lastRunAtMs,
        schedule: { kind: "every", everyMs, anchorMs: createdAtMs },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "health check" },
        state: {
          nextRunAtMs: oldNextRunAtMs,
          lastRunAtMs: lastRunAtMs - everyMs, // previous successful run
          lastStatus: "ok",
          runningAtMs: lastRunAtMs, // was running when crashed
        },
      },
    ]);

    const cron = createRestartCronService({
      storePath: store.storePath,
      enqueueSystemEvent,
      requestHeartbeatNow,
    });

    await cron.start();

    const jobs = await cron.list({ includeDisabled: true });
    const job = jobs.find((j) => j.id === "every-30m-stale");

    const nextRunAtMs = job?.state.nextRunAtMs ?? 0;
    const nextInMs = nextRunAtMs - nowMs;

    console.log("stale scenario nextRunAtMs:", new Date(nextRunAtMs).toISOString());
    console.log("stale scenario next in:", nextInMs / 60000, "min");

    // Should be cleared and recomputed correctly
    expect(job?.state.runningAtMs).toBeUndefined();
    // Next run should be <= everyMs from now
    expect(nextInMs).toBeLessThanOrEqual(everyMs);
    expect(nextInMs).toBeGreaterThan(0);

    cron.stop();
    await store.cleanup();
  });

  it("next run never exceeds everyMs from now for various anchor offsets", async () => {
    const nowMs = Date.parse("2025-12-13T17:00:00.000Z");
    const everyMs = 30 * 60 * 1000;

    // Test all possible anchor offsets (every minute within a 30-min window)
    for (let offsetMin = 0; offsetMin < 30; offsetMin++) {
      const store = await makeStorePath();
      const createdAtMs = Date.parse("2025-12-10T12:00:00.000Z") + offsetMin * 60 * 1000;
      const lastRunAtMs = nowMs - 6 * 60 * 1000;

      // Compute persisted nextRunAtMs as applyJobResult would
      const elapsed = lastRunAtMs - createdAtMs;
      const steps = Math.max(1, Math.floor((elapsed + everyMs - 1) / everyMs));
      const persistedNext = createdAtMs + steps * everyMs;

      await writeStoreJobs(store.storePath, [
        {
          id: `every-30m-offset-${offsetMin}`,
          name: `offset-${offsetMin}`,
          enabled: true,
          createdAtMs,
          updatedAtMs: lastRunAtMs,
          schedule: { kind: "every", everyMs, anchorMs: createdAtMs },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "check" },
          state: {
            nextRunAtMs: persistedNext,
            lastRunAtMs,
            lastStatus: "ok",
          },
        },
      ]);

      const cron = new CronService({
        storePath: store.storePath,
        cronEnabled: true,
        log: noopLogger,
        enqueueSystemEvent: vi.fn() as never,
        requestHeartbeatNow: vi.fn() as never,
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })) as never,
      });

      await cron.start();

      const jobs = await cron.list({ includeDisabled: true });
      const job = jobs.find((j) => j.id === `every-30m-offset-${offsetMin}`);
      const nextRunAtMs = job?.state.nextRunAtMs ?? 0;
      const nextInMs = nextRunAtMs - nowMs;

      expect(nextInMs).toBeLessThanOrEqual(everyMs);
      expect(nextInMs).toBeGreaterThanOrEqual(0);

      cron.stop();
      await store.cleanup();
    }
  });
});
