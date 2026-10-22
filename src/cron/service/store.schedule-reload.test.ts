import { expect, it, vi } from "vitest";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import {
  createCronServiceWithStateForTest,
  setupCronServiceSuite,
} from "../service.test-harness.js";
import { loadCronStore, saveCronStore } from "../store.js";
import type { CronJob, CronJobPatch } from "../types.js";
import { findJobOrThrow } from "./jobs-scheduling.js";
import { recomputeUnownedCronSchedules } from "./schedule-maintenance.js";
import { ensureLoaded } from "./store.js";

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "cron-store-schedule-reload" });

const STORE_TEST_NOW = Date.parse("2026-03-23T12:00:00.000Z");

async function writeSingleJobStore(storePath: string, job: CronJob) {
  await saveCronStore(storePath, { version: 1, jobs: [job] });
}

function createStoreTestService(storePath: string) {
  const onEvent = vi.fn();
  return {
    ...createCronServiceWithStateForTest({
      scheduler: createTestGatewayScheduler(),
      storePath,
      cronEnabled: true,
      defaultAgentId: "main",
      log: logger,
      nowMs: () => STORE_TEST_NOW,
      enqueueSystemEvent: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      onEvent,
    }),
    onEvent,
  };
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
  patch: CronJobPatch;
  nextRunAtMs: number;
};

it.each<ReloadCase>([
  {
    name: "cron expression",
    patch: { schedule: { kind: "cron", expr: "30 6 * * 0,6", tz: "UTC" } },
    nextRunAtMs: Date.parse("2026-03-28T06:30:00.000Z"),
  },
  {
    name: "pacing",
    initial: {
      pacing: { max: "4h" },
      state: { nextRunAtMs: staleNextRunAtMs, pacedNextRunAtMs: staleNextRunAtMs },
    },
    patch: { pacing: { max: "2h" } },
    nextRunAtMs: Date.parse("2026-03-24T06:00:00.000Z"),
  },
  {
    name: "every anchor",
    initial: { schedule: { kind: "every", everyMs: 60_000, anchorMs: STORE_TEST_NOW - 60_000 } },
    patch: { schedule: { kind: "every", everyMs: 60_000, anchorMs: STORE_TEST_NOW } },
    nextRunAtMs: STORE_TEST_NOW + 60_000,
  },
  {
    name: "one-shot target",
    initial: {
      schedule: { kind: "at", at: "2026-03-23T13:00:00.000Z" },
      state: { nextRunAtMs: staleNextRunAtMs, forcePreservedNextRunAtMs: staleNextRunAtMs },
    },
    patch: { schedule: { kind: "at", at: "2026-03-23T14:00:00.000Z" } },
    nextRunAtMs: Date.parse("2026-03-23T14:00:00.000Z"),
  },
])(
  "commits $name with its matching next-run identity before another view reloads",
  async ({ initial, patch, nextRunAtMs }) => {
    const { storePath } = await makeStorePath();
    const job = createReloadCronJob({ state: { nextRunAtMs: staleNextRunAtMs }, ...initial });
    await writeSingleJobStore(storePath, job);
    const writer = createStoreTestService(storePath);
    const observer = createStoreTestService(storePath);
    for (const { state } of [writer, observer]) {
      await ensureLoaded(state);
      expect(findJobOrThrow(state, job.id).state.nextRunAtMs).toBe(job.state.nextRunAtMs);
    }

    const updated = await writer.cron.update(job.id, patch);
    await ensureLoaded(observer.state);
    const persisted = (await loadCronStore(storePath)).jobs[0];
    for (const result of [updated, findJobOrThrow(observer.state, job.id), persisted]) {
      expect(result?.schedule).toEqual(patch.schedule ?? job.schedule);
      expect(result?.pacing).toEqual(patch.pacing ?? job.pacing);
      expect(result?.state.nextRunAtMs).toBe(nextRunAtMs);
      expect(result?.state.pacedNextRunAtMs).toBeUndefined();
      expect(result?.state.forcePreservedNextRunAtMs).toBeUndefined();
    }
    expect(observer.state.durableNextRunAtMsByJobId.get(job.id)).toBe(nextRunAtMs);
    expect(writer.onEvent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ action: "updated", jobId: job.id, nextRunAtMs }),
    );
    expect(observer.onEvent).not.toHaveBeenCalled();

    await recomputeUnownedCronSchedules(observer.state);
    expect(findJobOrThrow(observer.state, job.id).state.nextRunAtMs).toBe(nextRunAtMs);
    expect(observer.onEvent).not.toHaveBeenCalled();
  },
);

it.each<{
  name: string;
  initial: Partial<CronJob>;
  replacement: Partial<CronJob>;
  nextRunAtMs: number;
}>([
  {
    name: "schedule key order only",
    initial: { state: { nextRunAtMs: dueNextRunAtMs } },
    replacement: { schedule: { expr: "0 6 * * *", kind: "cron", tz: "UTC" } },
    nextRunAtMs: dueNextRunAtMs,
  },
  {
    name: "runtime state only",
    initial: {},
    replacement: { state: { nextRunAtMs: staleNextRunAtMs + 60_000 } },
    nextRunAtMs: staleNextRunAtMs + 60_000,
  },
])("reloads a $name snapshot without changing its deadline", async (testCase) => {
  const { storePath } = await makeStorePath();
  const job = createReloadCronJob({
    state: { nextRunAtMs: staleNextRunAtMs },
    ...testCase.initial,
  });
  await writeSingleJobStore(storePath, job);
  const { state, onEvent } = createStoreTestService(storePath);
  await ensureLoaded(state);

  const updated = { ...job, updatedAtMs: STORE_TEST_NOW, ...testCase.replacement };
  await writeSingleJobStore(storePath, updated);
  await ensureLoaded(state, { forceReload: true });

  const reloaded = findJobOrThrow(state, job.id);
  expect(reloaded.schedule).toEqual(updated.schedule);
  expect(reloaded.state.nextRunAtMs).toBe(testCase.nextRunAtMs);
  expect(reloaded.state.pacedNextRunAtMs).toBeUndefined();
  expect(reloaded.state.forcePreservedNextRunAtMs).toBeUndefined();
  expect(state.durableNextRunAtMsByJobId.get(job.id)).toBe(testCase.nextRunAtMs);
  expect((await loadCronStore(storePath)).jobs[0]?.state.nextRunAtMs).toBe(testCase.nextRunAtMs);
  expect(onEvent).not.toHaveBeenCalled();
});

it.each([
  { oneShot: false, enabled: true },
  { oneShot: true, enabled: true },
  { oneShot: true, enabled: false },
])(
  "commits enablement and retains the authored one-shot across views ($oneShot, $enabled)",
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
    const writer = createStoreTestService(storePath);
    const observer = createStoreTestService(storePath);
    await ensureLoaded(writer.state);
    await ensureLoaded(observer.state);

    const updated = await writer.cron.update(job.id, { enabled: !enabled });
    await ensureLoaded(observer.state);

    const nextRunAtMs = oneShot && !enabled ? occurrenceAtMs : undefined;
    const persisted = (await loadCronStore(storePath)).jobs[0];
    for (const result of [updated, findJobOrThrow(observer.state, job.id), persisted]) {
      expect(result?.enabled).toBe(!enabled);
      expect(result?.state.nextRunAtMs).toBe(nextRunAtMs);
      expect(result?.state.pacedNextRunAtMs).toBeUndefined();
      expect(result?.state.forcePreservedNextRunAtMs).toBe(oneShot ? occurrenceAtMs : undefined);
    }
    expect(writer.onEvent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ action: "updated", jobId: job.id, nextRunAtMs }),
    );
    expect(observer.onEvent).not.toHaveBeenCalled();

    await recomputeUnownedCronSchedules(observer.state, { recomputeExpired: true });
    const maintained = findJobOrThrow(observer.state, job.id);
    expect(maintained.state.nextRunAtMs).toBe(nextRunAtMs);
    expect(maintained.state.forcePreservedNextRunAtMs).toBe(oneShot ? occurrenceAtMs : undefined);
    expect(observer.onEvent).not.toHaveBeenCalled();
  },
);
