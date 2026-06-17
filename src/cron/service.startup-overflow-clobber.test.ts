import { describe, expect, it, vi } from "vitest";
import { setupCronServiceSuite } from "./service.test-harness.js";
import { recomputeNextRunsForMaintenance } from "./service/jobs.js";
import { start } from "./service/ops.js";
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

  it("preserves a deferred catch-up slot when state.pendingCatchupDeferralJobIds is set and no explicit skip is passed", async () => {
    const store = await makeStorePath();
    const startNow = Date.parse("2025-12-13T17:00:00.000Z");
    const deferredSlot = startNow + 5_000;
    const naturalSlot = Date.parse("2025-12-14T09:00:00.000Z");

    // Simulate a daily job whose nextRunAtMs was set to a staggered catch-up slot
    // (earlier than the natural slot, which would normally trigger repair).
    await saveCronStore(store.storePath, {
      version: 1,
      jobs: [createDailyCronJob("daily-deferred", deferredSlot)],
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

    // Load the store without recompute first
    await start(state);
    state.stopped = true;

    // Reset for the read-path test: set deferred slot and pending set
    const store2 = await makeStorePath();
    await saveCronStore(store2.storePath, {
      version: 1,
      jobs: [createDailyCronJob("daily-readclobber", deferredSlot)],
    });

    const state2 = createCronServiceState({
      cronEnabled: true,
      storePath: store2.storePath,
      log: noopLogger,
      nowMs: () => startNow,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    // Simulate start()'s deferral: populate pendingCatchupDeferralJobIds on state
    state2.pendingCatchupDeferralJobIds = new Set(["daily-readclobber"]);

    // Load the store
    const { ensureLoaded } = await import("./service/store.js");
    await ensureLoaded(state2, { skipRecompute: true });
    if (!state2.store) {
      throw new Error("store not loaded");
    }

    // Call recompute WITHOUT explicit skipFutureRepairJobIds — the read-path scenario
    recomputeNextRunsForMaintenance(state2);

    const job = state2.store?.jobs.find((j) => j.id === "daily-readclobber");
    expect(job?.state.nextRunAtMs).toBe(deferredSlot);
    expect(job?.state.nextRunAtMs).not.toBe(naturalSlot);

    state2.stopped = true;
    await store.cleanup();
    await store2.cleanup();
  });

  it("still repairs a stale future cron slot when state.pendingCatchupDeferralJobIds is unset", async () => {
    const store = await makeStorePath();
    const startNow = Date.parse("2025-12-13T17:00:00.000Z");
    const staleSlot = Date.parse("2025-12-13T18:00:00.000Z");
    const naturalSlot = Date.parse("2025-12-14T09:00:00.000Z");

    await saveCronStore(store.storePath, {
      version: 1,
      jobs: [createDailyCronJob("daily-stale", staleSlot)],
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

    // No pendingCatchupDeferralJobIds set — repair should proceed
    const { ensureLoaded } = await import("./service/store.js");
    await ensureLoaded(state, { skipRecompute: true });
    if (!state.store) {
      throw new Error("store not loaded");
    }

    recomputeNextRunsForMaintenance(state);

    const job = state.store?.jobs.find((j) => j.id === "daily-stale");
    expect(job?.state.nextRunAtMs).toBe(naturalSlot);
    expect(job?.state.nextRunAtMs).not.toBe(staleSlot);

    state.stopped = true;
    await store.cleanup();
  });
});
