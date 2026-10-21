import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { HeartbeatRunResult } from "../infra/heartbeat-wake.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { heartbeatTaskDeclarationKey } from "./heartbeat-task.js";
import { cronTestJob } from "./service.fixture-builders.test-support.js";
import {
  createStartedCronServiceWithFinishedBarrier,
  setupCronServiceSuite,
} from "./service.test-harness.js";
import { loadCronStore, saveCronStore } from "./store.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-startup-heartbeat-",
  fakeTimers: false,
});

// The private task adapter remains until the heartbeat executor retirement slice.
it("defers an overdue private legacy task without awaiting its heartbeat", async () => {
  const store = await makeStorePath();
  const scheduler = createTestGatewayScheduler();
  const now = scheduler.now();
  const job = cronTestJob({
    id: "overdue-legacy-task",
    name: "legacy task",
    declarationKey: heartbeatTaskDeclarationKey("main", "inbox"),
    agentId: "main",
    createdAtMs: now - 120_000,
    updatedAtMs: now - 120_000,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: now - 120_000 },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "Check the inbox" },
    state: { nextRunAtMs: now - 60_000 },
  });
  await saveCronStore(store.storePath, { version: 1, jobs: [job] });
  const entered = createDeferred<"heartbeat">();
  const release = createDeferred<HeartbeatRunResult>();
  const requestHeartbeatAndWait = vi.fn(async () => {
    entered.resolve("heartbeat");
    return await release.promise;
  });
  const { cron } = createStartedCronServiceWithFinishedBarrier({
    scheduler,
    storePath: store.storePath,
    logger,
    requestHeartbeatAndWait,
    resolveHeartbeatTimeoutMs: () => undefined,
  });
  const starting = cron.start();
  try {
    expect(await Promise.race([starting.then(() => "started"), entered.promise])).toBe("started");
    expect(requestHeartbeatAndWait).not.toHaveBeenCalled();
    const persisted = (await loadCronStore(store.storePath)).jobs.find(
      (entry) => entry.id === job.id,
    );
    expect(persisted).toMatchObject({
      enabled: true,
      state: { nextRunAtMs: now + 120_000, startupCatchupAtMs: now + 120_000 },
    });
  } finally {
    release.resolve({ status: "skipped", reason: "disabled" });
    await starting;
    cron.stop();
    await cron.waitForIdle();
    await store.cleanup();
  }
});
