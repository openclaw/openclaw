import { expect, it, vi } from "vitest";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { setupCronServiceSuite } from "../service.test-harness.js";
import { loadCronStore, saveCronStore } from "../store.js";
import type { CronJob } from "../types.js";
import { findJobOrThrow, recomputeNextRunsForMaintenance } from "./jobs-scheduling.js";
import { recomputeUnownedCronSchedules } from "./schedule-maintenance.js";
import { createCronServiceState } from "./state.js";
import { ensureLoaded } from "./store.js";

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
    enqueueSessionEvent: vi.fn(),
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
const staleNextRunAtMs = STORE_TEST_NOW + 3_600_000;
const dueNextRunAtMs = STORE_TEST_NOW - 1_000;

type ReloadCase = {
  name: string;
  initial?: Partial<CronJob>;
  replacement: Partial<CronJob>;
  nextRunAtMs?: number;
  recomputedAtMs?: number;
};

it.each<ReloadCase>([
  {
    name: "cron expression",
    replacement: { schedule: { kind: "cron", expr: "30 6 * * 0,6", tz: "UTC" } },
    recomputedAtMs: Date.parse("2026-03-28T06:30:00.000Z"),
  },
  {
    name: "pacing",
    initial: {
      pacing: { max: "4h" },
      state: { nextRunAtMs: staleNextRunAtMs, pacedNextRunAtMs: staleNextRunAtMs },
    },
    replacement: { pacing: { max: "2h" } },
  },
  {
    name: "schedule key order only",
    initial: { state: { nextRunAtMs: dueNextRunAtMs } },
    replacement: { schedule: { expr: "0 6 * * *", kind: "cron", tz: "UTC" } },
    nextRunAtMs: dueNextRunAtMs,
  },
  {
    name: "runtime state only",
    replacement: { state: { nextRunAtMs: staleNextRunAtMs + 60_000 } },
    nextRunAtMs: staleNextRunAtMs + 60_000,
  },
  {
    name: "every anchor",
    initial: { schedule: { kind: "every", everyMs: 60_000, anchorMs: STORE_TEST_NOW - 60_000 } },
    replacement: { schedule: { kind: "every", everyMs: 60_000, anchorMs: STORE_TEST_NOW } },
  },
  {
    name: "one-shot target",
    initial: {
      schedule: { kind: "at", at: "2026-03-23T13:00:00.000Z" },
      state: { nextRunAtMs: staleNextRunAtMs, forcePreservedNextRunAtMs: staleNextRunAtMs },
    },
    replacement: { schedule: { kind: "at", at: "2026-03-23T14:00:00.000Z" } },
  },
])(
  "reloads $name with the matching next-run identity",
  async ({ initial, replacement, nextRunAtMs, recomputedAtMs }) => {
    const { storePath } = await makeStorePath();
    const job = createReloadCronJob({ state: { nextRunAtMs: staleNextRunAtMs }, ...initial });
    await writeSingleJobStore(storePath, job);
    const onEvent = vi.fn();
    const state = createStoreTestState(storePath, onEvent);
    await ensureLoaded(state);
    expect(findJobOrThrow(state, job.id).state.nextRunAtMs).toBe(job.state.nextRunAtMs);

    const updated = { ...job, updatedAtMs: STORE_TEST_NOW, ...replacement };
    await writeSingleJobStore(storePath, updated);
    await ensureLoaded(state, { forceReload: true });

    const reloaded = findJobOrThrow(state, job.id);
    expect(reloaded.schedule).toEqual(updated.schedule);
    expect(reloaded.state.nextRunAtMs).toBe(nextRunAtMs);
    expect(reloaded.state.pacedNextRunAtMs).toBeUndefined();
    expect(reloaded.state.forcePreservedNextRunAtMs).toBeUndefined();
    expect(onEvent).not.toHaveBeenCalled();
    expect(state.durableNextRunAtMsByJobId.get(job.id)).toBe(updated.state.nextRunAtMs);
    if (recomputedAtMs !== undefined) {
      await recomputeUnownedCronSchedules(state);
      expect((await loadCronStore(storePath)).jobs[0]?.state.nextRunAtMs).toBe(recomputedAtMs);
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "scheduled",
          jobId: job.id,
          nextRunAtMs: recomputedAtMs,
        }),
      );
    }
  },
);

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
      ...(oneShot ? { schedule: { kind: "at", at: new Date(occurrenceAtMs).toISOString() } } : {}),
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
