import { describe, expect, it, vi } from "vitest";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { readCronRunHistoryPageForTests } from "./run-history.test-support.js";
import { CronService } from "./service.js";
import { setupCronServiceSuite } from "./service.test-harness.js";
import type { CronServiceDeps } from "./service/state.js";
import { cronStoreKey } from "./store/key.js";
import type { CronJobCreate } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "cron-manual-trigger-" });

const watcher: CronJobCreate = {
  name: "watcher",
  enabled: true,
  schedule: { kind: "cron", expr: "0 */6 * * *", tz: "UTC", staggerMs: 0 },
  trigger: { script: "return { fire: false }" },
  sessionTarget: "isolated",
  wakeMode: "now",
  payload: { kind: "agentTurn", message: "Report new posts." },
};

async function startService(
  evaluateCronTrigger: NonNullable<CronServiceDeps["evaluateCronTrigger"]>,
) {
  const store = await makeStorePath();
  const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
  const cron = new CronService({
    scheduler: createTestGatewayScheduler(),
    nowMs: () => Date.now(),
    storePath: store.storePath,
    cronEnabled: true,
    log: logger,
    cronConfig: { triggers: { enabled: true } },
    enqueueSystemEvent: vi.fn(),
    runSessionEvent: vi.fn(async () => ({ status: "ok" as const })),
    runIsolatedAgentJob,
    evaluateCronTrigger: vi.fn(evaluateCronTrigger),
  });
  await cron.start();
  const runNow = async (jobId: string, skipTrigger?: boolean) => {
    const ack = await cron.enqueueRun(jobId, "force", skipTrigger ? { skipTrigger } : undefined);
    if (!("enqueued" in ack)) {
      throw new Error("manual run was not queued");
    }
    await cron.waitForManualRun(ack.runId, 10_000);
    const history = readCronRunHistoryPageForTests({
      storeKey: cronStoreKey(store.storePath),
      jobId,
    }).entries;
    return { ack, history };
  };
  return { cron, store, runIsolatedAgentJob, runNow };
}

describe("manual run of a triggered automation", () => {
  it("evaluates the trigger and records a quiet check with its message", async () => {
    const h = await startService(async () => ({
      kind: "evaluated",
      fire: false,
      message: "no new posts",
      state: { cursor: 2 },
    }));
    try {
      const job = await h.cron.add(watcher);
      const { ack, history } = await h.runNow(job.id);
      expect(ack).not.toHaveProperty("trigger");
      expect(h.runIsolatedAgentJob).not.toHaveBeenCalled();
      expect(history).toMatchObject([
        {
          status: "skipped",
          error: "Trigger did not fire: no new posts. The payload did not run.",
        },
      ]);
      // A manual run is a real occurrence: its state advances.
      expect(h.cron.getJob(job.id)?.state.triggerState).toEqual({ cursor: 2 });
      expect(h.cron.getJob(job.id)?.enabled).toBe(true);
    } finally {
      h.cron.stop();
      await h.store.cleanup();
    }
  });

  it("runs the payload only when asked to skip the trigger, and says so", async () => {
    const h = await startService(async () => ({ kind: "evaluated", fire: false }));
    try {
      const job = await h.cron.add(watcher);
      const { ack, history } = await h.runNow(job.id, true);
      expect(ack).toMatchObject({
        trigger: "Trigger skipped: the trigger script was not tested.",
      });
      expect(h.runIsolatedAgentJob).toHaveBeenCalledOnce();
      expect(history).toMatchObject([{ status: "ok" }]);
    } finally {
      h.cron.stop();
      await h.store.cleanup();
    }
  });
});
