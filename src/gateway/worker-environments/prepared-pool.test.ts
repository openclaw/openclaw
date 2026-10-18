import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../../test-utils/gateway-scheduler-clock.js";
import type { WorkerProviderPreparedIntent } from "./preparation-identity.js";
import {
  IDLE_TIMEOUT_MS,
  PREPARATION_KEY,
  RECEIPT,
  usePreparedPoolFixture,
  type PoolOptions,
} from "./prepared-pool.test-support.js";
import { createWorkerEnvironmentService, type WorkerEnvironmentService } from "./service.js";
import type { WorkerEnvironmentRecord } from "./store.js";

describe("prepared worker reserve lifecycle", () => {
  const fixture = usePreparedPoolFixture();
  const { seed, ready, attach, schedule, pool, reserves } = fixture;
  const seedReady = async (...args: Parameters<typeof seed>) => ready(await seed(...args));
  const activeSource = async (...args: Parameters<typeof seed>) => attach(await seedReady(...args));
  function service(overrides: Partial<Parameters<typeof createWorkerEnvironmentService>[0]> = {}) {
    return (fixture.service = createWorkerEnvironmentService({
      scheduler: overrides.scheduler ?? createTestGatewayScheduler(),
      store: fixture.store,
      getConfig: () => fixture.config,
      resolveProvider: () => fixture.provider,
      prepareInstallation: async () => ({
        install: "bundle",
        ...RECEIPT,
        tarballBytes: 1,
        tarballSha256: "e".repeat(64),
        tarballPath: path.join(fixture.root, "unused.tgz"),
      }),
      bootstrapWorker: async () => RECEIPT,
      now: () => fixture.nowMs,
      ...overrides,
    }));
  }
  it("cleans expired reserves and refills healthy projects after another provider's resolution fails", async () => {
    const expired = await seedReady("expired", { reserve: true });
    fixture.nowMs = 1_500;
    await activeSource("healthy", { projectKey: "c".repeat(64) });
    fixture.config.cloudWorkers!.profiles!.broken = { provider: "broken" };
    await attach(
      await ready(
        await fixture.store.createIntent({
          environmentId: "broken",
          providerId: "broken",
          profileId: "broken",
          profileSnapshot: fixture.profile(),
          provisionOperationId: "provision:broken",
        }),
      ),
    );
    fixture.nowMs = 2_000;
    const reconcile = vi.fn<PoolOptions["reconcile"]>(async () => {});
    const owner = pool({
      reconcile,
      resolveProvider: (id) => {
        if (id !== "broken") {
          return fixture.provider;
        }
        throw new Error("provider resolution failed");
      },
    });
    await schedule(owner);
    expect(fixture.store.get(expired.environmentId)?.destroyRequestedAtMs).toBe(fixture.nowMs);
    expect(reconcile.mock.calls.map(([record]) => record)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          environmentId: expired.environmentId,
          destroyRequestedAtMs: fixture.nowMs,
        }),
        expect.objectContaining({ preparation: expect.objectContaining({ demandAtMs: 1_500 }) }),
      ]),
    );
  });

  it("does not seed demand from a cold attachment still syncing after database reopen", async () => {
    const attached = await attach(await seedReady("syncing-cold"), "syncing");
    await fixture.reopenStore();
    const owner = pool();
    await owner.noteDemand(attached.environmentId);
    await schedule(owner);
    expect(fixture.provider.notePreparedDemand).not.toHaveBeenCalled();
    expect(reserves()).toEqual([]);
  });

  it("starts a full idle window after a long first sync without extending it on detach", async () => {
    const idleWindow = 15 * 60_000;
    fixture.provider.resolvePreparedIdleTimeoutMs = () => idleWindow;
    const allocated = await seedReady("slow-first-checkout");
    const activatedAtMs = fixture.nowMs + 16 * 60_000;
    const attached = await attach(allocated, "active", activatedAtMs);
    const owner = pool();
    await owner.noteDemand(attached.environmentId);
    await schedule(owner);
    const reserve = reserves()[0]!;
    expect(reserve.preparation).toMatchObject({
      demandAtMs: activatedAtMs,
      expiresAtMs: activatedAtMs + idleWindow,
    });
    expect(fixture.provider.notePreparedDemand).toHaveBeenCalledWith(
      { leaseId: attached.leaseId, profile: {} },
      { preparationKey: PREPARATION_KEY, demandAtMs: activatedAtMs },
    );

    fixture.nowMs += 60_000;
    await fixture.store.transition({
      environmentId: attached.environmentId,
      from: "attached",
      to: "idle",
    });
    await owner.noteDemand(attached.environmentId);
    await schedule(owner);
    expect(fixture.provider.notePreparedDemand).toHaveBeenCalledOnce();
    expect(fixture.store.get(reserve.environmentId)?.preparation).toEqual(reserve.preparation);
    fixture.nowMs = activatedAtMs + idleWindow;
    await schedule(owner);
    expect(reserves()).toHaveLength(1);
    expect(fixture.store.get(reserve.environmentId)?.destroyRequestedAtMs).toBe(fixture.nowMs);
  });

  it.each([false, true])(
    "retains slow activation demand when teardown precedes refill (reserve=%s)",
    async (reserve) => {
      const idleWindow = 15 * 60_000;
      fixture.provider.resolvePreparedIdleTimeoutMs = () => idleWindow;
      const allocated = await seedReady("slow-activation", { reserve });
      const activatedAtMs = fixture.nowMs + 16 * 60_000;
      const attached = await attach(allocated, "active", activatedAtMs);
      fixture.nowMs += 60_000;
      await fixture.teardown(attached);
      await fixture.reopenStore();

      await schedule(pool());
      const replacement = reserves().filter((record) => record.preparation?.consumedAtMs === null);
      expect(replacement).toHaveLength(1);
      expect(replacement[0]?.preparation).toMatchObject({
        demandAtMs: activatedAtMs,
        expiresAtMs: activatedAtMs + idleWindow,
      });
    },
  );

  it("does not allocate when source preparation finishes after its demand deadline", async () => {
    await activeSource("source");
    const reconcile = vi.fn<PoolOptions["reconcile"]>(async () => {});
    await schedule(
      pool({
        prepareIntent: async () => {
          fixture.nowMs = 2_000;
          return {
            providerId: fixture.provider.id,
            profileSnapshot: fixture.profile(),
            preparationKey: PREPARATION_KEY,
          };
        },
        reconcile,
      }),
    );
    expect(reserves()).toEqual([]);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("retires excess then disabled profile capacity without touching an attached session", async () => {
    fixture.developmentProfile.provider = fixture.provider.id;
    fixture.developmentProfile.readyWorkers = 3;
    const source = await activeSource("source");
    await schedule(pool());
    expect(reserves()).toHaveLength(3);
    for (const reserve of reserves()) {
      await ready(reserve);
    }
    fixture.developmentProfile.readyWorkers = 1;
    fixture.nowMs = 1_100;
    await schedule(pool());
    expect(reserves().filter((record) => record.destroyRequestedAtMs === null)).toHaveLength(1);
    expect(reserves().filter((record) => record.destroyRequestedAtMs === 1_100)).toHaveLength(2);
    fixture.developmentProfile.readyWorkers = 0;
    fixture.nowMs = 1_200;
    await schedule(pool());
    expect(reserves()).toHaveLength(3);
    expect(reserves().every((record) => record.destroyRequestedAtMs !== null)).toBe(true);
    expect(fixture.store.get(source.environmentId)).toEqual(source);
  });

  it("revalidates an earlier source when another awaited preparation changes admission authority", async () => {
    await activeSource("source-a");
    await activeSource("source-b", { projectKey: "1".repeat(64) });
    let generation = 0;
    let admittedAtHasFirst = false;
    const admittedAt = new WeakMap<WorkerProviderPreparedIntent, number>();
    const reconcile = vi.fn<PoolOptions["reconcile"]>(async () => {});
    const owner = pool({
      prepareIntent: async (_profileId, { projectPath }) => {
        if (admittedAtHasFirst) {
          generation += 1;
        }
        admittedAtHasFirst = true;
        const intent = {
          providerId: fixture.provider.id,
          profileSnapshot: fixture.profile(path.basename(projectPath!)),
          preparationKey: PREPARATION_KEY,
        };
        admittedAt.set(intent, generation);
        return intent;
      },
      assertIntentCurrent: (_profileId, intent) => {
        if (admittedAt.get(intent) !== generation) {
          throw new Error("preparation authority changed");
        }
      },
      reconcile,
    });
    await expect(schedule(owner)).rejects.toThrow("preparation authority changed");
    expect(reserves()).toEqual([]);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("runs only two preparations concurrently and drains admitted work after shutdown", async () => {
    fixture.developmentProfile.readyWorkers = 3;
    await activeSource("source");
    const entered = createDeferred();
    const release = createDeferred();
    fixture.releases.push(() => release.resolve());
    const reconcile = vi.fn(async (_record: WorkerEnvironmentRecord, signal: AbortSignal) => {
      if (reconcile.mock.calls.length === 2) {
        entered.resolve();
      }
      await release.promise;
      expect(signal.aborted).toBe(true);
    });
    const owner = pool({ reconcile });
    let settled = false;
    const running = schedule(owner).then(() => {
      settled = true;
    });
    await entered.promise;
    expect(reserves()).toHaveLength(3);
    expect(reconcile).toHaveBeenCalledTimes(2);
    fixture.abort.abort();
    await owner.schedule();
    expect(settled).toBe(false);
    release.resolve();
    await running;
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(reserves().every((record) => record.state === "requested")).toBe(true);
  });

  it("keeps reserve and provider maintenance ticking during slow inspection and joins them at stop", async () => {
    await seedReady("slow-inspection");
    fixture.provider.supportedExecutionModes = ["worker-turn"];
    const time = createGatewaySchedulerClock(fixture.nowMs);
    const scheduler = createTestGatewayScheduler(time.clock);
    const inspected = createDeferred();
    const finishInspection = createDeferred();
    const finishMaintenance = createDeferred();
    const finishDestroy = createDeferred();
    const destroyEntered = createDeferred();
    const release = () => {
      finishInspection.resolve();
      finishMaintenance.resolve();
      finishDestroy.resolve();
    };
    fixture.releases.push(release);
    const inspect = vi.fn(async () => {
      inspected.resolve();
      await finishInspection.promise;
      return { status: "active" as const };
    });
    fixture.provider.inspect = inspect;
    fixture.provider.destroy = vi.fn(async ({ leaseId }) => {
      if (leaseId === "lease:reserve-2") {
        destroyEntered.resolve();
        await finishDestroy.promise;
      }
    });
    let holdMaintenance = false;
    const maintainProviders = vi.fn(async (_signal: AbortSignal) => {
      if (holdMaintenance) {
        await finishMaintenance.promise;
      }
    });
    const completed = new Map<string, () => void>();
    const transition = fixture.store.transition.bind(fixture.store);
    vi.spyOn(fixture.store, "transition").mockImplementation(async (input) => {
      const record = await transition(input);
      if (input.to === "destroyed") {
        completed.get(input.environmentId)?.();
      }
      return record;
    });
    const closeArtifacts = vi.fn(async () => {});
    const owner = service({
      scheduler,
      maintainProviders,
      closeNodeBootstrapArtifacts: closeArtifacts,
      reconcileIntervalMs: 25,
    });
    const reconciliation = owner.reconcileOnce();
    const wakes: Array<ReturnType<typeof time.advanceBy>> = [];
    let stopping: Promise<void> | undefined;
    try {
      await inspected.promise;
      owner.start();
      for (let sweep = 0; sweep < 3; sweep++) {
        const id = `reserve-${sweep}`;
        const destroyed = createDeferred();
        completed.set(id, () => destroyed.resolve());
        await seedReady(id, { reserve: true });
        if (sweep === 0) {
          maintainProviders.mockClear();
        }
        holdMaintenance = sweep === 2;
        fixture.nowMs += IDLE_TIMEOUT_MS;
        wakes.push(time.advanceBy(IDLE_TIMEOUT_MS));
        await Promise.resolve();
        expect(maintainProviders).toHaveBeenCalledTimes(sweep + 1);
        expect(inspect).toHaveBeenCalledOnce();
        if (sweep < 2) {
          await destroyed.promise;
          expect(fixture.store.get(id)?.state).toBe("destroyed");
        }
      }
      await destroyEntered.promise;
      expect(fixture.provider.destroy).toHaveBeenCalledTimes(3);
      stopping = owner.stop();
      expect(maintainProviders.mock.lastCall?.[0].aborted).toBe(true);
      finishInspection.resolve();
      await reconciliation;
      expect(closeArtifacts).not.toHaveBeenCalled();
      finishMaintenance.resolve();
      await maintainProviders.mock.results.at(-1)?.value;
      expect(closeArtifacts).not.toHaveBeenCalled();
      finishDestroy.resolve();
      await stopping;
      expect(closeArtifacts).toHaveBeenCalledOnce();
      expect(fixture.store.get("reserve-2")?.state).toBe("destroyed");
      await time.advanceBy(IDLE_TIMEOUT_MS);
      expect(inspect).toHaveBeenCalledOnce();
      expect(maintainProviders).toHaveBeenCalledTimes(3);
    } finally {
      release();
      await Promise.allSettled([reconciliation, stopping, ...wakes]);
      await owner.stop();
      await scheduler.stop();
    }
  });

  it("keeps actual service reserve cleanup outside the installed placement fence while stop drains it", async () => {
    const reserve = await seedReady("expired", { reserve: true });
    fixture.nowMs = 2_000;
    const entered = createDeferred();
    const release = createDeferred();
    fixture.releases.push(() => release.resolve());
    fixture.provider.destroy = vi.fn(async () => {
      entered.resolve();
      await release.promise;
    });
    const owner = service();
    const guard = vi.fn<
      Parameters<WorkerEnvironmentService["installReconcileEnvironmentGuard"]>[0]
    >(async (_environmentId, reconcile) => {
      await reconcile();
    });
    owner.installReconcileEnvironmentGuard(guard);
    await owner.reconcileOnce();
    await entered.promise;
    expect(guard).not.toHaveBeenCalled();
    expect(fixture.provider.provision).not.toHaveBeenCalled();
    expect(fixture.provider.inspect).not.toHaveBeenCalled();
    let stopped = false;
    const stopping = owner.stop().then(() => {
      stopped = true;
    });
    await owner.reconcileOnce();
    expect(stopped).toBe(false);
    release.resolve();
    await stopping;
    expect(stopped).toBe(true);
    expect(fixture.store.get(reserve.environmentId)?.state).toBe("destroyed");
    expect(fixture.provider.destroy).toHaveBeenCalledOnce();
  });
});
