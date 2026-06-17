import { describe, expect, it, vi } from "vitest";
import { setupCronServiceSuite } from "./service.test-harness.js";
import { list, start } from "./service/ops.js";
import { createCronServiceState } from "./service/state.js";
import { saveCronStore } from "./store.js";
import type { CronJob } from "./types.js";

const { logger: noopLogger, makeStorePath } = setupCronServiceSuite({
  prefix: "openclaw-cron-overflow-",
  baseTimeIso: "2025-12-13T17:00:00.000Z",
});

describe("CronService startup catch-up repair scoping", () => {
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

  it("keeps the overflow daily-cron catch-up deferral after start()'s maintenance pass", async () => {
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

    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => startNow,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await start(state);

    const deferred = state.store?.jobs.find((job) => job.id === "daily-overflow");

    expect(deferred?.state.nextRunAtMs).toBe(startNow + 5_000);
    expect(deferred?.state.nextRunAtMs).not.toBe(tomorrowNaturalSlot);

    state.stopped = true;
    await store.cleanup();
  });

  it("still repairs a stale future cron slot on start() when no jobs were deferred", async () => {
    const store = await makeStorePath();
    const startNow = Date.parse("2025-12-13T17:00:00.000Z");
    const staleFutureSlot = Date.parse("2025-12-13T18:00:00.000Z");
    const naturalSlot = Date.parse("2025-12-14T09:00:00.000Z");

    await saveCronStore(store.storePath, {
      version: 1,
      jobs: [createDailyCronJob("daily-stale-future", staleFutureSlot)],
    });

    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => startNow,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await start(state);

    const repaired = state.store?.jobs.find((job) => job.id === "daily-stale-future");

    expect(repaired?.state.nextRunAtMs).toBe(naturalSlot);
    expect(repaired?.state.nextRunAtMs).not.toBe(staleFutureSlot);

    state.stopped = true;
    await store.cleanup();
  });

  it("preserves overflow daily-cron catch-up deferral after list() read RPC (regression #93935)", async () => {
    const store = await makeStorePath();
    const startNow = Date.parse("2025-12-13T17:00:00.000Z");
    const tomorrowNaturalSlot = Date.parse("2025-12-14T09:00:00.000Z");
    const deferredSlot = startNow + 5_000;

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

    // Use mutable clock so we can advance time without a fresh state reload
    let currentNow = startNow;
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => currentNow,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await start(state);

    // After start(), the daily overflow should be deferred to the staggered slot
    const afterStart = state.store?.jobs.find((job) => job.id === "daily-overflow");
    expect(afterStart?.state.nextRunAtMs).toBe(deferredSlot);
    expect(state.pendingCatchupDeferralJobIds.has("daily-overflow")).toBe(true);

    // Advance clock slightly (still before deferred slot fires), then call
    // list() which triggers ensureLoadedForRead → recomputeNextRunsForMaintenance.
    // Previously this would clobber the deferral (the bug).
    currentNow = startNow + 1_000;
    await list(state);

    const afterList = state.store?.jobs.find((job) => job.id === "daily-overflow");
    // The deferred staggered slot must be preserved (not advanced to natural slot)
    expect(afterList?.state.nextRunAtMs).toBe(deferredSlot);
    expect(afterList?.state.nextRunAtMs).not.toBe(tomorrowNaturalSlot);
    // The pending set still tracks the deferred job
    expect(state.pendingCatchupDeferralJobIds.has("daily-overflow")).toBe(true);

    state.stopped = true;
    await store.cleanup();
  });

  it("auto-clears pendingCatchupDeferralJobIds when the staggered slot is reached", async () => {
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

    let currentNow = startNow;
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => currentNow,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await start(state);

    // After start(), the pending set should contain the deferred job
    expect(state.pendingCatchupDeferralJobIds.has("daily-overflow")).toBe(true);

    // Advance clock past the deferred slot and trigger a recompute
    currentNow = startNow + 6_000;
    const { recomputeNextRunsForMaintenance } = await import("./service/jobs.js");
    recomputeNextRunsForMaintenance(state, { recomputeExpired: true });

    // The id should be auto-cleared since the slot is reached
    expect(state.pendingCatchupDeferralJobIds.has("daily-overflow")).toBe(false);

    state.stopped = true;
    await store.cleanup();
  });
});
