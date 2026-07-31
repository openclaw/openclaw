import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { GatewayCronServiceContract } from "../gateway/server-cron-contract.js";
import { makeCronJob } from "./delivery.test-helpers.js";
import {
  beginLegacyDefaultOwnerHandoff,
  type LiveCronOwnerMigration,
  registerLiveCronService,
} from "./live-service-registry.js";
import { CronService } from "./service.js";
import { loadCronJobsStoreWithConfigJobs, saveCronStore } from "./store.js";

function createDeferred() {
  let resolve = () => {};
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("live cron ownership handoff", () => {
  it("keeps the real service signatures aligned with live and Gateway contracts", () => {
    expectTypeOf<CronService>().toMatchTypeOf<GatewayCronServiceContract>();
    expectTypeOf<CronService["beginLegacyDefaultAgentOwnerHandoff"]>().toEqualTypeOf<
      LiveCronOwnerMigration["beginLegacyDefaultAgentOwnerHandoff"]
    >();
  });

  it("locks existing services and blocks later starters until release", async () => {
    const storePath = `/tmp/openclaw-live-cron-${Date.now()}.json`;
    const lockAcquired = createDeferred();
    const releaseServiceLock = vi.fn();
    const firstService = {
      beginLegacyDefaultAgentOwnerHandoff: vi.fn(async () => {
        await lockAcquired.promise;
        return {
          migration: { changes: ["locked"], warnings: [] },
          release: releaseServiceLock,
        };
      }),
      refreshLegacyDefaultAgentOwnerHandoff: vi.fn(async () => {}),
    };
    const firstRegistration = registerLiveCronService(storePath, firstService);
    await firstRegistration.ready;
    const handoff = beginLegacyDefaultOwnerHandoff({
      storePath,
      legacyDefaultAgentId: "ops",
    });
    let drained = false;
    const drain = handoff.drainAndSeal().then((result) => {
      drained = true;
      return result;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    const joiningService = {
      beginLegacyDefaultAgentOwnerHandoff: vi.fn(async () => ({
        migration: { changes: [], warnings: [] },
        release: vi.fn(),
      })),
      refreshLegacyDefaultAgentOwnerHandoff: vi.fn(async () => {}),
    };
    const joiningRegistration = registerLiveCronService(storePath, joiningService);
    let joiningReady = false;
    void joiningRegistration.ready.then(() => {
      joiningReady = true;
    });
    await Promise.resolve();
    expect(joiningReady).toBe(false);
    expect(joiningService.beginLegacyDefaultAgentOwnerHandoff).not.toHaveBeenCalled();

    lockAcquired.resolve();
    await expect(drain).resolves.toMatchObject({ changes: ["locked"], warnings: [] });
    expect(releaseServiceLock).not.toHaveBeenCalled();
    handoff.release();
    await expect(joiningRegistration.ready).resolves.toBeUndefined();
    expect(joiningReady).toBe(true);
    expect(releaseServiceLock).toHaveBeenCalledOnce();
    firstRegistration.unregister();
    joiningRegistration.unregister();
  });

  it("migrates once and refreshes a second live service sharing the store", async () => {
    const storePath = `/tmp/openclaw-live-cron-shared-${Date.now()}.json`;
    const releaseStoreLock = vi.fn();
    const leader = {
      beginLegacyDefaultAgentOwnerHandoff: vi.fn(async () => ({
        migration: { changes: ["migrated once"], warnings: [] },
        release: releaseStoreLock,
      })),
      refreshLegacyDefaultAgentOwnerHandoff: vi.fn(async () => {}),
    };
    const follower = {
      beginLegacyDefaultAgentOwnerHandoff: vi.fn(async () => {
        throw new Error("the follower must not acquire the shared store lock");
      }),
      refreshLegacyDefaultAgentOwnerHandoff: vi.fn(async () => {}),
    };
    const leaderRegistration = registerLiveCronService(storePath, leader);
    const followerRegistration = registerLiveCronService(storePath, follower);
    await Promise.all([leaderRegistration.ready, followerRegistration.ready]);

    const handoff = beginLegacyDefaultOwnerHandoff({
      storePath,
      legacyDefaultAgentId: "ops",
    });
    await expect(handoff.drainAndSeal()).resolves.toEqual({
      changes: ["migrated once"],
      warnings: [],
    });
    expect(leader.beginLegacyDefaultAgentOwnerHandoff).toHaveBeenCalledOnce();
    expect(follower.beginLegacyDefaultAgentOwnerHandoff).not.toHaveBeenCalled();
    expect(follower.refreshLegacyDefaultAgentOwnerHandoff).toHaveBeenCalledWith({
      persistSchedulingState: false,
    });
    expect(releaseStoreLock).not.toHaveBeenCalled();

    await handoff.refreshSealedServices();
    expect(leader.refreshLegacyDefaultAgentOwnerHandoff).toHaveBeenCalledWith({
      persistSchedulingState: true,
    });
    expect(follower.refreshLegacyDefaultAgentOwnerHandoff).toHaveBeenCalledTimes(2);
    expect(follower.refreshLegacyDefaultAgentOwnerHandoff).toHaveBeenNthCalledWith(2, {
      persistSchedulingState: false,
    });
    expect(leader.refreshLegacyDefaultAgentOwnerHandoff.mock.invocationCallOrder[0]).toBeLessThan(
      follower.refreshLegacyDefaultAgentOwnerHandoff.mock.invocationCallOrder[1]!,
    );

    handoff.release();
    expect(releaseStoreLock).toHaveBeenCalledOnce();
    leaderRegistration.unregister();
    followerRegistration.unregister();
  });

  it("does not start cron work after stop wins while registration is waiting", async () => {
    const storePath = `/tmp/openclaw-live-cron-cancel-${Date.now()}.json`;
    const handoff = beginLegacyDefaultOwnerHandoff({
      storePath,
      legacyDefaultAgentId: "ops",
    });
    const cron = new CronService({
      storePath,
      cronEnabled: true,
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    const start = cron.start();
    await Promise.resolve();
    cron.stop();
    handoff.release();
    await start;
    expect(cron.getLoadedJobs()).toBeUndefined();
  });

  it("keeps the restarted generation registered after stale cleanup finishes", async () => {
    const storePath = `/tmp/openclaw-live-cron-restart-${Date.now()}.json`;
    const blockingHandoff = beginLegacyDefaultOwnerHandoff({
      storePath,
      legacyDefaultAgentId: "ops",
    });
    const cron = new CronService({
      storePath,
      cronEnabled: true,
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    const staleStart = cron.start();
    await Promise.resolve();
    cron.stop();
    const restarted = cron.start();
    blockingHandoff.release();
    await Promise.all([staleStart, restarted]);

    const beginSpy = vi.spyOn(cron, "beginLegacyDefaultAgentOwnerHandoff");
    const verificationHandoff = beginLegacyDefaultOwnerHandoff({
      storePath,
      legacyDefaultAgentId: "ops",
    });
    await verificationHandoff.drainAndSeal();
    expect(beginSpy).toHaveBeenCalledOnce();
    verificationHandoff.release();
    cron.stop();
  });

  it("forwards commit-fence callbacks through a real service leader", async () => {
    const storePath = `/tmp/openclaw-live-cron-fence-${Date.now()}.json`;
    await saveCronStore(storePath, {
      version: 1,
      jobs: [makeCronJob({ id: "ownerless-fenced-job" })],
    });
    const loaded = await loadCronJobsStoreWithConfigJobs(storePath);
    const beforeMigration = vi.fn(async () => {});
    const expectedStoreEpoch = vi.fn(() => loaded.storeEpoch);
    const recordCommittedStoreEpoch = vi.fn();
    const cron = new CronService({
      storePath,
      cronEnabled: true,
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await cron.start();
    const handoff = beginLegacyDefaultOwnerHandoff({
      storePath,
      legacyDefaultAgentId: "ops",
      beforeMigration,
      expectedStoreEpoch,
      recordCommittedStoreEpoch,
    });
    try {
      await handoff.drainAndSeal();
      expect(beforeMigration).toHaveBeenCalledOnce();
      expect(expectedStoreEpoch).toHaveBeenCalled();
      expect(recordCommittedStoreEpoch).toHaveBeenCalledOnce();
      expect((await loadCronJobsStoreWithConfigJobs(storePath)).store.jobs[0]?.agentId).toBe("ops");
    } finally {
      handoff.release();
      cron.stop();
    }
  });
});
