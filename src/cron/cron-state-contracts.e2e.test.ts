import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { readCronRunHistoryPageForTests } from "./run-history.test-support.js";
import { CronService } from "./service.js";
import { createNoopLogger, installCronTestHooks } from "./service.test-harness.js";
import type { CronServiceDeps } from "./service/state.js";
import { loadCronStore } from "./store.js";
import { cronStoreKey } from "./store/key.js";
import type { CronJobCreate } from "./types.js";

const BASE_TIME_ISO = "2026-01-15T13:55:00.000Z";
const logger = createNoopLogger();

installCronTestHooks({ logger, fakeTimers: false });

function createService(
  params: Pick<CronServiceDeps, "scheduler" | "storePath"> &
    Partial<
      Pick<
        CronServiceDeps,
        "enqueueSystemEvent" | "requestHeartbeat" | "runIsolatedAgentJob" | "onEvent"
      >
    >,
) {
  return new CronService({
    cronEnabled: true,
    log: logger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    ...params,
  });
}

function mainJob(
  id: string,
  name: string,
  schedule: CronJobCreate["schedule"],
  text: string,
): CronJobCreate {
  return {
    id,
    name,
    enabled: true,
    schedule,
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text },
  };
}

describe("cron state contracts", () => {
  it("persists create, edit, restart, scheduled execution, and removal across schedule types", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-cron-state-lifecycle-" },
      async (state) => {
        const storePath = state.path("cron", "jobs.json");
        const baseTimeMs = Date.parse(BASE_TIME_ISO);
        const clock = createGatewaySchedulerClock(baseTimeMs);
        const scheduler = createTestGatewayScheduler(clock.clock);
        const atMs = baseTimeMs + 1_000;
        const systemEventEnqueued = createDeferred();
        const enqueueSystemEvent = vi.fn((text: string) => {
          if (text === "state contract fired") {
            systemEventEnqueued.resolve();
          }
        });
        const finished = createDeferred();
        const onEvent: CronServiceDeps["onEvent"] = (event) => {
          if (event.action === "finished" && event.jobId === "state-contract-at") {
            finished.resolve();
          }
        };
        const requestHeartbeat = vi.fn();
        const makeService = (extra: Pick<CronServiceDeps, "onEvent"> = {}) =>
          createService({ scheduler, storePath, enqueueSystemEvent, requestHeartbeat, ...extra });
        let first: CronService | undefined;
        let restarted: CronService | undefined;
        let reloaded: CronService | undefined;

        try {
          first = makeService();
          await first.start();

          const atSchedule = { kind: "at", at: new Date(atMs).toISOString() } as const;
          const timezoneSchedule = {
            kind: "cron",
            expr: "0 9 * * *",
            tz: "America/New_York",
            staggerMs: 30_000,
          } as const;
          const atJob = await first.add({
            ...mainJob(
              "state-contract-at",
              "one-shot lifecycle",
              atSchedule,
              "state contract fired",
            ),
            deleteAfterRun: false,
          });
          const everyJob = await first.add(
            mainJob(
              "state-contract-every",
              "interval lifecycle",
              { kind: "every", everyMs: 60_000 },
              "interval fired",
            ),
          );
          const timezoneJob = await first.add(
            mainJob(
              "state-contract-timezone",
              "timezone lifecycle",
              timezoneSchedule,
              "timezone fired",
            ),
          );

          const updatedEvery = await first.update(everyJob.id, {
            name: "edited interval lifecycle",
            schedule: { kind: "every", everyMs: 120_000 },
          });
          expect(updatedEvery).toMatchObject({
            name: "edited interval lifecycle",
            schedule: { kind: "every", everyMs: 120_000 },
          });

          const newYorkNineAm = Date.parse("2026-01-15T14:00:00.000Z");
          expect(timezoneJob.schedule).toEqual(timezoneSchedule);
          expect(timezoneJob.state.nextRunAtMs).toBeGreaterThanOrEqual(newYorkNineAm);
          expect(timezoneJob.state.nextRunAtMs).toBeLessThan(newYorkNineAm + 30_000);

          expect((await loadCronStore(storePath)).jobs.map((job) => job.id).toSorted()).toEqual([
            atJob.id,
            everyJob.id,
            timezoneJob.id,
          ]);

          first.stop();
          first = undefined;

          restarted = makeService({ onEvent });
          await restarted.start();
          const afterRestart = await restarted.list({ includeDisabled: true });
          expect(afterRestart).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                id: atJob.id,
                schedule: atSchedule,
              }),
              expect.objectContaining({
                id: everyJob.id,
                name: "edited interval lifecycle",
                schedule: expect.objectContaining({ kind: "every", everyMs: 120_000 }),
              }),
              expect.objectContaining({
                id: timezoneJob.id,
                schedule: timezoneSchedule,
              }),
            ]),
          );

          await clock.advanceBy(1_005);
          await restarted.status();
          await systemEventEnqueued.promise;
          await finished.promise;

          expect(
            enqueueSystemEvent.mock.calls.filter(([text]) => text === "state contract fired"),
          ).toHaveLength(1);
          const persistedAtJob = (await loadCronStore(storePath)).jobs.find(
            (job) => job.id === atJob.id,
          );
          expect(persistedAtJob).toMatchObject({
            enabled: false,
            state: { lastRunStatus: "ok" },
          });
          expect(persistedAtJob?.state.lastRunAtMs).toBeGreaterThanOrEqual(atMs);
          expect(persistedAtJob?.state.lastRunAtMs).toBeLessThanOrEqual(atMs + 5);

          expect(await restarted.remove(atJob.id)).toEqual({ ok: true, removed: true });
          restarted.stop();
          restarted = undefined;

          reloaded = makeService();
          await reloaded.start();
          expect(
            (await reloaded.list({ includeDisabled: true })).map((job) => job.id).toSorted(),
          ).toEqual([everyJob.id, timezoneJob.id]);
        } finally {
          first?.stop();
          restarted?.stop();
          reloaded?.stop();
        }
      },
    );
  });

  it("deduplicates isolated scheduler execution and persisted run history across reload", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-cron-state-dedup-" },
      async (state) => {
        const storePath = state.path("cron", "jobs.json");
        const atMs = Date.parse(BASE_TIME_ISO) + 1_000;
        const firstClock = createGatewaySchedulerClock(Date.parse(BASE_TIME_ISO));
        const secondClock = createGatewaySchedulerClock(Date.parse(BASE_TIME_ISO));
        const runIsolatedAgentJob = vi.fn(async () => ({
          status: "ok" as const,
          summary: "isolated state contract completed",
        }));
        const events: Array<{ action: string; jobId: string }> = [];
        const finished = createDeferred();
        const onEvent: CronServiceDeps["onEvent"] = (event) => {
          events.push({ action: event.action, jobId: event.jobId });
          if (event.action === "finished") {
            finished.resolve();
          }
        };
        const makeService = (clock: typeof firstClock) =>
          createService({
            scheduler: createTestGatewayScheduler(clock.clock),
            storePath,
            runIsolatedAgentJob,
            onEvent,
          });
        const history = (jobId: string) =>
          readCronRunHistoryPageForTests({ storeKey: cronStoreKey(storePath), jobId });
        let first: CronService | undefined;
        let second: CronService | undefined;
        let restarted: CronService | undefined;

        try {
          first = makeService(firstClock);
          await first.start();
          const job = await first.add({
            id: "state-contract-isolated-dedup",
            name: "isolated dedup lifecycle",
            enabled: true,
            deleteAfterRun: false,
            schedule: { kind: "at", at: new Date(atMs).toISOString() },
            sessionTarget: "isolated",
            wakeMode: "now",
            payload: { kind: "agentTurn", message: "prove isolated cron state" },
            delivery: { mode: "none" },
          });

          second = makeService(secondClock);
          await second.start();

          await Promise.all([firstClock.advanceBy(1_005), secondClock.advanceBy(1_005)]);
          await first.status();
          await second.status();
          await finished.promise;

          expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
          expect(
            events.filter((event) => event.jobId === job.id && event.action === "finished"),
          ).toHaveLength(1);

          const initialHistory = history(job.id);
          expect(initialHistory.total).toBe(1);
          expect(initialHistory.entries).toEqual([
            expect.objectContaining({
              jobId: job.id,
              status: "ok",
              summary: "isolated state contract completed",
            }),
          ]);
          const persistedEntry = initialHistory.entries[0];
          expect(persistedEntry?.runAtMs).toBeGreaterThanOrEqual(atMs);
          expect(persistedEntry?.runAtMs).toBeLessThanOrEqual(atMs + 5);

          first.stop();
          first = undefined;
          second.stop();
          second = undefined;

          const reloadedHistory = history(job.id);
          expect(reloadedHistory.entries).toEqual([persistedEntry]);

          restarted = makeService(firstClock);
          await restarted.start();
          expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
          expect(history(job.id).entries).toEqual([persistedEntry]);
        } finally {
          first?.stop();
          second?.stop();
          restarted?.stop();
        }
      },
    );
  });
});
