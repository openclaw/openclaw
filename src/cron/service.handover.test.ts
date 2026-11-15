import { expect, it, vi } from "vitest";
import { createDueIsolatedJob } from "../../test/helpers/cron/service-regression-fixtures.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { CronService } from "./service.js";
import { setupCronServiceSuite } from "./service.test-harness.js";
import { saveCronStore } from "./store.js";
import type { CronJob } from "./types.js";

const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-handover-",
  fakeTimers: false,
});

it("lets a handed-over run finish once while its replacement recovers the store", async ({
  signal,
}) => {
  const { storePath } = await makeStorePath();
  const job: CronJob = {
    ...createDueIsolatedJob({ id: "handover-running", nowMs: NOW, nextRunAtMs: NOW + 60_000 }),
    agentId: "main",
    payload: { kind: "command", argv: ["synthetic", "handover-running"] },
  };
  await saveCronStore(storePath, { version: 1, jobs: [job] });
  const entered = createDeferred();
  const release = createDeferred();
  const onEvent = vi.fn();
  const runCommandJob = vi.fn(async () => {
    entered.resolve();
    await release.promise;
    return { status: "ok" as const };
  });
  const createService = () =>
    new CronService({
      scheduler: createTestGatewayScheduler(),
      nowMs: () => NOW,
      storePath,
      cronEnabled: true,
      defaultAgentId: "main",
      log: logger,
      enqueueSystemEvent() {},
      requestHeartbeat() {},
      runIsolatedAgentJob: async () => ({ status: "ok" }),
      runCommandJob,
      onEvent,
    });
  const previous = createService();
  const replacement = createService();
  let completion: Promise<unknown> | undefined;
  try {
    await previous.start();
    completion = previous.run(job.id, "force");
    await withinTest(
      awaitGateBeforeSettlement(entered.promise, completion, "run did not start"),
      signal,
    );
    previous.handOver();
    await withinTest(replacement.start(), signal);
    expect((await replacement.readJob(job.id))?.state.runningReceiptId).toBeDefined();
    expect(onEvent.mock.calls.filter(([event]) => event.action === "finished")).toHaveLength(0);
    expect(runCommandJob).toHaveBeenCalledOnce();
    release.resolve();
    await expect(withinTest(completion, signal)).resolves.toMatchObject({ ok: true, ran: true });
    expect((await replacement.readJob(job.id))?.state).toMatchObject({ lastRunStatus: "ok" });
    expect(onEvent.mock.calls.filter(([event]) => event.action === "finished")).toHaveLength(1);
    expect(runCommandJob).toHaveBeenCalledOnce();
  } finally {
    release.resolve();
    await completion;
    previous.stop();
    replacement.stop();
    await Promise.all([previous.waitForIdle(), replacement.waitForIdle()]);
  }
});
