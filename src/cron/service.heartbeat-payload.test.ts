import { expect, it } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { heartbeatTaskDeclarationKey } from "../commands/doctor-heartbeat-task-identity.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import {
  createStartedCronServiceWithFinishedBarrier,
  setupCronServiceSuite,
} from "./service.test-harness.js";
import type { CronJobCreate } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite();

it("settles a migrated task through ordinary session execution without a heartbeat wake", async () => {
  const { storePath } = await makeStorePath();
  const entered = createDeferred();
  const release = createDeferred();
  let completed = false;
  const context = createStartedCronServiceWithFinishedBarrier({
    scheduler: createTestGatewayScheduler(),
    storePath,
    logger,
    runSessionEvent: async () => {
      entered.resolve();
      await release.promise;
      return { status: "ok" };
    },
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
    const added = await cron.add(input);
    const job = "job" in added ? added.job : added;
    const running = cron.run(job.id, "force").then((result) => {
      completed = true;
      return result;
    });
    await awaitGateBeforeSettlement(
      entered.promise,
      running,
      "Migrated task finished before reaching ordinary session execution",
    );
    expect(completed).toBe(false);
    expect(cron.getJob(job.id)?.state.lastStatus).not.toBe("ok");
    expect(context.runSessionEvent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        job: expect.objectContaining({ id: job.id, sessionTarget: "main" }),
        text: "Check urgent inbox items",
      }),
    );
    expect(context.enqueueSystemEvent).not.toHaveBeenCalled();
    release.resolve();
    await expect(running).resolves.toMatchObject({ ok: true });
    expect(cron.getJob(job.id)?.state.lastStatus).toBe("ok");
    await expect(
      cron.update(job.id, { payload: { kind: "systemEvent", text: "Check priority inbox" } }),
    ).resolves.toMatchObject({ id: job.id });
    await expect(cron.remove(job.id)).resolves.toEqual({ ok: true, removed: true });
  } finally {
    release.resolve();
    cron.stop();
    await cron.waitForIdle();
  }
});
