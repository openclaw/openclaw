import { expect, it, vi } from "vitest";
import {
  createDueIsolatedJob,
  noopLogger,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { CronService } from "../service.js";
import { saveCronStore } from "../store.js";

const fixtures = setupCronRegressionFixtures({ prefix: "cron-start-arm-" });

it.each([false, true])(
  "delivers future jobs once after startup (write failure=%s)",
  async (failWrite) => {
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
    const cron = new CronService({
      storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(),
    });
    try {
      if (failWrite) {
        await expect(cron.start()).rejects.toThrow("injected terminal write failure");
      } else {
        await cron.start();
      }
      database.exec("DROP TRIGGER IF EXISTS reject_startup_terminal_write");
      expect(enqueueSystemEvent.mock.calls.map(([text]) => text)).toEqual(["overdue"]);
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
      database.exec("DROP TRIGGER IF EXISTS reject_startup_terminal_write");
    }
  },
);
