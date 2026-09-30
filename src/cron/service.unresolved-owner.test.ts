import { describe, expect, it, vi } from "vitest";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { CRON_AGENT_SELECTION_REQUIRED_MESSAGE } from "./agent-id.js";
import { CronService } from "./service.js";
import { setupCronServiceSuite } from "./service.test-harness.js";
import { loadCronStore, saveCronStore } from "./store.js";
import type { CronJob } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({ fakeTimers: false });

describe("cron jobs with unresolved owners", () => {
  it.each([
    {
      phase: "startup",
      includeOwned: true,
      name: "records the unowned job and keeps its owned sibling running",
    },
    {
      phase: "reload",
      includeOwned: true,
      name: "records the unowned job and keeps its owned sibling running",
    },
    {
      phase: "startup",
      includeOwned: false,
      name: "records an ownerless job without caller-thread SQL",
    },
    {
      phase: "reload",
      includeOwned: false,
      name: "records an ownerless job without caller-thread SQL",
    },
  ] as const)("$name during $phase", async ({ phase, includeOwned }) => {
    const { storePath, cleanup } = await makeStorePath();
    const now = Date.now();
    const clock = createGatewaySchedulerClock(now);
    const dueAt = phase === "startup" ? now - 60_000 : now + 1_000;
    const unowned: CronJob = {
      id: "legacy-unowned",
      name: "legacy unowned command",
      enabled: true,
      createdAtMs: now - 120_000,
      updatedAtMs: now - 120_000,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: dueAt },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "command", argv: ["echo", "tick"] },
      state: { nextRunAtMs: dueAt },
    };
    const owned: CronJob = { ...structuredClone(unowned), id: "owned", agentId: "ops" };
    await saveCronStore(storePath, {
      version: 1,
      jobs: includeOwned ? [unowned, owned] : [unowned],
    });
    const runCommandJob = vi.fn(async (_params: { job: CronJob }) => ({ status: "ok" as const }));
    const onEvent = vi.fn();
    let currentOwner: string | undefined = phase === "reload" ? "main" : undefined;
    const cron = new CronService({
      scheduler: createTestGatewayScheduler(clock.clock),
      storePath,
      cronEnabled: true,
      log: logger,
      ...(phase === "reload" ? { defaultAgentId: "main" } : {}),
      resolveDefaultAgentId: () => currentOwner,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(),
      runCommandJob,
      onEvent,
    });

    try {
      const sql = includeOwned ? undefined : observeMainThreadSql();
      try {
        sql?.calibrate();
        await cron.start();
        if (phase !== "startup") {
          currentOwner = undefined;
          expect(cron.getDefaultAgentId()).toBeUndefined();
          expect((await cron.listPage({ agentId: "main" })).jobs).toEqual([]);
          await clock.advanceBy(1_000);
        }
        if (sql) {
          expect(sql.count(), `${phase} ownerless SQL stays off the caller thread`).toBe(0);
        }
      } finally {
        sql?.restore();
      }
      if (includeOwned) {
        expect(onEvent).toHaveBeenCalledWith(
          expect.objectContaining({ jobId: owned.id, action: "finished", status: "ok" }),
        );
        expect(runCommandJob).toHaveBeenCalledWith(
          expect.objectContaining({ job: expect.objectContaining({ id: owned.id }) }),
        );
      }
      expect(runCommandJob).toHaveBeenCalledTimes(includeOwned ? 1 : 0);
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
      expect(runCommandJob).toHaveBeenCalledTimes(includeOwned ? 2 : 0);
      expect(runCommandJob.mock.calls.every(([params]) => params.job.id === owned.id)).toBe(true);
    } finally {
      cron.stop();
      await cleanup();
    }
  });
});
