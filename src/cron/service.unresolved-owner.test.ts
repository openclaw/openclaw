import { expect, it, vi } from "vitest";
import * as clocks from "../test-utils/gateway-scheduler-clock.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { CRON_AGENT_SELECTION_REQUIRED_MESSAGE } from "./agent-id.js";
import { cronTestDeps, cronTestJob } from "./service.fixture-builders.test-support.js";
import {
  createCronServiceWithStateForTest,
  setupCronServiceSuite,
} from "./service.test-harness.js";
import { onTimer } from "./service/timer.test-support.js";
import { loadCronStore, saveCronStore } from "./store.js";
import type { CronJob } from "./types.js";

const { makeStorePath } = setupCronServiceSuite({ fakeTimers: false });

it.each(["startup", "reload"] as const)(
  "records the unowned job and keeps its owned sibling running during %s",
  async (phase) => {
    const { storePath } = await makeStorePath();
    const clock = clocks.createGatewaySchedulerClock(Date.now());
    const dueAt = clock.clock.now() + (phase === "startup" ? -60_000 : 1_000);
    const unowned = cronTestJob({
      id: "legacy-unowned",
      schedule: { kind: "every", everyMs: 60_000, anchorMs: dueAt },
      wakeMode: "now",
      payload: { kind: "command", argv: ["echo", "tick"] },
      state: { nextRunAtMs: dueAt },
    });
    const owned: CronJob = { ...structuredClone(unowned), id: "owned", agentId: "ops" };
    await saveCronStore(storePath, { version: 1, jobs: [unowned, owned] });
    const runCommandJob = vi.fn(async (_params: { job: CronJob }) => ({ status: "ok" as const }));
    const onEvent = vi.fn();
    let currentOwner: string | undefined = phase === "reload" ? "main" : undefined;
    const { cron, state } = createCronServiceWithStateForTest({
      ...cronTestDeps({ storePath }),
      scheduler: clocks.createTestGatewayScheduler(clock.clock),
      nowMs: () => clock.clock.now(),
      ...(phase === "reload" ? { defaultAgentId: "main" } : {}),
      resolveDefaultAgentId: () => currentOwner,
      runIsolatedAgentJob: vi.fn(),
      runCommandJob,
      onEvent,
    });

    const sql = observeMainThreadSql();
    try {
      sql.calibrate();
      await cron.start();
      if (phase !== "startup") {
        currentOwner = undefined;
        expect(cron.getDefaultAgentId()).toBeUndefined();
        expect((await cron.listPage({ agentId: "main" })).jobs).toEqual([]);
        await clock.advanceBy(1_000);
        await onTimer(state);
      }
      expect(sql.count(), `${phase} scheduler SQL stays off the caller thread`).toBe(0);
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: owned.id, action: "finished", status: "ok" }),
      );
      expect(runCommandJob).toHaveBeenCalledTimes(1);
      const persisted = (await loadCronStore(storePath)).jobs;
      expect(persisted.find((job) => job.id === unowned.id)?.state).toMatchObject({
        lastRunStatus: "skipped",
        lastError: CRON_AGENT_SELECTION_REQUIRED_MESSAGE,
      });
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: unowned.id,
          action: "finished",
          status: "skipped",
          completionStatus: "failed",
          error: CRON_AGENT_SELECTION_REQUIRED_MESSAGE,
        }),
      );

      await clock.advanceBy(60_000);
      await onTimer(state);
      expect(runCommandJob).toHaveBeenCalledTimes(2);
      expect(runCommandJob.mock.calls.every(([params]) => params.job.id === owned.id)).toBe(true);
    } finally {
      sql.restore();
      cron.stop();
    }
  },
);
