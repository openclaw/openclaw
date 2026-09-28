import { describe, expect, it, vi } from "vitest";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { setupCronServiceSuite } from "../service.test-harness.js";
import { saveCronStore } from "../store.js";
import type { CronJob } from "../types.js";
import { findJobOrThrow, recomputeNextRunsForMaintenance } from "./jobs-scheduling.js";
import { createCronServiceState } from "./state.js";
import { ensureLoaded, persist } from "./store.js";

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "cron-store-schedule-reload" });

const STORE_TEST_NOW = Date.parse("2026-03-23T12:00:00.000Z");

async function writeSingleJobStore(storePath: string, job: CronJob) {
  await saveCronStore(storePath, { version: 1, jobs: [job] });
}

function createStoreTestState(storePath: string, onEvent = vi.fn()) {
  return createCronServiceState({
    scheduler: createTestGatewayScheduler(),
    storePath,
    cronEnabled: true,
    log: logger,
    nowMs: () => STORE_TEST_NOW,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    onEvent,
  });
}

function createReloadCronJob(params?: Partial<CronJob>): CronJob {
  return {
    id: "reload-cron-expr-job",
    name: "reload cron expr job",
    enabled: true,
    createdAtMs: STORE_TEST_NOW - 60_000,
    updatedAtMs: STORE_TEST_NOW - 60_000,
    schedule: { kind: "cron", expr: "0 6 * * *", tz: "UTC" },
    sessionTarget: "main",
    wakeMode: "now",
    payload: { kind: "systemEvent", text: "tick" },
    state: {},
    ...params,
  };
}
describe("cron service schedule reload", () => {
  it("clears stale nextRunAtMs after force reload when cron schedule expression changes", async () => {
    const { storePath } = await makeStorePath();
    const staleNextRunAtMs = STORE_TEST_NOW + 3_600_000;

    await saveCronStore(storePath, {
      version: 1,
      jobs: [
        createReloadCronJob({
          state: { nextRunAtMs: staleNextRunAtMs },
        }),
      ],
    });

    const onEvent = vi.fn();
    const state = createStoreTestState(storePath, onEvent);
    await ensureLoaded(state);
    expect(findJobOrThrow(state, "reload-cron-expr-job").state.nextRunAtMs).toBe(staleNextRunAtMs);

    await saveCronStore(storePath, {
      version: 1,
      jobs: [
        createReloadCronJob({
          updatedAtMs: STORE_TEST_NOW - 30_000,
          schedule: { kind: "cron", expr: "30 6 * * 0,6", tz: "UTC" },
          state: { nextRunAtMs: staleNextRunAtMs },
        }),
      ],
    });

    await ensureLoaded(state, { forceReload: true });

    const reloadedJob = findJobOrThrow(state, "reload-cron-expr-job");
    expect(reloadedJob.schedule).toEqual({ kind: "cron", expr: "30 6 * * 0,6", tz: "UTC" });
    expect(reloadedJob.state.nextRunAtMs).toBeUndefined();
    expect(onEvent).not.toHaveBeenCalled();
    expect(state.durableNextRunAtMsByJobId.get(reloadedJob.id)).toBe(staleNextRunAtMs);

    await persist(state);

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "scheduled",
        jobId: reloadedJob.id,
        nextRunAtMs: undefined,
      }),
    );
  });

  it("clears a paced slot and its provenance after force reload changes pacing", async () => {
    const { storePath } = await makeStorePath();
    const staleNextRunAtMs = STORE_TEST_NOW + 3_600_000;

    await saveCronStore(storePath, {
      version: 1,
      jobs: [
        createReloadCronJob({
          pacing: { max: "4h" },
          state: {
            nextRunAtMs: staleNextRunAtMs,
            pacedNextRunAtMs: staleNextRunAtMs,
          },
        }),
      ],
    });

    const state = createStoreTestState(storePath);
    await ensureLoaded(state);
    await saveCronStore(storePath, {
      version: 1,
      jobs: [
        createReloadCronJob({
          pacing: { max: "2h" },
          updatedAtMs: STORE_TEST_NOW,
          state: {
            nextRunAtMs: staleNextRunAtMs,
            pacedNextRunAtMs: staleNextRunAtMs,
          },
        }),
      ],
    });

    await ensureLoaded(state, { forceReload: true });

    const reloadedJob = findJobOrThrow(state, "reload-cron-expr-job");
    expect(reloadedJob.state.nextRunAtMs).toBeUndefined();
    expect(reloadedJob.state.pacedNextRunAtMs).toBeUndefined();
  });

  it("preserves nextRunAtMs after force reload when cron schedule key order changes only", async () => {
    const { storePath } = await makeStorePath();
    const dueNextRunAtMs = STORE_TEST_NOW - 1_000;

    await saveCronStore(storePath, {
      version: 1,
      jobs: [
        createReloadCronJob({
          state: { nextRunAtMs: dueNextRunAtMs },
        }),
      ],
    });

    const state = createStoreTestState(storePath);
    await ensureLoaded(state);

    await saveCronStore(storePath, {
      version: 1,
      jobs: [
        createReloadCronJob({
          updatedAtMs: STORE_TEST_NOW - 30_000,
          schedule: { expr: "0 6 * * *", kind: "cron", tz: "UTC" },
          state: { nextRunAtMs: dueNextRunAtMs },
        }),
      ],
    });

    await ensureLoaded(state, { forceReload: true });

    expect(findJobOrThrow(state, "reload-cron-expr-job").state.nextRunAtMs).toBe(dueNextRunAtMs);
  });

  it("preserves nextRunAtMs after force reload when scheduling inputs are unchanged", async () => {
    const { storePath } = await makeStorePath();
    const originalNextRunAtMs = STORE_TEST_NOW + 3_600_000;

    await writeSingleJobStore(storePath, {
      ...createReloadCronJob({ state: { nextRunAtMs: originalNextRunAtMs } }),
    });

    const state = createStoreTestState(storePath);
    await ensureLoaded(state);
    await saveCronStore(storePath, {
      version: 1,
      jobs: [
        createReloadCronJob({
          updatedAtMs: STORE_TEST_NOW,
          state: { nextRunAtMs: originalNextRunAtMs + 60_000 },
        }),
      ],
    });

    await ensureLoaded(state, { forceReload: true });

    expect(findJobOrThrow(state, "reload-cron-expr-job").state.nextRunAtMs).toBe(
      originalNextRunAtMs + 60_000,
    );
  });

  it.each([
    { oneShot: false, enabled: true },
    { oneShot: true, enabled: true },
    { oneShot: true, enabled: false },
  ])(
    "invalidates slots on enablement reload and maintains the authored one-shot ($oneShot, $enabled)",
    async ({ oneShot, enabled }) => {
      const { storePath } = await makeStorePath();
      const occurrenceAtMs = STORE_TEST_NOW - 1_000;
      const job = createReloadCronJob({
        enabled,
        ...(oneShot
          ? { schedule: { kind: "at", at: new Date(occurrenceAtMs).toISOString() } }
          : {}),
        state: {
          nextRunAtMs: occurrenceAtMs,
          forcePreservedNextRunAtMs: occurrenceAtMs,
          lastRunAtMs: STORE_TEST_NOW,
          lastRunStatus: "ok",
        },
      });
      await writeSingleJobStore(storePath, job);
      const state = createStoreTestState(storePath);
      await ensureLoaded(state);
      await saveCronStore(storePath, {
        version: 1,
        jobs: [{ ...job, enabled: !enabled, updatedAtMs: STORE_TEST_NOW }],
      });

      await ensureLoaded(state, { forceReload: true });

      const reloaded = findJobOrThrow(state, job.id);
      expect(reloaded.enabled).toBe(!enabled);
      expect(reloaded.state.nextRunAtMs).toBeUndefined();
      expect(reloaded.state.forcePreservedNextRunAtMs).toBe(oneShot ? occurrenceAtMs : undefined);

      recomputeNextRunsForMaintenance(state, {
        recomputeExpired: true,
        deferredNotifications: [],
      });

      expect(reloaded.state.nextRunAtMs).toBe(oneShot && !enabled ? occurrenceAtMs : undefined);
      expect(reloaded.state.forcePreservedNextRunAtMs).toBe(oneShot ? occurrenceAtMs : undefined);
    },
  );

  it("clears stale nextRunAtMs after force reload when every schedule anchor changes", async () => {
    const { storePath } = await makeStorePath();
    const jobId = "reload-every-anchor-job";
    const staleNextRunAtMs = STORE_TEST_NOW + 3_600_000;

    await writeSingleJobStore(storePath, {
      ...createReloadCronJob({
        id: jobId,
        schedule: { kind: "every", everyMs: 60_000, anchorMs: STORE_TEST_NOW - 60_000 },
        state: { nextRunAtMs: staleNextRunAtMs },
      }),
    });

    const state = createStoreTestState(storePath);
    await ensureLoaded(state);
    await saveCronStore(storePath, {
      version: 1,
      jobs: [
        createReloadCronJob({
          id: jobId,
          updatedAtMs: STORE_TEST_NOW,
          schedule: { kind: "every", everyMs: 60_000, anchorMs: STORE_TEST_NOW },
          state: { nextRunAtMs: staleNextRunAtMs },
        }),
      ],
    });

    await ensureLoaded(state, { forceReload: true });

    expect(findJobOrThrow(state, jobId).state.nextRunAtMs).toBeUndefined();
  });

  it("clears stale nextRunAtMs after force reload when at schedule target changes", async () => {
    const { storePath } = await makeStorePath();
    const jobId = "reload-at-target-job";
    const staleNextRunAtMs = STORE_TEST_NOW + 3_600_000;

    await writeSingleJobStore(storePath, {
      ...createReloadCronJob({
        id: jobId,
        schedule: { kind: "at", at: "2026-03-23T13:00:00.000Z" },
        state: { nextRunAtMs: staleNextRunAtMs, forcePreservedNextRunAtMs: staleNextRunAtMs },
      }),
    });

    const state = createStoreTestState(storePath);
    await ensureLoaded(state);
    await saveCronStore(storePath, {
      version: 1,
      jobs: [
        createReloadCronJob({
          id: jobId,
          updatedAtMs: STORE_TEST_NOW,
          schedule: { kind: "at", at: "2026-03-23T14:00:00.000Z" },
          state: { nextRunAtMs: staleNextRunAtMs, forcePreservedNextRunAtMs: staleNextRunAtMs },
        }),
      ],
    });

    await ensureLoaded(state, { forceReload: true });

    expect(findJobOrThrow(state, jobId).state.nextRunAtMs).toBeUndefined();
    expect(findJobOrThrow(state, jobId).state.forcePreservedNextRunAtMs).toBeUndefined();
  });
});
