import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { readCronRunHistoryPageForTests } from "./run-history.test-support.js";
import { CronService } from "./service.js";
import { createNoopLogger } from "./service.test-harness.js";
import type { CronServiceDeps } from "./service/state.js";
import { loadCronStore } from "./store.js";
import { cronStoreKey } from "./store/key.js";
import type { CronJobCreate } from "./types.js";

const BASE_TIME = Date.parse("2026-01-15T13:55:00.000Z");

function createService(
  params: Pick<CronServiceDeps, "scheduler" | "storePath"> &
    Partial<Pick<CronServiceDeps, "enqueueSystemEvent" | "runIsolatedAgentJob" | "onEvent">>,
) {
  return new CronService({
    cronEnabled: true,
    log: createNoopLogger(),
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    ...params,
  });
}

function mainJob(id: string, schedule: CronJobCreate["schedule"]): CronJobCreate {
  return {
    id,
    name: id,
    enabled: true,
    schedule,
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: id },
  };
}

it("persists create, edit, restart, scheduled execution, and removal across schedule types", () =>
  withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-cron-state-lifecycle-" },
    async (state) => {
      const storePath = state.path("cron", "jobs.json");
      const clock = createGatewaySchedulerClock(BASE_TIME);
      const scheduler = createTestGatewayScheduler(clock.clock);
      const atMs = BASE_TIME + 1_000;
      const enqueueSystemEvent = vi.fn();
      const finished = createDeferred();
      const onEvent: CronServiceDeps["onEvent"] = (event) => {
        if (event.action === "finished" && event.jobId === "state-contract-at") {
          finished.resolve();
        }
      };
      const makeService = (extra: Pick<CronServiceDeps, "onEvent"> = {}) =>
        createService({ scheduler, storePath, enqueueSystemEvent, ...extra });
      let cron: CronService | undefined;

      try {
        cron = makeService();
        await cron.start();

        const atSchedule = { kind: "at", at: new Date(atMs).toISOString() } as const;
        const timezoneSchedule = {
          kind: "cron",
          expr: "0 9 * * *",
          tz: "America/New_York",
          staggerMs: 30_000,
        } as const;
        const atJob = await cron.add({
          ...mainJob("state-contract-at", atSchedule),
          deleteAfterRun: false,
        });
        const everyJob = await cron.add(
          mainJob("state-contract-every", { kind: "every", everyMs: 60_000 }),
        );
        const timezoneJob = await cron.add(mainJob("state-contract-timezone", timezoneSchedule));

        const updatedEvery = await cron.update(everyJob.id, {
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

        cron.stop();
        cron = undefined;

        cron = makeService({ onEvent });
        await cron.start();
        expect(await cron.list({ includeDisabled: true })).toEqual(
          expect.arrayContaining(
            [
              { id: atJob.id, schedule: atSchedule },
              {
                id: everyJob.id,
                name: "edited interval lifecycle",
                schedule: expect.objectContaining({ kind: "every", everyMs: 120_000 }),
              },
              { id: timezoneJob.id, schedule: timezoneSchedule },
            ].map((job) => expect.objectContaining(job)),
          ),
        );

        await clock.advanceBy(1_005);
        await cron.status();
        await finished.promise;

        expect(
          enqueueSystemEvent.mock.calls.filter(([text]) => text === "state-contract-at"),
        ).toHaveLength(1);
        const persistedAtJob = (await loadCronStore(storePath)).jobs.find(
          (job) => job.id === atJob.id,
        );
        expect(persistedAtJob).toMatchObject({ enabled: false, state: { lastRunStatus: "ok" } });
        expect(persistedAtJob?.state.lastRunAtMs).toBeGreaterThanOrEqual(atMs);
        expect(persistedAtJob?.state.lastRunAtMs).toBeLessThanOrEqual(atMs + 5);

        expect(await cron.remove(atJob.id)).toEqual({ ok: true, removed: true });
        cron.stop();
        cron = undefined;

        cron = makeService();
        await cron.start();
        expect(
          (await cron.list({ includeDisabled: true })).map((job) => job.id).toSorted(),
        ).toEqual([everyJob.id, timezoneJob.id]);
      } finally {
        cron?.stop();
      }
    },
  ));

it("deduplicates isolated scheduler execution and persisted run history across reload", () =>
  withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-cron-state-dedup-" },
    async (state) => {
      const storePath = state.path("cron", "jobs.json");
      const atMs = BASE_TIME + 1_000;
      const firstClock = createGatewaySchedulerClock(BASE_TIME);
      const secondClock = createGatewaySchedulerClock(BASE_TIME);
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
        expect(initialHistory).toMatchObject({
          total: 1,
          entries: [{ jobId: job.id, status: "ok", summary: "isolated state contract completed" }],
        });
        const persistedEntry = initialHistory.entries[0];
        expect(persistedEntry?.runAtMs).toBeGreaterThanOrEqual(atMs);
        expect(persistedEntry?.runAtMs).toBeLessThanOrEqual(atMs + 5);

        first.stop();
        first = undefined;
        second.stop();
        second = undefined;

        expect(history(job.id).entries).toEqual([persistedEntry]);

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
  ));
