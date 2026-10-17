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

const NOW = Date.parse("2026-03-23T12:00:00.000Z");

async function seedJob(initial?: Partial<CronJob>) {
  const { storePath } = await makeStorePath();
  const job: CronJob = {
    id: "reload-cron-expr-job",
    name: "reload cron expr job",
    enabled: true,
    createdAtMs: NOW - 60_000,
    updatedAtMs: NOW - 60_000,
    schedule: { kind: "cron", expr: "0 6 * * *", tz: "UTC" },
    sessionTarget: "main",
    wakeMode: "now",
    payload: { kind: "systemEvent", text: "tick" },
    state: { nextRunAtMs: stale },
    ...initial,
  };
  await saveCronStore(storePath, { version: 1, jobs: [job] });
  return { storePath, job };
}

function makeService(storePath: string) {
  const onEvent = vi.fn();
  return {
    ...createCronServiceWithStateForTest({
      scheduler: createTestGatewayScheduler(),
      storePath,
      cronEnabled: true,
      defaultAgentId: "main",
      log: logger,
      nowMs: () => NOW,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      onEvent,
    }),
    onEvent,
  };
}

const stale = NOW + 3_600_000;
const due = NOW - 1_000;
const cron = (expr = "0 6 * * *") => ({ kind: "cron" as const, expr, tz: "UTC" });
const every = (anchorMs: number) => ({ kind: "every" as const, everyMs: 60_000, anchorMs });
const at = (hour: number) => ({ kind: "at" as const, at: `2026-03-23T${hour}:00:00.000Z` });

async function expectEdit(
  initial: Partial<CronJob>,
  patch: CronJobPatch,
  nextRunAtMs: number | undefined,
  preserved?: number,
  recomputeExpired?: boolean,
) {
  const { storePath, job } = await seedJob(initial);
  const writer = makeService(storePath);
  const observer = makeService(storePath);
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
    expect(result?.enabled).toBe(patch.enabled ?? job.enabled);
    expect([
      result?.state.nextRunAtMs,
      result?.state.pacedNextRunAtMs,
      result?.state.forcePreservedNextRunAtMs,
    ]).toEqual([nextRunAtMs, undefined, preserved]);
  }
  expect(observer.state.durableNextRunAtMsByJobId.get(job.id)).toBe(nextRunAtMs);
  expect(writer.onEvent).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ action: "updated", jobId: job.id, nextRunAtMs }),
  );
  expect(observer.onEvent).not.toHaveBeenCalled();
  await recomputeUnownedCronSchedules(
    observer.state,
    recomputeExpired ? { recomputeExpired } : undefined,
  );
  const maintained = findJobOrThrow(observer.state, job.id);
  expect([maintained.state.nextRunAtMs, maintained.state.forcePreservedNextRunAtMs]).toEqual([
    nextRunAtMs,
    preserved,
  ]);
  expect(observer.onEvent).not.toHaveBeenCalled();
}

function completed(oneShot: boolean, enabled: boolean): Partial<CronJob> {
  return {
    enabled,
    ...(oneShot ? { schedule: { kind: "at", at: new Date(due).toISOString() } } : {}),
    state: {
      nextRunAtMs: due,
      forcePreservedNextRunAtMs: due,
      lastRunAtMs: NOW,
      lastRunStatus: "ok",
    },
  };
}
type EditCase = [name: string, ...Parameters<typeof expectEdit>];
it.each<EditCase>([
  ["cron expression", {}, { schedule: cron("30 6 * * 0,6") }, Date.UTC(2026, 2, 28, 6, 30)],
  [
    "pacing",
    {
      pacing: { max: "4h" },
      state: { nextRunAtMs: stale, pacedNextRunAtMs: stale },
    },
    { pacing: { max: "2h" } },
    Date.UTC(2026, 2, 24, 6),
  ],
  ["every anchor", { schedule: every(NOW - 60_000) }, { schedule: every(NOW) }, NOW + 60_000],
  [
    "one-shot target",
    {
      schedule: at(13),
      state: { nextRunAtMs: stale, forcePreservedNextRunAtMs: stale },
    },
    { schedule: at(14) },
    Date.UTC(2026, 2, 23, 14),
  ],
  ["disable recurring", completed(false, true), { enabled: false }, undefined, undefined, true],
  ["disable one-shot", completed(true, true), { enabled: false }, undefined, due, true],
  ["enable one-shot", completed(true, false), { enabled: true }, due, due, true],
])("commits %s with its matching next-run identity before another view reloads", (_name, ...args) =>
  expectEdit(...args),
);

it.each<EditCase>([
  [
    "schedule key order only",
    { state: { nextRunAtMs: due } },
    { schedule: { expr: "0 6 * * *", kind: "cron", tz: "UTC" } },
    due,
  ],
  ["runtime state only", {}, { state: { nextRunAtMs: stale + 60_000 } }, stale + 60_000],
])(
  "reloads a %s snapshot without changing its deadline",
  async (_name, initial, replacement, nextRunAtMs) => {
    const { storePath, job } = await seedJob(initial);
    const { state, onEvent } = makeService(storePath);
    await ensureLoaded(state);

    const updated = { ...job, updatedAtMs: NOW, ...replacement };
    await saveCronStore(storePath, { version: 1, jobs: [updated] });
    await ensureLoaded(state, { forceReload: true });

    const reloaded = findJobOrThrow(state, job.id);
    expect(reloaded.schedule).toEqual(updated.schedule);
    expect(reloaded.state.nextRunAtMs).toBe(nextRunAtMs);
    expect(reloaded.state.pacedNextRunAtMs).toBeUndefined();
    expect(reloaded.state.forcePreservedNextRunAtMs).toBeUndefined();
    expect(state.durableNextRunAtMsByJobId.get(job.id)).toBe(nextRunAtMs);
    expect((await loadCronStore(storePath)).jobs[0]?.state.nextRunAtMs).toBe(nextRunAtMs);
    expect(onEvent).not.toHaveBeenCalled();
  },
);
