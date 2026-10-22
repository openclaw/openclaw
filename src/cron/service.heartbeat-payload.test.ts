import { expect, it } from "vitest";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { heartbeatTaskDeclarationKey } from "./heartbeat-task.js";
import {
  createStartedCronServiceWithFinishedBarrier,
  setupCronServiceSuite,
} from "./service.test-harness.js";
import type { CronJobCreate } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite();

// The private task adapter remains until the heartbeat executor retirement slice.
it("routes a private legacy task through the guarded heartbeat wake", async () => {
  const { storePath } = await makeStorePath();
  const context = createStartedCronServiceWithFinishedBarrier({
    scheduler: createTestGatewayScheduler(),
    storePath,
    logger,
  });
  const { cron } = context;
  try {
    await cron.start();
    const input: CronJobCreate = {
      declarationKey: heartbeatTaskDeclarationKey("main", "inbox"),
      agentId: "main",
      name: "inbox",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { kind: "systemEvent", text: "Check urgent inbox items" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
    };
    await expect(cron.add(input)).rejects.toThrow(/system-owned/);
    const added = await cron.add(input, { systemOwned: true });
    const job = "job" in added ? added.job : added;
    await expect(cron.run(job.id, "force")).resolves.toMatchObject({ ok: true });
    expect(context.requestHeartbeatAndWait).toHaveBeenCalledWith(
      {
        source: "interval",
        intent: "task",
        reason: `heartbeat-task:${job.id}`,
        agentId: "main",
        tasks: [{ jobId: job.id, name: "inbox", prompt: "Check urgent inbox items" }],
      },
      expect.objectContaining({ abortSignal: expect.any(AbortSignal) }),
    );
    expect(context.requestHeartbeat).not.toHaveBeenCalled();
    expect(context.enqueueSystemEvent).not.toHaveBeenCalled();
    expect(context.runSessionEvent).not.toHaveBeenCalled();
    await expect(
      cron.update(job.id, { payload: { kind: "systemEvent", text: "Check priority inbox" } }),
    ).resolves.toMatchObject({ id: job.id });
    await expect(cron.remove(job.id)).resolves.toEqual({ ok: true, removed: true });
  } finally {
    cron.stop();
    await cron.waitForIdle();
  }
});
