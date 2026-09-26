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
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { CronService } from "../service.js";
import { saveCronStore } from "../store.js";

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
    const enqueueSystemEvent = vi.fn();
    const log = { ...noopLogger, debug: vi.fn(), warn: vi.fn() };
    if (failArm) {
      log.debug.mockImplementationOnce(() => {
        throw new Error("secondary arm failure");
      });
    }
    const scheduler = createTestGatewayScheduler("fake-timers");
    const service = new CronService({
      scheduler,
      storePath,
      cronEnabled: true,
      log,
      enqueueSystemEvent,
      requestHeartbeat: vi.fn(),
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
      scheduler,
      cfg: {},
      deps: {} as CliDeps,
      broadcast: vi.fn(),
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
      expect(enqueueSystemEvent.mock.calls.map(([text]) => text)).toEqual(["overdue"]);
      cron.pauseScheduling();
      await vi.advanceTimersByTimeAsync(1_000);
      cron.resumeScheduling();
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.waitFor(() =>
        expect(enqueueSystemEvent.mock.calls.map(([text]) => text)).toEqual([
          "overdue",
          "upcoming",
        ]),
      );
      await vi.advanceTimersByTimeAsync(60_000);
      expect(enqueueSystemEvent.mock.calls.map(([text]) => text)).toEqual(["overdue", "upcoming"]);
    } finally {
      cron.stop();
      await scheduler.stop();
      database.exec("DROP TRIGGER IF EXISTS reject_startup_terminal_write");
    }
  },
);
