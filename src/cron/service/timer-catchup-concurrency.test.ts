import { describe, expect, it, vi } from "vitest";
import {
  createCronRegressionState,
  createDueIsolatedJob,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { add, update } from "./ops-mutations.js";
import { run as runCronJob } from "./ops-run.js";
import { createCronServiceState } from "./state.js";
import { onTimer, runMissedJobs } from "./timer.test-support.js";

const fixtures = setupCronRegressionFixtures({ prefix: "cron-catchup-concurrency-" });

function dueJob(id: string, nowMs: number, offset: number) {
  return createDueIsolatedJob({ id, nowMs, nextRunAtMs: nowMs - offset });
}

async function readJobState(storePath: string, id: string) {
  return (await loadCronStore(storePath)).jobs.find((job) => job.id === id)?.state;
}

function startCatchup(storePath: string, nowMs: () => number, selectedId: string) {
  const started = createDeferred();
  const release = createDeferred();
  const state = createCronRegressionState({
    storePath,
    nowMs,
    maxMissedJobsPerRestart: 1,
    missedJobStaggerMs: 5_000,
    runIsolatedAgentJob: vi.fn(async ({ job }) => {
      if (job.id === selectedId) {
        started.resolve();
        await release.promise;
      }
      return { status: "ok" as const };
    }),
  });
  return { state, started, release, catchup: runMissedJobs(state) };
}

describe("cron startup catch-up concurrency", () => {
  it.each(["display", "payload", "schedule", "cron-history", "reactivated", "timer"] as const)(
    "preserves catch-up pacing across declarative %s reconciliation",
    async (change) => {
      const { storePath } = fixtures.makeStorePath();
      let now = Date.parse("2025-12-13T17:00:00.000Z");
      const selected = dueJob("selected", now, 60_000);
      const deferred = dueJob("deferred", now, 50_000);
      deferred.declarationKey = "daily-check";
      deferred.schedule = { kind: "every", everyMs: 60_000, anchorMs: now - 110_000 };
      if (change === "cron-history" || change === "reactivated") {
        deferred.schedule = { kind: "cron", expr: "* * * * *", tz: "UTC", staggerMs: 0 };
        deferred.state.lastRunAtMs = now - 120_000;
        deferred.state.lastRunStatus = "ok";
        if (change === "reactivated") {
          deferred.state.nextRunAtMs = now + 60_000;
        }
      }
      await saveCronStore(storePath, { version: 1, jobs: [selected, deferred] });
      const { state, started, release, catchup } = startCatchup(storePath, () => now, selected.id);
      try {
        await started.promise;
        let reconciled = await add(state, {
          ...deferred,
          displayName: change === "display" ? "New label" : undefined,
          payload:
            change === "payload" ? { kind: "agentTurn", message: "New task" } : deferred.payload,
          schedule: change === "schedule" ? { kind: "every", everyMs: 120_000 } : deferred.schedule,
        });
        if (change === "reactivated") {
          // The same future slot can belong to a newly enabled schedule; the
          // missed occurrence retired by this edit must not regain catch-up.
          now += 1;
          await update(state, deferred.id, { enabled: false });
          now += 1;
          reconciled = await update(state, deferred.id, { enabled: true });
          expect(reconciled.state.nextRunAtMs).toBe(deferred.state.nextRunAtMs);
          expect(reconciled.state.scheduleActivatedAtMs).toBe(now);
        }
        if (change === "timer") {
          now += 2_000;
          await onTimer(state);
          expect(state.deps.runIsolatedAgentJob).toHaveBeenCalledTimes(1);
          now += 6_000;
          await onTimer(state);
          expect(state.deps.runIsolatedAgentJob).toHaveBeenCalledTimes(1);
        }
        release.resolve();
        await catchup;
        const replacedSchedule = change === "schedule" || change === "reactivated";
        const expected = replacedSchedule ? reconciled.state.nextRunAtMs : now + 5_000;
        const persisted = await readJobState(storePath, deferred.id);
        expect(persisted?.nextRunAtMs).toBe(expected);
        expect(persisted?.startupCatchupAtMs).toBe(replacedSchedule ? undefined : expected);
        // A fresh scheduler must see the durable pacing fact, not replay the old due slot.
        const restarted = createCronServiceState(state.deps);
        await runMissedJobs(restarted);
        expect(state.deps.runIsolatedAgentJob).toHaveBeenCalledTimes(1);
      } finally {
        release.resolve();
        await catchup;
      }
    },
  );

  it("does not defer a recurring job completed by another gateway during catch-up", async () => {
    const { storePath } = fixtures.makeStorePath();
    const startNow = Date.parse("2025-12-13T17:00:00.000Z");
    const selected = dueJob("foreign-window-selected", startNow, 60_000);
    const deferred = dueJob("foreign-window-deferred", startNow, 50_000);
    selected.schedule = { kind: "every", everyMs: 60_000, anchorMs: startNow - 120_000 };
    deferred.schedule = { kind: "every", everyMs: 60_000, anchorMs: startNow - 110_000 };
    await saveCronStore(storePath, { version: 1, jobs: [selected, deferred] });
    const { started, release, catchup } = startCatchup(storePath, () => startNow, selected.id);
    try {
      await started.promise;
      const foreignNow = startNow + 1;
      const foreignState = createCronRegressionState({
        storePath,
        nowMs: () => foreignNow,
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const, summary: "foreign" })),
      });
      await expect(runCronJob(foreignState, deferred.id, "force")).resolves.toEqual({
        ok: true,
        ran: true,
      });
      const foreignCompleted = await readJobState(storePath, deferred.id);

      release.resolve();
      await catchup;

      const persisted = await readJobState(storePath, deferred.id);
      expect(persisted?.lastRunAtMs).toBe(foreignNow);
      expect(persisted?.nextRunAtMs).toBe(foreignCompleted?.nextRunAtMs);
      expect(persisted?.startupCatchupAtMs).toBeUndefined();
    } finally {
      release.resolve();
      await catchup;
    }
  });
});
