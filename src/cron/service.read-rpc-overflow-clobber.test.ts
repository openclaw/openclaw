import { describe, expect, it, vi } from "vitest";
import { setupCronServiceSuite } from "./service.test-harness.js";
import { list, readJob, start, status } from "./service/ops.js";
import { createCronServiceState } from "./service/state.js";
import { saveCronStore } from "./store.js";
import type { CronJob } from "./types.js";

const { logger: noopLogger, makeStorePath } = setupCronServiceSuite({
  prefix: "openclaw-cron-read-overflow-",
  baseTimeIso: "2025-12-13T17:00:00.000Z",
});

describe("CronService read-RPC overflow deferral clobber", () => {
  function createHourlyCronJob(id: string, nextRunAtMs: number): CronJob {
    return {
      id,
      name: `job-${id}`,
      enabled: true,
      createdAtMs: nextRunAtMs - 60_000,
      updatedAtMs: nextRunAtMs - 60_000,
      schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: `tick-${id}` },
      state: { nextRunAtMs },
    };
  }

  function createDailyCronJob(id: string, nextRunAtMs: number): CronJob {
    return {
      id,
      name: `job-${id}`,
      enabled: true,
      createdAtMs: nextRunAtMs - 60_000,
      updatedAtMs: nextRunAtMs - 60_000,
      schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: `tick-${id}` },
      state: { nextRunAtMs },
    };
  }

  function buildState(storePath: string, startNow: number) {
    return createCronServiceState({
      cronEnabled: true,
      storePath,
      log: noopLogger,
      nowMs: () => startNow,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
  }

  it("preserves the overflow daily-cron catch-up deferral across a read RPC after start()", async () => {
    const store = await makeStorePath();
    const startNow = Date.parse("2025-12-13T17:00:00.000Z");
    const tomorrowNaturalSlot = Date.parse("2025-12-14T09:00:00.000Z");

    await saveCronStore(store.storePath, {
      version: 1,
      jobs: [
        createHourlyCronJob("hourly-0", Date.parse("2025-12-13T03:00:00.000Z")),
        createHourlyCronJob("hourly-1", Date.parse("2025-12-13T04:00:00.000Z")),
        createHourlyCronJob("hourly-2", Date.parse("2025-12-13T05:00:00.000Z")),
        createHourlyCronJob("hourly-3", Date.parse("2025-12-13T06:00:00.000Z")),
        createHourlyCronJob("hourly-4", Date.parse("2025-12-13T07:00:00.000Z")),
        createDailyCronJob("daily-overflow", Date.parse("2025-12-13T09:00:00.000Z")),
      ],
    });

    const state = buildState(store.storePath, startNow);

    await start(state);

    const afterStart = state.store?.jobs.find((j) => j.id === "daily-overflow");
    expect(afterStart?.state.nextRunAtMs).toBe(startNow + 5_000);

    await list(state);

    const afterList = state.store?.jobs.find((j) => j.id === "daily-overflow");
    expect(afterList?.state.nextRunAtMs).toBe(startNow + 5_000);
    expect(afterList?.state.nextRunAtMs).not.toBe(tomorrowNaturalSlot);

    state.stopped = true;
    await store.cleanup();
  });

  it("also preserves the deferral across status() and readJob()", async () => {
    const store = await makeStorePath();
    const startNow = Date.parse("2025-12-13T17:00:00.000Z");

    await saveCronStore(store.storePath, {
      version: 1,
      jobs: [
        createHourlyCronJob("hourly-0", Date.parse("2025-12-13T03:00:00.000Z")),
        createHourlyCronJob("hourly-1", Date.parse("2025-12-13T04:00:00.000Z")),
        createHourlyCronJob("hourly-2", Date.parse("2025-12-13T05:00:00.000Z")),
        createHourlyCronJob("hourly-3", Date.parse("2025-12-13T06:00:00.000Z")),
        createHourlyCronJob("hourly-4", Date.parse("2025-12-13T07:00:00.000Z")),
        createDailyCronJob("daily-overflow", Date.parse("2025-12-13T09:00:00.000Z")),
      ],
    });

    const state = buildState(store.storePath, startNow);
    await start(state);

    await status(state);
    await readJob(state, "daily-overflow");

    const after = state.store?.jobs.find((j) => j.id === "daily-overflow");
    expect(after?.state.nextRunAtMs).toBe(startNow + 5_000);

    state.stopped = true;
    await store.cleanup();
  });
});
