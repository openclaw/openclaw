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
  PROJECT_KEY,
  RECEIPT,
  usePreparedPoolFixture,
  type PoolOptions,
} from "./prepared-pool.test-support.js";
import { createWorkerEnvironmentService, type WorkerEnvironmentService } from "./service.js";
import type { WorkerEnvironmentRecord } from "./store.js";

describe("prepared worker reserve lifecycle", () => {
  const fixture = usePreparedPoolFixture();
  it("cleans expired reserves and refills healthy projects after another provider's resolution fails", async () => {
    const expired = await fixture.ready(await fixture.seed("expired", { reserve: true }));
    fixture.nowMs = 1_500;
    await fixture.attach(
      await fixture.ready(await fixture.seed("healthy", { projectKey: "c".repeat(64) })),
    );
    fixture.config.cloudWorkers!.profiles!.broken = { provider: "broken" };
    await fixture.attach(
      await fixture.ready(
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
    const owner = fixture.pool({
      reconcile,
      resolveProvider: (id) => {
        if (id !== "broken") {
          return fixture.provider;
        }
        throw new Error("provider resolution failed");
      },
    });
    await fixture.schedule(owner);
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
    const attached = await fixture.attach(
      await fixture.ready(await fixture.seed("syncing-cold")),
      "syncing",
    );
    await fixture.reopenStore();
    const owner = fixture.pool();
    await owner.noteDemand(attached.environmentId);
    await fixture.schedule(owner);
    expect(fixture.provider.notePreparedDemand).not.toHaveBeenCalled();
    expect(fixture.reserves()).toEqual([]);
  });

  it("starts a full idle window after a long first sync without extending it on detach", async () => {
    const idleWindow = 15 * 60_000;
    fixture.provider.resolvePreparedIdleTimeoutMs = () => idleWindow;
    const allocated = await fixture.ready(await fixture.seed("slow-first-checkout"));
    const activatedAtMs = fixture.nowMs + 16 * 60_000;
    const attached = await fixture.attach(allocated, "active", activatedAtMs);
    const owner = fixture.pool();
    await owner.noteDemand(attached.environmentId);
    await fixture.schedule(owner);
    const reserve = fixture.reserves()[0]!;
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
    await fixture.schedule(owner);
    expect(fixture.provider.notePreparedDemand).toHaveBeenCalledOnce();
    expect(fixture.store.get(reserve.environmentId)?.preparation).toEqual(reserve.preparation);
    fixture.nowMs = activatedAtMs + idleWindow;
    await fixture.schedule(owner);
    expect(fixture.reserves()).toHaveLength(1);
    expect(fixture.store.get(reserve.environmentId)?.destroyRequestedAtMs).toBe(fixture.nowMs);
  });

  it.each([false, true])(
    "retains slow activation demand when teardown precedes refill (reserve=%s)",
    async (reserve) => {
      const idleWindow = 15 * 60_000;
      fixture.provider.resolvePreparedIdleTimeoutMs = () => idleWindow;
      const allocated = await fixture.ready(await fixture.seed("slow-activation", { reserve }));
      const activatedAtMs = fixture.nowMs + 16 * 60_000;
      const attached = await fixture.attach(allocated, "active", activatedAtMs);
      fixture.nowMs += 60_000;
      await fixture.teardown(attached);
      await fixture.reopenStore();

      await fixture.schedule(fixture.pool());
      const replacement = fixture
        .reserves()
        .filter((record) => record.preparation?.consumedAtMs === null);
      expect(replacement).toHaveLength(1);
      expect(replacement[0]?.preparation).toMatchObject({
        demandAtMs: activatedAtMs,
        expiresAtMs: activatedAtMs + idleWindow,
      });
    },
  );

  it("does not allocate when source preparation finishes after its demand deadline", async () => {
    await fixture.attach(await fixture.ready(await fixture.seed("source")));
    const reconcile = vi.fn<PoolOptions["reconcile"]>(async () => {});
    await fixture.schedule(
      fixture.pool({
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
    expect(fixture.reserves()).toEqual([]);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("counts pending and uncertain cleanup against the shared cap after restart", async () => {
    fixture.developmentProfile.readyWorkers = 2;
    fixture.config.cloudWorkers!.preparedPool = { maxTotal: 3 };
    await fixture.attach(await fixture.ready(await fixture.seed("source-a")));
    await fixture.attach(
      await fixture.ready(await fixture.seed("source-b", { projectKey: "1".repeat(64) })),
    );
    await fixture.schedule(fixture.pool());
    const reserved = fixture.reserves();
    expect(reserved).toHaveLength(3);
    const uncertain = reserved[0]!;
    await fixture.store.transition({
      environmentId: uncertain.environmentId,
      from: "requested",
      to: "provisioning",
    });
    await fixture.store.adoptProvisionCleanupFailure({
      environmentId: uncertain.environmentId,
      leaseId: "uncertain-lease",
      lastError: "provider cleanup response lost",
    });
    await fixture.reopenStore();
    const warn = vi.fn();
    const reconcile = vi.fn<PoolOptions["reconcile"]>(async (record) => {
      if (record.environmentId === uncertain.environmentId) {
        throw new Error("provider cleanup remains unavailable");
      }
    });
    await fixture.schedule(fixture.pool({ reconcile, warn }));
    expect(
      fixture
        .reserves()
        .map((record) => record.environmentId)
        .toSorted(),
    ).toEqual(reserved.map((record) => record.environmentId).toSorted());
    expect(reconcile.mock.calls.map(([record]) => record.environmentId).toSorted()).toEqual(
      reserved.map((record) => record.environmentId).toSorted(),
    );
    expect(fixture.store.get(uncertain.environmentId)).toMatchObject({
      state: "destroying",
      leaseId: "uncertain-lease",
      provisionOperationId: uncertain.provisionOperationId,
    });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("failure and cleanup state"));
  });

  it.each(["profile", "gateway"] as const)(
    "retires excess then disabled %s capacity without touching an attached session",
    async (scope) => {
      fixture.developmentProfile.provider =
        scope === "profile" ? fixture.provider.id : " Test-Provider ";
      fixture.developmentProfile.readyWorkers = 3;
      const source = await fixture.attach(await fixture.ready(await fixture.seed("source")));
      await fixture.schedule(fixture.pool());
      expect(fixture.reserves()).toHaveLength(3);
      for (const reserve of fixture.reserves()) {
        await fixture.ready(reserve);
      }
      if (scope === "profile") {
        fixture.developmentProfile.readyWorkers = 1;
      } else {
        fixture.config.cloudWorkers!.preparedPool = { maxTotal: 1 };
      }
      fixture.nowMs = 1_100;
      await fixture.schedule(fixture.pool());
      expect(
        fixture.reserves().filter((record) => record.destroyRequestedAtMs === null),
      ).toHaveLength(1);
      expect(
        fixture.reserves().filter((record) => record.destroyRequestedAtMs === 1_100),
      ).toHaveLength(2);
      if (scope === "profile") {
        fixture.developmentProfile.readyWorkers = 0;
      } else {
        fixture.config.cloudWorkers!.preparedPool = { maxTotal: 0 };
      }
      fixture.nowMs = 1_200;
      await fixture.schedule(fixture.pool());
      expect(fixture.reserves()).toHaveLength(3);
      expect(fixture.reserves().every((record) => record.destroyRequestedAtMs !== null)).toBe(true);
      expect(fixture.store.get(source.environmentId)).toEqual(source);
    },
  );

  it("retires the previous fingerprint before admitting a new generation in the same project slot", async () => {
    await fixture.attach(await fixture.ready(await fixture.seed("source-old")));
    await fixture.schedule(fixture.pool());
    const old = fixture.reserves()[0]!;
    const nextKey = "2".repeat(64);
    fixture.nowMs = 1_100;
    await fixture.attach(
      await fixture.ready(await fixture.seed("source-new", { preparationKey: nextKey })),
    );
    const owner = fixture.pool({
      prepareIntent: async () => ({
        providerId: fixture.provider.id,
        profileSnapshot: fixture.profile(PROJECT_KEY, nextKey),
        preparationKey: nextKey,
      }),
    });
    await fixture.schedule(owner);
    expect(fixture.reserves()).toHaveLength(1);
    expect(fixture.store.get(old.environmentId)?.destroyRequestedAtMs).toBe(1_100);
    // This intent never allocated; the ordinary lifecycle can terminalize it safely.
    await fixture.store.transition({
      environmentId: old.environmentId,
      from: "requested",
      to: "failed",
    });
    await fixture.schedule(owner);
    expect(fixture.reserves().filter((record) => record.state === "requested")).toEqual([
      expect.objectContaining({
        preparation: {
          purpose: "reserve",
          key: nextKey,
          demandAtMs: 1_100,
          expiresAtMs: 2_100,
          consumedAtMs: null,
        },
      }),
    ]);
  });

  it("revalidates an earlier source when another awaited preparation changes admission authority", async () => {
    await fixture.attach(await fixture.ready(await fixture.seed("source-a")));
    await fixture.attach(
      await fixture.ready(await fixture.seed("source-b", { projectKey: "1".repeat(64) })),
    );
    let generation = 0;
    let admittedAtHasFirst = false;
    const admittedAt = new WeakMap<WorkerProviderPreparedIntent, number>();
    const reconcile = vi.fn<PoolOptions["reconcile"]>(async () => {});
    const owner = fixture.pool({
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
    await expect(fixture.schedule(owner)).rejects.toThrow("preparation authority changed");
    expect(fixture.reserves()).toEqual([]);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("runs only two preparations concurrently and drains admitted work after shutdown", async () => {
    fixture.developmentProfile.readyWorkers = 3;
    await fixture.attach(await fixture.ready(await fixture.seed("source")));
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
    const owner = fixture.pool({ reconcile });
    let settled = false;
    const running = fixture.schedule(owner).then(() => {
      settled = true;
    });
    await entered.promise;
    expect(fixture.reserves()).toHaveLength(3);
    expect(reconcile).toHaveBeenCalledTimes(2);
    fixture.abort.abort();
    await owner.schedule();
    expect(settled).toBe(false);
    release.resolve();
    await running;
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(fixture.reserves().every((record) => record.state === "requested")).toBe(true);
  });

  it("keeps reserve and provider maintenance ticking during slow inspection and joins them at stop", async () => {
    await fixture.ready(await fixture.seed("slow-inspection"));
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
    const service = createWorkerEnvironmentService({
      scheduler,
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
      executeInference: async () => ({ type: "error", reason: "cancelled", message: "unused" }),
      maintainProviders,
      closeNodeBootstrapArtifacts: closeArtifacts,
      reconcileIntervalMs: 25,
      now: () => fixture.nowMs,
    });
    fixture.service = service;
    const reconciliation = service.reconcileOnce();
    const wakes: Array<ReturnType<typeof time.advanceBy>> = [];
    let stopping: Promise<void> | undefined;
    try {
      await inspected.promise;
      service.start();
      for (let sweep = 0; sweep < 3; sweep++) {
        const id = `reserve-${sweep}`;
        const destroyed = createDeferred();
        completed.set(id, () => destroyed.resolve());
        await fixture.ready(await fixture.seed(id, { reserve: true }));
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
      stopping = service.stop();
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
      await service.stop();
      await scheduler.stop();
    }
  });

  it("keeps actual service reserve cleanup outside the installed placement fence while stop drains it", async () => {
    const reserve = await fixture.ready(await fixture.seed("expired", { reserve: true }));
    fixture.nowMs = 2_000;
    const entered = createDeferred();
    const release = createDeferred();
    fixture.releases.push(() => release.resolve());
    fixture.provider.destroy = vi.fn(async () => {
      entered.resolve();
      await release.promise;
    });
    fixture.service = createWorkerEnvironmentService({
      scheduler: createTestGatewayScheduler(),
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
      executeInference: async () => ({ type: "error", reason: "cancelled", message: "unused" }),
      now: () => fixture.nowMs,
    });
    const guard = vi.fn<
      Parameters<WorkerEnvironmentService["installReconcileEnvironmentGuard"]>[0]
    >(async (_environmentId, reconcile) => {
      await reconcile();
    });
    fixture.service.installReconcileEnvironmentGuard(guard);
    await fixture.service.reconcileOnce();
    await entered.promise;
    expect(guard).not.toHaveBeenCalled();
    expect(fixture.provider.provision).not.toHaveBeenCalled();
    expect(fixture.provider.inspect).not.toHaveBeenCalled();
    let stopped = false;
    const stopping = fixture.service.stop().then(() => {
      stopped = true;
    });
    await fixture.service.reconcileOnce();
    expect(stopped).toBe(false);
    release.resolve();
    await stopping;
    expect(stopped).toBe(true);
    expect(fixture.store.get(reserve.environmentId)?.state).toBe("destroyed");
    expect(fixture.provider.destroy).toHaveBeenCalledOnce();
  });
});
