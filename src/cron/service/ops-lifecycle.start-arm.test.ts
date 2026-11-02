import { expect, it, vi } from "vitest";
import {
  createDueIsolatedJob,
  noopLogger,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import type { CliDeps } from "../../cli/deps.types.js";
import type { GatewayCronState } from "../../gateway/server-cron-contract.js";
import { createLazyGatewayCronState } from "../../gateway/server-cron-lazy.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../../test-utils/gateway-scheduler-clock.js";
import { createCronServiceWithStateForTest } from "../service.test-harness.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { waitForCronRunQueue } from "./run-queue.js";
import { captureCronSchedulerWakeForTest } from "./scheduler-actor.test-support.js";
import type { CronServiceDeps } from "./state.js";

const gateway = vi.hoisted(() => ({ state: undefined as GatewayCronState | undefined }));
vi.mock("../../gateway/server-cron.js", () => ({
  buildGatewayCronService: () => gateway.state,
}));

const fixtures = setupCronRegressionFixtures({ prefix: "cron-start-arm-" });

it.each([false, true])(
  "delivers future jobs after suspension (write failure=%s)",
  async (failWrite) => {
    const { storePath } = fixtures.makeStorePath();
    const now = Date.now();
    const jobs = [
      createDueIsolatedJob({ id: "overdue", nowMs: now, nextRunAtMs: now - 30_000 }),
      createDueIsolatedJob({ id: "upcoming", nowMs: now, nextRunAtMs: now + 132_000 }),
    ];
    for (const job of jobs) {
      job.sessionTarget = "main";
      job.payload = { kind: "systemEvent", text: job.id };
    }
    await saveCronStore(storePath, { version: 1, jobs });
    const database = openOpenClawStateDatabase().db;
    if (failWrite) {
      database.exec(`
      CREATE TRIGGER reject_startup_terminal_write
      AFTER UPDATE ON cron_jobs
      WHEN NEW.job_id = 'overdue' AND json_extract(NEW.state_json, '$.lastRunStatus') = 'ok'
      BEGIN
        SELECT RAISE(ABORT, 'injected terminal write failure');
      END;
    `);
    }
    const runSessionEvent = vi.fn<NonNullable<CronServiceDeps["runSessionEvent"]>>(async () => ({
      status: "ok",
    }));
    const clock = createGatewaySchedulerClock(now);
    const scheduler = createTestGatewayScheduler(clock.clock);
    const { cron: service, state } = createCronServiceWithStateForTest({
      scheduler,
      storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      runSessionEvent,
      runIsolatedAgentJob: vi.fn(),
    });
    gateway.state = {
      cron: service,
      storePath,
      cronEnabled: true,
      reconcileExitWatchers: async () => {},
      reconcileStreamWatchers: async () => {},
      stopStreamWatchers: async () => {},
    };
    const { cron } = createLazyGatewayCronState({
      storePath,
      cfg: {},
      deps: {} as CliDeps,
      broadcast: vi.fn(),
      scheduler,
    });
    try {
      const { wake } = await captureCronSchedulerWakeForTest(() => cron.start());
      expect(runSessionEvent).not.toHaveBeenCalled();
      expect(service.getJob("overdue")?.state.nextRunAtMs).toBe(now + 120_000);
      clock.setTime(now + 120_000);
      await wake(state);
      // A tick acknowledges activation; the retained run owns terminal accounting.
      await waitForCronRunQueue(state);
      if (failWrite) {
        const overdue = (await loadCronStore(storePath)).jobs.find((job) => job.id === "overdue");
        expect(overdue?.state.runningAtMs).toBe(now + 120_000);
        expect(overdue?.state.lastRunStatus).toBeUndefined();
      }
      const tick = async (delayMs: number, expected: string[], drain = true) => {
        clock.setTime(clock.clock.now() + delayMs);
        await wake(state);
        if (drain) {
          await waitForCronRunQueue(state);
        }
        expect(runSessionEvent.mock.calls.map(([request]) => request.text)).toEqual(expected);
      };
      database.exec("DROP TRIGGER IF EXISTS reject_startup_terminal_write");
      expect(runSessionEvent.mock.calls.map(([request]) => request.text)).toEqual(["overdue"]);
      cron.pauseScheduling();
      await tick(15_000, ["overdue"], false);
      cron.resumeScheduling();
      await tick(15_000, ["overdue", "upcoming"]);
      await tick(60_000, ["overdue", "upcoming"]);
    } finally {
      cron.stop();
      await scheduler.stop();
      database.exec("DROP TRIGGER IF EXISTS reject_startup_terminal_write");
    }
  },
);
