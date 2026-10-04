import { expect, it, vi } from "vitest";
import {
  createDueIsolatedJob,
  noopLogger,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import type { CliDeps } from "../../cli/deps.types.js";
import { createLazyGatewayCronState } from "../../gateway/server-cron-lazy.js";
import type { GatewayCronState } from "../../gateway/server-cron.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../../test-utils/gateway-scheduler-clock.js";
import { CronService } from "../service.js";
import { saveCronStore } from "../store.js";
import type { CronServiceDeps } from "./state.js";

const gateway = vi.hoisted(() => ({ state: undefined as GatewayCronState | undefined }));
vi.mock("../../gateway/server-cron.js", () => ({
  buildGatewayCronService: () => gateway.state,
}));

const fixtures = setupCronRegressionFixtures({ prefix: "cron-start-arm-" });

it.each([
  { failWrite: false, failArm: false },
  { failWrite: true, failArm: false },
  { failWrite: true, failArm: true },
])(
  "delivers future jobs after suspension (write failure=$failWrite, arm failure=$failArm)",
  async ({ failWrite, failArm }) => {
    const { storePath } = fixtures.makeStorePath();
    const now = Date.now();
    const jobs = [
      createDueIsolatedJob({ id: "overdue", nowMs: now, nextRunAtMs: now - 30_000 }),
      createDueIsolatedJob({ id: "upcoming", nowMs: now, nextRunAtMs: now + 12_000 }),
    ];
    for (const job of jobs) {
      job.payload = { kind: "command", argv: ["fixture-task", job.id] };
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
    const runCommandJob = vi.fn<NonNullable<CronServiceDeps["runCommandJob"]>>(async () => ({
      status: "ok" as const,
    }));
    const log = { ...noopLogger, debug: vi.fn(), warn: vi.fn() };
    const clock = createGatewaySchedulerClock(now);
    const scheduler = createTestGatewayScheduler(clock.clock);
    if (failArm) {
      const scope = scheduler.scope();
      vi.spyOn(scheduler, "scope").mockReturnValueOnce(scope);
      vi.spyOn(scope, "schedule").mockImplementationOnce(() => {
        throw new Error("secondary arm failure");
      });
    }
    const service = new CronService({
      scheduler,
      storePath,
      cronEnabled: true,
      log,
      enqueueSystemEvent: vi.fn(),
      runCommandJob,
      runIsolatedAgentJob: vi.fn(),
    });
    gateway.state = {
      cron: service,
      storePath,
      cronEnabled: true,
      reconcileExitWatchers: async () => {},
      reconcileStreamWatchers: async () => {},
      stopStreamWatchers: async () => {},
      reconcileSystemJobs: async () => "converged",
    };
    const { cron } = createLazyGatewayCronState({
      cfg: {},
      deps: {} as CliDeps,
      broadcast: vi.fn(),
      scheduler,
    });
    try {
      if (failWrite) {
        await expect(cron.start()).rejects.toThrow("injected terminal write failure");
      } else {
        await cron.start();
      }
      if (failArm) {
        expect(log.warn).toHaveBeenCalledWith(
          { err: "Error: secondary arm failure" },
          expect.any(String),
        );
      }
      database.exec("DROP TRIGGER IF EXISTS reject_startup_terminal_write");
      expect(runCommandJob.mock.calls.map(([{ job }]) => job.id)).toEqual(["overdue"]);
      cron.pauseScheduling();
      await clock.advanceBy(15_000);
      expect(runCommandJob.mock.calls.map(([{ job }]) => job.id)).toEqual(["overdue"]);
      cron.resumeScheduling();
      await clock.advanceBy(15_000);
      expect(runCommandJob.mock.calls.map(([{ job }]) => job.id)).toEqual(["overdue", "upcoming"]);
      await clock.advanceBy(60_000);
      expect(runCommandJob.mock.calls.map(([{ job }]) => job.id)).toEqual(["overdue", "upcoming"]);
    } finally {
      cron.stop();
      await scheduler.stop();
      database.exec("DROP TRIGGER IF EXISTS reject_startup_terminal_write");
    }
  },
);
