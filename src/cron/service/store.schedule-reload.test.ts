import { expect, it, vi } from "vitest";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import {
  createCronServiceWithStateForTest,
  setupCronServiceSuite,
} from "../service.test-harness.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { createReloadCronJob, STORE_TEST_NOW } from "../store.test-support.js";
import type { CronJob, CronJobPatch } from "../types.js";
import { findJobOrThrow } from "./jobs-scheduling.js";
import { recomputeUnownedCronSchedules } from "./schedule-maintenance.js";
import { ensureLoaded } from "./store.js";

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "cron-store-schedule-reload" });
const staleNextRunAtMs = STORE_TEST_NOW + 3_600_000;
const dueNextRunAtMs = STORE_TEST_NOW - 1_000;
const at = (ms: number): CronJob["schedule"] => ({ kind: "at", at: new Date(ms).toISOString() });

async function writeJob(storePath: string, job: CronJob) {
  await saveCronStore(storePath, { version: 1, jobs: [job] });
}

async function createView(storePath: string) {
  const onEvent = vi.fn();
  const view = createCronServiceWithStateForTest({
    scheduler: createTestGatewayScheduler(),
    storePath,
    cronEnabled: true,
    defaultAgentId: "main",
    log: logger,
    nowMs: () => STORE_TEST_NOW,
    enqueueSystemEvent: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    onEvent,
  });
  await ensureLoaded(view.state);
  return { ...view, onEvent };
}

function expectDeadline(job: CronJob, next: number | undefined, preserved?: number) {
  expect([
    job.state.nextRunAtMs,
    job.state.pacedNextRunAtMs,
    job.state.forcePreservedNextRunAtMs,
  ]).toEqual([next, undefined, preserved]);
}

type UpdateCase = {
  name: string;
  initial?: Partial<CronJob>;
  patch: CronJobPatch;
  next: number | undefined;
  preserved?: number;
};
const enablementCases: UpdateCase[] = [
  { oneShot: false, enabled: true },
  { oneShot: true, enabled: true },
  { oneShot: true, enabled: false },
].map(
  ({ oneShot, enabled }) =>
    ({
      name: `enablement (one-shot: ${oneShot}, enabled: ${enabled})`,
      initial: {
        enabled,
        ...(oneShot ? { schedule: at(dueNextRunAtMs) } : {}),
        state: {
          nextRunAtMs: dueNextRunAtMs,
          forcePreservedNextRunAtMs: dueNextRunAtMs,
          lastRunAtMs: STORE_TEST_NOW,
          lastRunStatus: "ok",
        },
      },
      patch: { enabled: !enabled },
      next: oneShot && !enabled ? dueNextRunAtMs : undefined,
      preserved: oneShot ? dueNextRunAtMs : undefined,
    }) satisfies UpdateCase,
);

it.each<UpdateCase>([
  {
    name: "cron expression",
    patch: { schedule: { kind: "cron", expr: "30 6 * * 0,6", tz: "UTC" } },
    next: Date.parse("2026-03-28T06:30:00.000Z"),
  },
  {
    name: "pacing",
    initial: {
      pacing: { max: "4h" },
      state: { nextRunAtMs: staleNextRunAtMs, pacedNextRunAtMs: staleNextRunAtMs },
    },
    patch: { pacing: { max: "2h" } },
    next: Date.parse("2026-03-24T06:00:00.000Z"),
  },
  {
    name: "every anchor",
    initial: { schedule: { kind: "every", everyMs: 60_000, anchorMs: STORE_TEST_NOW - 60_000 } },
    patch: { schedule: { kind: "every", everyMs: 60_000, anchorMs: STORE_TEST_NOW } },
    next: STORE_TEST_NOW + 60_000,
  },
  {
    name: "one-shot target",
    initial: {
      schedule: at(Date.parse("2026-03-23T13:00:00.000Z")),
      state: { nextRunAtMs: staleNextRunAtMs, forcePreservedNextRunAtMs: staleNextRunAtMs },
    },
    patch: { schedule: at(Date.parse("2026-03-23T14:00:00.000Z")) },
    next: Date.parse("2026-03-23T14:00:00.000Z"),
  },
  ...enablementCases,
])(
  "commits $name with matching deadlines across views",
  async ({ initial, patch, next, preserved }) => {
    const { storePath } = await makeStorePath();
    const job = createReloadCronJob({ state: { nextRunAtMs: staleNextRunAtMs }, ...initial });
    await writeJob(storePath, job);
    const writer = await createView(storePath);
    const observer = await createView(storePath);
    const updated = await writer.cron.update(job.id, patch);
    await ensureLoaded(observer.state);
    for (const result of [
      updated,
      findJobOrThrow(observer.state, job.id),
      (await loadCronStore(storePath)).jobs[0]!,
    ]) {
      expect(result.schedule).toEqual(patch.schedule ?? job.schedule);
      expect(result.enabled).toBe(patch.enabled ?? job.enabled);
      expect(result.pacing).toEqual(patch.pacing ?? job.pacing);
      expectDeadline(result, next, preserved);
    }
    expect(writer.onEvent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ action: "updated", jobId: job.id, nextRunAtMs: next }),
    );
    expect(observer.onEvent).not.toHaveBeenCalled();
    await recomputeUnownedCronSchedules(observer.state, {
      recomputeExpired: patch.enabled !== undefined,
    });
    const maintained = findJobOrThrow(observer.state, job.id);
    expect(maintained.state.nextRunAtMs).toBe(next);
    if (patch.enabled !== undefined) {
      expect(maintained.state.forcePreservedNextRunAtMs).toBe(preserved);
    }
    expect(observer.onEvent).not.toHaveBeenCalled();
  },
);

it.each([
  {
    name: "schedule key order only",
    initial: { state: { nextRunAtMs: dueNextRunAtMs } },
    replacement: { schedule: { expr: "0 6 * * *", kind: "cron", tz: "UTC" } },
    next: dueNextRunAtMs,
  },
  {
    name: "runtime state only",
    initial: {},
    replacement: { state: { nextRunAtMs: staleNextRunAtMs + 60_000 } },
    next: staleNextRunAtMs + 60_000,
  },
] satisfies Array<{
  name: string;
  initial: Partial<CronJob>;
  replacement: Partial<CronJob>;
  next: number;
}>)(
  "reloads a $name snapshot without changing its deadline",
  async ({ initial, replacement, next }) => {
    const { storePath } = await makeStorePath();
    const job = createReloadCronJob({ state: { nextRunAtMs: staleNextRunAtMs }, ...initial });
    await writeJob(storePath, job);
    const { state, onEvent } = await createView(storePath);
    const updated = { ...job, updatedAtMs: STORE_TEST_NOW, ...replacement };
    await writeJob(storePath, updated);
    await ensureLoaded(state, { forceReload: true });
    const reloaded = findJobOrThrow(state, job.id);
    expect(reloaded.schedule).toEqual(updated.schedule);
    expectDeadline(reloaded, next);
    expect((await loadCronStore(storePath)).jobs[0]?.state.nextRunAtMs).toBe(next);
    expect(onEvent).not.toHaveBeenCalled();
  },
);
