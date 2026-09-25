import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { tryBeginGatewayIndependentRootWorkAdmission } from "../../process/gateway-work-admission.js";
import * as stateRead from "../../state/openclaw-state-db-readonly.js";
import { captureTaskDeliveryWork } from "../../tasks/task-registry-delivery.test-support.js";
import { setupCronServiceSuite } from "../service.test-harness.js";
import * as cronStore from "../store.js";
import { loadCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import {
  inspectActiveCronRunReceipt,
  makeCronRecoveryJob,
} from "../store/run-receipt-store.test-support.js";
import { readCronTaskRunHistoryPage } from "../task-run-history.js";
import { start, stop } from "./ops-lifecycle.js";
import {
  createCronRecoveryFixture,
  observeCronTimerAdmissions,
  seedInterruptedCronJobs,
} from "./run-recovery.test-support.js";
import { createCronServiceState } from "./state.js";
import { onTimer } from "./timer.test-support.js";

const suite = setupCronServiceSuite({ prefix: "cron-recovery-batch-" });
const { logger } = suite;

async function seedInterruptedBatch(makeStorePath: typeof suite.makeStorePath) {
  const { storePath } = await makeStorePath();
  const nowMs = Date.now();
  const jobs = ["first", "second"].map((id, index) => {
    const job = makeCronRecoveryJob(id, nowMs - 1_000 + index);
    job.enabled = false;
    return job;
  });
  const onEvent = vi.fn();
  const runner = vi.fn(async () => ({ status: "ok" as const }));
  const state = createCronServiceState({
    storePath,
    cronEnabled: true,
    defaultAgentId: "alpha",
    isAgentAvailable: () => true,
    nowMs: () => nowMs,
    log: logger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: runner,
    runCommandJob: runner,
    onEvent,
  });
  await seedInterruptedCronJobs(state, jobs);
  const history = (jobId: string) =>
    readCronTaskRunHistoryPage({ storeKey: cronStoreKey(storePath), jobId }).entries;
  return { storePath, jobs, state, onEvent, runner, history };
}

describe("", () => {
  const fixtures = createCronRecoveryFixture(suite, onTestFinished);
  afterEach(() => fixtures.finishAfterEach());
  it("defers every repair when restart crosses the batch observation", async () =>
    fixtures.run(async (fixture) => {
      const deliveries = captureTaskDeliveryWork();
      fixture.cleanup(async () => {
        try {
          await deliveries.settle();
        } finally {
          deliveries[Symbol.dispose]();
        }
      });
      const { storePath, jobs, state, onEvent, runner, history } = await seedInterruptedBatch(
        fixture.makeStorePath,
      );
      fixture.assertCurrent();
      const entered = createDeferred();
      const release = createDeferred();
      fixture.release(() => release.resolve());
      let observations = 0;
      const execute = stateRead.executeExistingOpenClawStateRead;
      const delayed = vi
        .spyOn(stateRead, "executeExistingOpenClawStateRead")
        .mockImplementation(async (context, command) => {
          const result = await execute(context, command);
          if (command.type === "cron.observeRunRecovery" && ++observations === 1) {
            entered.resolve();
            await release.promise;
          }
          return result;
        });
      fixture.cleanup(async () => {
        delayed.mockRestore();
      });
      const unrelated = tryBeginGatewayIndependentRootWorkAdmission("test:concurrent-request");
      fixture.release(() => unrelated?.release());
      expect(unrelated).not.toBeNull();
      const admissions = observeCronTimerAdmissions(state);
      fixture.state(state);
      const tick = fixture.track(onTimer(state));
      let restarted: Promise<void> | undefined;
      await fixture.waitFor(entered.promise, tick);
      unrelated!.release();
      await admissions.expectActive();
      const observed = await loadCronStore(storePath);
      const beforeStop = {
        firstRunningAtMs:
          observed.jobs.find((job) => job.id === "first")?.state.runningAtMs ?? null,
        firstReceiptActive: Boolean(inspectActiveCronRunReceipt({ storePath, jobId: "first" })),
        firstHistory: history("first").map((entry) => entry.status),
        finishedEvents: onEvent.mock.calls
          .map(([event]) => event)
          .filter((event) => event.action === "finished")
          .map((event) => event.jobId),
      };
      expect(beforeStop).toEqual({
        firstRunningAtMs: jobs[0]!.state.runningAtMs,
        firstReceiptActive: true,
        firstHistory: [],
        finishedEvents: [],
      });
      stop(state);
      fixture.assertCurrent();
      restarted = fixture.track(start(state));
      release.resolve();
      await tick;
      await restarted;
      const finished = onEvent.mock.calls
        .map(([event]) => event)
        .filter((event) => event.action === "finished");
      expect(
        finished.map((event) => event.jobId),
        JSON.stringify({ beforeStop }),
      ).toEqual(["first", "second"]);
      for (const job of jobs) {
        expect(history(job.id)).toMatchObject([{ jobId: job.id, status: "error" }]);
        expect(inspectActiveCronRunReceipt({ storePath, jobId: job.id })).toBeUndefined();
      }
      expect(runner).not.toHaveBeenCalled();
      expect(state.activeTimerTicks).toBe(0);
      expect(state.queuedRunReservationsByJobId.size).toBe(0);
      await deliveries.settle();
      await admissions.expectReleased(1);
    }));

  it.each([
    ["timer", onTimer],
    ["startup", start],
  ] as const)(
    "publishes committed interruptions before retiring %s held at its reload",
    async (source, run) =>
      fixtures.run(async (fixture) => {
        const deliveries = captureTaskDeliveryWork();
        fixture.cleanup(async () => {
          try {
            await deliveries.settle();
          } finally {
            deliveries[Symbol.dispose]();
          }
        });
        const { storePath, jobs, state, onEvent, runner, history } = await seedInterruptedBatch(
          fixture.makeStorePath,
        );
        fixture.assertCurrent();
        const entered = createDeferred();
        const release = createDeferred();
        fixture.release(() => release.resolve());
        const load = cronStore.loadCronJobsStoreWithConfigJobs;
        let loads = 0;
        const delayed = vi
          .spyOn(cronStore, "loadCronJobsStoreWithConfigJobs")
          .mockImplementation(async (path) => {
            const result = await load(path);
            if (path === storePath && ++loads === 2) {
              entered.resolve();
              await release.promise;
            }
            return result;
          });
        fixture.cleanup(async () => {
          delayed.mockRestore();
        });
        const admissions = observeCronTimerAdmissions(state);
        fixture.state(state);
        const tick = fixture.track(run(state));
        let restarted: Promise<void> | undefined;
        await fixture.waitFor(entered.promise, tick);
        if (source === "timer") {
          await admissions.expectActive();
        }
        const committed = await loadCronStore(storePath);
        for (const job of jobs) {
          const stored = committed.jobs.find((entry) => entry.id === job.id);
          expect(stored?.state).toMatchObject({ lastRunStatus: "error" });
          expect(stored?.state.runningAtMs).toBeUndefined();
          expect(stored?.state.runningReceiptId).toBeUndefined();
          expect(inspectActiveCronRunReceipt({ storePath, jobId: job.id })).toBeUndefined();
          expect(history(job.id)).toEqual([]);
        }
        expect(
          onEvent.mock.calls.map(([event]) => event).filter((event) => event.action === "finished"),
        ).toEqual([]);

        stop(state);
        fixture.assertCurrent();
        restarted = fixture.track(start(state));
        expect(state.stopped).toBe(false);
        release.resolve();
        await tick;
        await restarted;

        const finished = onEvent.mock.calls
          .map(([event]) => event)
          .filter((event) => event.action === "finished");
        expect(finished).toMatchObject(
          jobs.map((job) => ({
            jobId: job.id,
            status: "error",
            error: "cron: job interrupted by gateway restart",
            runAtMs: job.state.runningAtMs,
          })),
        );
        for (const job of jobs) {
          const entries = history(job.id);
          expect(entries).toHaveLength(1);
          expect(entries[0]).toMatchObject({
            jobId: job.id,
            status: "error",
            error: "cron: job interrupted by gateway restart",
            runAtMs: job.state.runningAtMs,
          });
          expect(inspectActiveCronRunReceipt({ storePath, jobId: job.id })).toBeUndefined();
        }
        expect(runner).not.toHaveBeenCalled();
        expect(state.activeTimerTicks).toBe(0);
        expect(state.runAdmission.active).toBe(0);
        expect(state.runAdmission.waiters).toEqual([]);
        expect(state.queuedRunReservationsByJobId.size).toBe(0);
        await deliveries.settle();
        await admissions.expectReleased(source === "timer" ? 1 : 0);
      }),
  );
});
