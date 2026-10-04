import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { AsyncWorkScope, getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { CronService } from "./service.js";
import { setupCronServiceSuite } from "./service.test-harness.js";
import type { CronEvent, CronServiceDeps } from "./service/state.js";
import { publishCronJobsStoreMutation } from "./store.js";
import { cronStoreKey } from "./store/key.js";
import { saveCronStoreInDatabase } from "./store/save.kernel.js";
import type { CronJob } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "cron-provisioning-" });

async function createFixture(runSchedulerOwned?: CronServiceDeps["runSchedulerOwned"]) {
  const { storePath } = await makeStorePath();
  const clock = createGatewaySchedulerClock(Date.now());
  const scheduler = createTestGatewayScheduler(clock.clock);
  const events: CronEvent[] = [];
  const runCommandJob = vi.fn(async () => ({ status: "ok" as const }));
  const cron = new CronService({
    scheduler,
    storePath,
    cronEnabled: true,
    log: logger,
    enqueueSystemEvent: vi.fn(),
    runIsolatedAgentJob: vi.fn(),
    runCommandJob,
    runSchedulerOwned,
    onEvent: (event) => events.push(event),
  });
  const now = scheduler.now();
  const job: CronJob = {
    id: "provisioned-job",
    name: "Provisioned job",
    agentId: "main",
    enabled: true,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: { kind: "at", at: new Date(now + 30_000).toISOString() },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "command", argv: ["fixture-command"] },
    delivery: { mode: "none" },
    state: { nextRunAtMs: now + 30_000 },
  };
  function commitJob(publish: boolean, rollback = false) {
    // A foreign writer commits without this process's revision publication.
    runOpenClawStateWriteTransaction((database) => {
      saveCronStoreInDatabase(database, cronStoreKey(storePath), { version: 1, jobs: [job] });
      if (publish) {
        publishCronJobsStoreMutation(storePath, database.db);
      }
      if (rollback) {
        throw new Error("injected provisioning rollback");
      }
    });
  }
  return { cron, clock, scheduler, job, events, runCommandJob, commitJob, storePath };
}

it.each(["local publication", "foreign commit readback"] as const)(
  "arms an empty scheduler after %s without restarting",
  async (mode) => {
    const fixture = await createFixture();
    const { cron, clock, scheduler, job, events, runCommandJob, commitJob } = fixture;
    try {
      await cron.start();
      expect(clock.armedAtMs).toBeNull();
      commitJob(mode === "local publication");
      if (mode === "local publication") {
        // A normal status read joins the queued publication; it cannot arm the timer itself.
        await cron.status();
      } else {
        await expect(cron.readJob(job.id)).resolves.toMatchObject({ id: job.id });
      }
      expect(events.filter((event) => event.action === "added")).toEqual([
        expect.objectContaining({ jobId: job.id, nextRunAtMs: job.state.nextRunAtMs }),
      ]);
      await cron.readJob(job.id);
      expect(events.filter((event) => event.action === "added")).toHaveLength(1);
      await clock.advanceBy(30_000);
      expect(runCommandJob).toHaveBeenCalledTimes(1);
      expect(events).toContainEqual(
        expect.objectContaining({ jobId: job.id, action: "finished", status: "ok" }),
      );
    } finally {
      cron.stop();
      await scheduler.stop();
    }
  },
);

it("withholds rolled-back provisioning and fences queued publication across stop", async () => {
  const { cron, clock, scheduler, events, runCommandJob, commitJob, storePath } =
    await createFixture();
  try {
    await cron.start();
    expect(() => commitJob(true, true)).toThrow("injected provisioning rollback");
    expect((await cron.status()).jobs).toBe(0);
    expect(clock.armedAtMs).toBeNull();
    expect(events).toEqual([]);

    commitJob(true);
    cron.stop();
    await cron.status();
    expect(clock.armedAtMs).toBeNull();
    expect(events).toEqual([]);

    await cron.start();
    publishCronJobsStoreMutation(storePath);
    await cron.status();
    await clock.advanceBy(30_000);
    expect(runCommandJob).toHaveBeenCalledTimes(1);
  } finally {
    cron.stop();
    await scheduler.stop();
  }
});

it("drains accepted provisioning work outside the publisher's temporary scope", async () => {
  const entered = createDeferred();
  const release = createDeferred();
  const publisher = new AsyncWorkScope();
  let holdRefresh = false;
  let refreshSettled = false;
  let publisherSignal: AbortSignal | undefined;
  const { cron, scheduler, events, commitJob } = await createFixture(async (run) => {
    if (!holdRefresh) {
      return await run();
    }
    publisherSignal = getAsyncWorkSignal();
    entered.resolve();
    await release.promise;
    try {
      return await run();
    } finally {
      refreshSettled = true;
    }
  });
  try {
    await cron.start();
    holdRefresh = true;
    publisher.run(() => commitJob(true));
    await entered.promise;
    await publisher.drain();
    expect(publisherSignal).toBeUndefined();

    cron.stop();
    const drainedAfterRefresh = cron.waitForIdle().then(() => refreshSettled);
    // A separate store operation can settle while accepted provisioning is still suspended.
    await cron.status();
    release.resolve();
    expect(await drainedAfterRefresh).toBe(true);
    expect(events).toEqual([]);
  } finally {
    release.resolve();
    cron.stop();
    await cron.waitForIdle();
    await scheduler.stop();
    await publisher.drain();
  }
});
