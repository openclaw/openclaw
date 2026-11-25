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
import { cronStoreKey } from "./store/key.js";

const BASE_TIME = Date.parse("2026-01-15T13:55:00.000Z");

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
        new CronService({
          cronEnabled: true,
          log: createNoopLogger(),
          enqueueSystemEvent: vi.fn(),
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
