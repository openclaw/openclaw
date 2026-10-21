import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it, vi } from "vitest";
import { createCronRegressionState } from "../../test/helpers/cron/service-regression-fixtures.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { makeCronJob } from "./delivery.test-helpers.js";
import { setupCronServiceSuite } from "./service.test-harness.js";
import { start } from "./service/ops-lifecycle.js";
import { status } from "./service/ops-read.js";
import type { CronServiceDeps } from "./service/state.js";
import { onTimer, runMissedJobs } from "./service/timer.test-support.js";
import { loadCronStore, saveCronStore } from "./store.js";
import { cronStoreKey } from "./store/key.js";
import type { CronJob } from "./types.js";

const { logger: noopLogger, makeStorePath } = setupCronServiceSuite({
  prefix: "openclaw-cron-overflow-",
  baseTimeIso: "2025-12-13T17:00:00.000Z",
});

function makeState(storePath: string, overrides: Partial<CronServiceDeps>) {
  return createCronRegressionState({
    storePath,
    log: noopLogger,
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    ...overrides,
  });
}

describe("CronService startup catch-up repair scoping", () => {
  function createJob(id: string, nextRunAtMs: number, schedule: CronJob["schedule"]): CronJob {
    return makeCronJob({
      id,
      schedule,
      sessionTarget: "main",
      payload: { kind: "systemEvent", text: `tick-${id}` },
      state: { nextRunAtMs },
    });
  }
  const createHourlyCronJob = (id: string, next: number) =>
    createJob(id, next, { kind: "cron", expr: "0 * * * *", tz: "UTC" });
  const createDailyCronJob = (id: string, next: number) =>
    createJob(id, next, { kind: "cron", expr: "0 9 * * *", tz: "UTC" });
  it("persists skipped recurring slots before the first tick even with an empty startup plan", async () => {
    const store = await makeStorePath();
    const now = Date.now();
    const dueAt = now - 60_000;
    const tomorrow = Date.parse("2025-12-14T09:00:00.000Z");
    const daily = createDailyCronJob("missed-daily", dueAt);
    daily.state.lastRunAtMs = Date.parse("2025-12-12T09:00:00.000Z");
    const every: CronJob = {
      ...createJob("missed-every", dueAt, { kind: "every", everyMs: 60_000, anchorMs: dueAt }),
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "interval reminder" },
    };
    const jobs = [
      daily,
      every,
      { ...daily, id: "history-only-miss", state: { ...daily.state, nextRunAtMs: tomorrow } },
      createDailyCronJob("future-daily", tomorrow),
      { ...every, id: "future-every", state: { nextRunAtMs: now + 30_000 } },
    ];
    await saveCronStore(store.storePath, { version: 1, jobs });
    const before = await loadCronStore(store.storePath);
    const state = makeState(store.storePath, {
      cronConfig: { skipMissedJobs: true },
      nowMs: () => now,
    });
    const expectNoExecution = () => {
      expect(state.deps.runSessionEvent).not.toHaveBeenCalled();
      expect(state.deps.runIsolatedAgentJob).not.toHaveBeenCalled();
    };

    await runMissedJobs(state, { deferAgentWork: true });

    const persisted = await loadCronStore(store.storePath);
    for (const job of persisted.jobs) {
      expect(job.state.nextRunAtMs).toBeGreaterThan(now);
      expect(job.state.lastRunAtMs).toBe(
        before.jobs.find((original) => original.id === job.id)?.state.lastRunAtMs,
      );
      if (job.id.startsWith("future-")) {
        expect(job).toEqual(before.jobs.find((original) => original.id === job.id));
      }
    }
    expect(persisted.jobs.find((job) => job.id === daily.id)?.state.nextRunAtMs).toBe(tomorrow);
    expect(persisted.jobs.find((job) => job.id === every.id)?.state.nextRunAtMs).toBe(now + 60_000);
    expectNoExecution();

    // An empty startup plan must still commit, since ticks reload durable schedules.
    await onTimer(state);
    expectNoExecution();
  });

  it("keeps the overflow daily-cron catch-up deferral across a second restart", async () => {
    const store = await makeStorePath();
    const startNow = Date.parse("2025-12-13T17:00:00.000Z");
    let now = startNow;
    const tomorrowNaturalSlot = Date.parse("2025-12-14T09:00:00.000Z");

    await saveCronStore(store.storePath, {
      version: 1,
      jobs: [
        ...Array.from({ length: 5 }, (_, i) =>
          createHourlyCronJob(`hourly-${i}`, startNow - (14 - i) * 3_600_000),
        ),
        createDailyCronJob("daily-overflow", Date.parse("2025-12-13T09:00:00.000Z")),
      ],
    });

    const createState = () => makeState(store.storePath, { nowMs: () => now });
    const state = createState();

    await start(state);

    const deferred = state.store?.jobs.find((job) => job.id === "daily-overflow");

    expect(deferred?.state.nextRunAtMs).toBe(startNow + 145_000);
    expect(deferred?.state.nextRunAtMs).not.toBe(tomorrowNaturalSlot);
    expect(deferred?.state.startupCatchupAtMs).toBe(startNow + 145_000);

    await status(state);
    expect(deferred?.state.nextRunAtMs).toBe(startNow + 145_000);

    state.stopped = true;
    now = startNow + 3_000;

    const restartedState = createState();
    await start(restartedState);

    const restarted = restartedState.store?.jobs.find((job) => job.id === "daily-overflow");
    expect(restarted?.state.nextRunAtMs).toBe(startNow + 145_000);
    expect(restarted?.state.startupCatchupAtMs).toBe(startNow + 145_000);

    now = startNow + 145_005;
    await onTimer(restartedState);

    const completed = restartedState.store?.jobs.find((job) => job.id === "daily-overflow");
    expect(completed?.state.lastRunStatus).toBe("ok");
    expect(completed?.state.nextRunAtMs).toBe(tomorrowNaturalSlot);
    expect(completed?.state.startupCatchupAtMs).toBeUndefined();

    restartedState.stopped = true;
  });

  it("disables startup catch-up deferrals that exceed the Date range", async () => {
    const store = await makeStorePath();
    const now = MAX_DATE_TIMESTAMP_MS - 2_000;
    await saveCronStore(store.storePath, {
      version: 1,
      jobs: [60_000, 50_000, 40_000].map((offset, i) =>
        createJob(`date-limit-${i}`, now - offset, {
          kind: "every",
          everyMs: MAX_DATE_TIMESTAMP_MS,
          anchorMs: 0,
        }),
      ),
    });
    const order: string[] = [];
    const deferredAutoDisableReasons = new Set([
      "cron:date-limit-1:auto-disabled",
      "cron:date-limit-2:auto-disabled",
    ]);
    const enqueueSessionEvent = vi.fn((_text: string, context?: { contextKey?: string }) => {
      if (context?.contextKey && deferredAutoDisableReasons.has(context.contextKey)) {
        if (!order.includes("persist")) {
          const rows = openOpenClawStateDatabase()
            .db.prepare(
              "SELECT state_json AS stateJson FROM cron_jobs WHERE store_key = ? AND job_id IN (?, ?) ORDER BY job_id",
            )
            .all(cronStoreKey(store.storePath), "date-limit-1", "date-limit-2") as {
            stateJson: string;
          }[];
          expect(rows).toHaveLength(2);
          for (const row of rows) {
            expect(JSON.parse(row.stateJson)).toMatchObject({
              autoDisabled: { reason: "schedule-errors" },
            });
          }
          order.push("persist");
        }
        order.push("notify");
      }
    });
    const requestHeartbeat = vi.fn();
    const state = makeState(store.storePath, {
      nowMs: () => now,
      enqueueSessionEvent,
      requestHeartbeat,
      maxMissedJobsPerRestart: 1,
      missedJobStaggerMs: 5_000,
    });
    await runMissedJobs(state);

    const deferred = (state.store?.jobs ?? []).filter((job) => job.id !== "date-limit-0");
    expect(deferred).toHaveLength(2);
    for (const job of deferred) {
      expect(job.enabled).toBe(false);
      expect(job.state.nextRunAtMs).toBeUndefined();
      expect(job.state.startupCatchupAtMs).toBeUndefined();
      expect(job.state.autoDisabled).toEqual({
        reason: "schedule-errors",
        atMs: now,
        consecutiveErrors: 1,
      });
    }
    expect(order).toEqual(["persist", "notify", "notify"]);
    expect(requestHeartbeat).not.toHaveBeenCalled();
    const persisted = (await loadCronStore(store.storePath)).jobs;
    for (const job of deferred) {
      const saved = persisted.find(({ id }) => id === job.id);
      expect(saved?.enabled).toBe(false);
      expect(saved?.state.autoDisabled).toEqual(job.state.autoDisabled);
    }
  });
});
