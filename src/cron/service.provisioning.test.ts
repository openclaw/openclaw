import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { AsyncWorkScope, getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import {
  createCronServiceWithStateForTest,
  setupCronServiceSuite,
  writeCronStoreSnapshot,
} from "./service.test-harness.js";
import type { CronServiceDeps } from "./service/state.js";
import { onTimer } from "./service/timer.test-support.js";
import * as cronStore from "./store.js";
import { publishCronJobsStoreMutation } from "./store.js";
import { cronStoreKey } from "./store/key.js";
import { loadCronStoreFromDatabase } from "./store/load.kernel.js";
import { saveCronStoreInDatabase } from "./store/save.kernel.js";
import type { CronEvent, CronJob } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "cron-provisioning-" });

async function createFixture(runSchedulerOwned?: CronServiceDeps["runSchedulerOwned"]) {
  const { storePath } = await makeStorePath();
  const clock = createGatewaySchedulerClock(Date.now());
  const scheduler = createTestGatewayScheduler(clock.clock);
  const events: CronEvent[] = [];
  const runCommandJob = vi.fn(async () => ({ status: "ok" as const }));
  const { cron, state } = createCronServiceWithStateForTest({
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
  return { cron, state, clock, scheduler, job, events, runCommandJob, commitJob, storePath };
}

it.each(["restart", "local publication", "foreign commit readback"] as const)(
  "adopts committed provisioning after %s",
  async (mode) => {
    const fixture = await createFixture();
    const { cron, state, clock, scheduler, job, events, runCommandJob, commitJob } = fixture;
    using loads = vi.spyOn(cronStore, "loadCronJobsStoreWithConfigJobs");
    try {
      await cron.start();
      expect((await cron.status()).nextWakeAtMs).toBeNull();
      if (mode === "restart") {
        expect(loads).toHaveBeenCalledTimes(1);
        await cron.start();
        expect(loads).toHaveBeenCalledTimes(1);
        cron.stop();
        await cron.waitForIdle();
        await cron.start();
        expect(loads).toHaveBeenCalledTimes(1);
        cron.stop();
        await cron.waitForIdle();
      }
      commitJob(mode !== "foreign commit readback");
      if (mode === "restart") {
        await cron.start();
        expect(loads).toHaveBeenCalledTimes(2);
        expect(cron.getJob(job.id)).toMatchObject(job);
      } else if (mode === "local publication") {
        // A status read joins the queued publication; the worker owns the timer.
        await cron.status();
      } else {
        await expect(cron.readJob(job.id)).resolves.toMatchObject({ id: job.id });
      }
      expect((await cron.status()).nextWakeAtMs).toBe(job.state.nextRunAtMs);
      if (mode !== "restart") {
        expect(events.filter((event) => event.action === "added")).toEqual([
          expect.objectContaining({ jobId: job.id, nextRunAtMs: job.state.nextRunAtMs }),
        ]);
        await cron.readJob(job.id);
        expect(events.filter((event) => event.action === "added")).toHaveLength(1);
      }
      clock.setTime(clock.clock.now() + 30_000);
      await onTimer(state);
      expect(runCommandJob).toHaveBeenCalledTimes(1);
      expect(events).toContainEqual(
        expect.objectContaining({ jobId: job.id, action: "finished", status: "ok" }),
      );
    } finally {
      cron.stop();
      await cron.waitForIdle();
      await scheduler.stop();
    }
  },
);

it("withholds rolled-back provisioning and fences queued publication across stop", async () => {
  const { cron, state, clock, scheduler, events, runCommandJob, commitJob, storePath } =
    await createFixture();
  try {
    await cron.start();
    expect(() => commitJob(true, true)).toThrow("injected provisioning rollback");
    expect((await cron.status()).jobs).toBe(0);
    expect((await cron.status()).nextWakeAtMs).toBeNull();
    expect(events).toEqual([]);

    commitJob(true);
    cron.stop();
    await cron.status();
    await cron.waitForIdle();
    expect(runCommandJob).not.toHaveBeenCalled();
    expect(events).toEqual([]);

    await cron.start();
    publishCronJobsStoreMutation(storePath);
    await cron.status();
    clock.setTime(clock.clock.now() + 30_000);
    await onTimer(state);
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

it("reconciles non-timed jobs provisioned while startup execution is pending", async ({
  signal,
}) => {
  const { cron, state, scheduler, job, events, runCommandJob, storePath } = await createFixture();
  const entered = createDeferred();
  const release = createDeferred();
  const startup: CronJob = {
    ...job,
    id: "startup-command",
    name: "Startup command",
    deleteAfterRun: false,
    schedule: { kind: "at", at: new Date(scheduler.now() - 1).toISOString() },
    state: { nextRunAtMs: scheduler.now() - 1 },
  };
  const provisioned: CronJob = {
    ...job,
    id: "provisioned-on-exit",
    name: "Provisioned exit watcher",
    schedule: { kind: "on-exit", command: "fixture-exit-command" },
    state: {},
  };
  await writeCronStoreSnapshot({ storePath, jobs: [startup] });
  const reconciliation = vi.fn(async () => {
    // Watcher reconciliation reads through the facade, outside its mutation lock.
    return (await cron.list({ includeDisabled: true })).map((entry) => entry.id);
  });
  state.deps.onProvisionedJobsReloaded = async () => {
    await reconciliation();
  };
  runCommandJob.mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    return { status: "ok" as const };
  });
  const starting = cron.start();
  try {
    await withinTest(
      awaitGateBeforeSettlement(
        entered.promise,
        starting,
        "Startup did not execute its due command",
      ),
      signal,
    );
    runOpenClawStateWriteTransaction((database) => {
      const storeKey = cronStoreKey(storePath);
      const current = loadCronStoreFromDatabase(database.db, storeKey).store;
      saveCronStoreInDatabase(database, storeKey, {
        version: 1,
        jobs: [...current.jobs, provisioned],
      });
      publishCronJobsStoreMutation(storePath, database.db);
    });
    expect(reconciliation).not.toHaveBeenCalled();
    release.resolve();
    await withinTest(starting, signal);
    expect(events.filter((event) => event.action === "added")).toEqual([
      expect.objectContaining({
        jobId: provisioned.id,
        job: expect.objectContaining({ id: provisioned.id, schedule: provisioned.schedule }),
      }),
    ]);
    expect(reconciliation).toHaveBeenCalledOnce();
    await expect(reconciliation.mock.results[0]?.value).resolves.toContain(provisioned.id);
    expect(cron.getJob(provisioned.id)).toMatchObject(provisioned);
    expect(runCommandJob).toHaveBeenCalledOnce();
  } finally {
    release.resolve();
    cron.stop();
    await starting;
    await cron.waitForIdle();
    await scheduler.stop();
  }
});
