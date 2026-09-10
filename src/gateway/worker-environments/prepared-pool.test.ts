import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createWorkerCredentialBroker } from "./credential-broker.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import type { WorkerProviderPreparedIntent } from "./preparation-identity.js";
import {
  IDLE_TIMEOUT_MS,
  PREPARATION_KEY,
  PROJECT_KEY,
  RECEIPT,
  usePreparedPoolFixture,
  type PoolOptions,
} from "./prepared-pool.test-support.js";
import { createWorkerProviderLifecycle } from "./provider-lifecycle.js";
import type { WorkerProviderLifecycleOptions } from "./provider-lifecycle.types.js";
import { createWorkerEnvironmentService, type WorkerEnvironmentService } from "./service.js";
import type { WorkerEnvironmentState } from "./state.js";
import type { WorkerEnvironmentRecord } from "./store.js";

class TestWorkerServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

describe("prepared worker reserve lifecycle", () => {
  const fixture = usePreparedPoolFixture();
  it.each(["resolution", "idle policy"])(
    "cleans expired reserves and refills healthy projects after another provider's %s fails",
    async (failure) => {
      const expired = fixture.ready(fixture.seed("expired", { reserve: true }));
      fixture.nowMs = 1_500;
      fixture.attach(fixture.ready(fixture.seed("healthy", { projectKey: "c".repeat(64) })));
      fixture.config.cloudWorkers!.profiles!.broken = { provider: "broken" };
      fixture.attach(
        fixture.ready(
          fixture.store.createIntent({
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
          if (failure === "resolution") {
            throw new Error("provider resolution failed");
          }
          return {
            ...fixture.provider,
            resolvePreparedIdleTimeoutMs: () => {
              throw new Error("provider idle policy failed");
            },
          };
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
    },
  );

  it.each(["available", "missing", "throwing"] as const)(
    "retains terminal demand beyond seven days with %s provider policy",
    async (policyState) => {
      const dayMs = 24 * 60 * 60 * 1_000;
      const source = fixture.attach(fixture.ready(fixture.seed("source")));
      fixture.teardown(source);
      const placements = createWorkerSessionPlacementStore({ database: fixture.database });
      const placement = placements.get(`session:${source.environmentId}`)!;
      placements.retireSessionPlacement({
        sessionId: placement.sessionId,
        expectedState: "failed",
        expectedGeneration: placement.generation,
      });
      fixture.reopenStore();
      fixture.nowMs += 8 * dayMs;
      fixture.provider.resolvePreparedIdleTimeoutMs = () => 10 * dayMs;
      const resolveProvider = () => {
        if (policyState === "throwing") {
          throw new Error("provider unavailable");
        }
        return policyState === "missing" ? undefined : fixture.provider;
      };
      const owner = fixture.pool({ resolveProvider });
      expect(
        fixture.store.pruneTerminalEnvironments({ canPruneDemand: owner.canPruneDemand }),
      ).toBe(0);
      expect(fixture.store.get(source.environmentId)?.lastActivatedAtMs).toBe(1_000);
      if (policyState === "available") {
        await fixture.schedule(owner);
        expect(fixture.reserves()).toHaveLength(1);
        expect(fixture.reserves()[0]?.preparation?.expiresAtMs).toBe(1_000 + 10 * dayMs);
      }
      fixture.nowMs += 2 * dayMs;
      // Policy recovery permits metadata cleanup only after the original deadline.
      expect(
        fixture.store.pruneTerminalEnvironments({ canPruneDemand: fixture.pool().canPruneDemand }),
      ).toBe(1);
      expect(fixture.store.get(source.environmentId)).toBeUndefined();
    },
  );

  it("keeps expiry tied to originating demand across repeated maintenance and database reopen", async () => {
    fixture.attach(fixture.ready(fixture.seed("source")));
    const reconcile = vi.fn<PoolOptions["reconcile"]>(async () => {});
    const owner = fixture.pool({ reconcile });
    await fixture.schedule(owner);
    const reserve = fixture.reserves()[0]!;
    expect(reserve.preparation).toMatchObject({ demandAtMs: 1_000, expiresAtMs: 2_000 });
    fixture.nowMs = 1_900;
    await fixture.schedule(owner);
    expect(fixture.reserves()).toEqual([reserve]);
    expect(fixture.provider.notePreparedDemand).not.toHaveBeenCalled();

    fixture.reopenStore();
    fixture.nowMs = 2_000;
    await fixture.schedule(fixture.pool({ reconcile }));
    expect(fixture.reserves()).toHaveLength(1);
    expect(fixture.store.get(reserve.environmentId)).toMatchObject({
      destroyRequestedAtMs: 2_000,
      preparation: reserve.preparation,
    });
    expect(reconcile.mock.lastCall?.[0]).toMatchObject({ destroyRequestedAtMs: 2_000 });
    fixture.nowMs = 2_100;
    await fixture.schedule(fixture.pool());
    expect(fixture.reserves()).toHaveLength(1);
  });

  it("retains activated demand after consumed worker teardown and database reopen", async () => {
    const source = fixture.attach(fixture.ready(fixture.seed("source")));
    const owner = fixture.pool();
    await fixture.schedule(owner);
    const reserve = fixture.ready(fixture.reserves()[0]!);
    await owner.noteDemand(reserve.environmentId);
    expect(fixture.provider.notePreparedDemand).not.toHaveBeenCalled();
    fixture.nowMs = 1_500;
    await owner.noteDemand(source.environmentId);
    expect(fixture.provider.notePreparedDemand).toHaveBeenLastCalledWith(
      { leaseId: source.leaseId, profile: {} },
      { preparationKey: PREPARATION_KEY, demandAtMs: 1_000 },
    );
    const consumed = fixture.attach(reserve);
    await owner.noteDemand(consumed.environmentId);
    expect(fixture.provider.notePreparedDemand).toHaveBeenLastCalledWith(
      { leaseId: consumed.leaseId, profile: {} },
      { preparationKey: PREPARATION_KEY, demandAtMs: 1_500 },
    );
    fixture.teardown(source);
    fixture.teardown(consumed);
    fixture.reopenStore();
    await fixture.schedule(fixture.pool());
    expect(
      fixture.reserves().find((record) => record.preparation?.consumedAtMs === null)?.preparation,
    ).toMatchObject({ demandAtMs: 1_500, expiresAtMs: 2_500 });
    expect(fixture.store.get(consumed.environmentId)?.preparation).toMatchObject({
      consumedAtMs: 1_500,
      expiresAtMs: 2_000,
    });
  });

  it.each([
    ["provisioning", true, 1_950],
    ["provisioning", true, 2_050],
    ["syncing", false, 1_950],
    ["syncing", true, 2_050],
  ] as const)(
    "does not renew consumed %s demand (failed=%s) during maintenance at %s",
    async (stage, fail, maintenanceAtMs) => {
      const source = fixture.attach(fixture.ready(fixture.seed("source")));
      await fixture.schedule(fixture.pool());
      fixture.teardown(source);
      const reserve = fixture.ready(fixture.reserves()[0]!);
      fixture.nowMs = 1_900;
      const consumed = fixture.attach(reserve, stage);
      if (fail) {
        fixture.teardown(consumed);
      }
      fixture.reopenStore();
      fixture.nowMs = maintenanceAtMs;
      const owner = fixture.pool();
      await owner.noteDemand(consumed.environmentId);
      await fixture.schedule(owner);
      expect(fixture.provider.notePreparedDemand).not.toHaveBeenCalled();
      const replacement = fixture
        .reserves()
        .filter((record) => record.preparation?.consumedAtMs === null);
      if (maintenanceAtMs < 2_000) {
        expect(replacement).toHaveLength(1);
        expect(replacement[0]?.preparation).toMatchObject({
          demandAtMs: 1_000,
          expiresAtMs: 2_000,
        });
        fixture.nowMs = 2_050;
        await fixture.schedule(owner);
        expect(fixture.reserves()).toHaveLength(2);
        expect(fixture.store.get(replacement[0]!.environmentId)?.destroyRequestedAtMs).toBe(2_050);
      } else {
        expect(replacement).toEqual([]);
      }
    },
  );

  it("does not seed demand from a cold attachment still syncing after database reopen", async () => {
    const attached = fixture.attach(fixture.ready(fixture.seed("syncing-cold")), "syncing");
    fixture.reopenStore();
    const owner = fixture.pool();
    await owner.noteDemand(attached.environmentId);
    await fixture.schedule(owner);
    expect(fixture.provider.notePreparedDemand).not.toHaveBeenCalled();
    expect(fixture.reserves()).toEqual([]);
  });

  it.each(["checkout", "sync"])(
    "starts a full idle window after a long first %s without extending it on detach",
    async (phase) => {
      const idleWindow = 15 * 60_000;
      fixture.provider.resolvePreparedIdleTimeoutMs = () => idleWindow;
      const allocated = fixture.ready(fixture.seed("slow-first-checkout"));
      const activatedAtMs = fixture.nowMs + 16 * 60_000;
      if (phase === "checkout") {
        fixture.nowMs = activatedAtMs;
      }
      const attached = fixture.attach(allocated, "active", activatedAtMs);
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
      fixture.store.transition({
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
    },
  );

  it.each([false, true])(
    "retains slow activation demand when teardown precedes refill (reserve=%s)",
    async (reserve) => {
      const idleWindow = 15 * 60_000;
      fixture.provider.resolvePreparedIdleTimeoutMs = () => idleWindow;
      const allocated = fixture.ready(fixture.seed("slow-activation", { reserve }));
      const activatedAtMs = fixture.nowMs + 16 * 60_000;
      const attached = fixture.attach(allocated, "active", activatedAtMs);
      fixture.nowMs += 60_000;
      fixture.teardown(attached);
      fixture.reopenStore();

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
    fixture.attach(fixture.ready(fixture.seed("source")));
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
    fixture.attach(fixture.ready(fixture.seed("source-a")));
    fixture.attach(fixture.ready(fixture.seed("source-b", { projectKey: "1".repeat(64) })));
    await fixture.schedule(fixture.pool());
    const reserved = fixture.reserves();
    expect(reserved).toHaveLength(3);
    const uncertain = reserved[0]!;
    fixture.store.transition({
      environmentId: uncertain.environmentId,
      from: "requested",
      to: "provisioning",
    });
    fixture.store.adoptProvisionCleanupFailure({
      environmentId: uncertain.environmentId,
      leaseId: "uncertain-lease",
      lastError: "provider cleanup response lost",
    });
    fixture.reopenStore();
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
      const source = fixture.attach(fixture.ready(fixture.seed("source")));
      await fixture.schedule(fixture.pool());
      expect(fixture.reserves()).toHaveLength(3);
      for (const reserve of fixture.reserves()) {
        fixture.ready(reserve);
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
    fixture.attach(fixture.ready(fixture.seed("source-old")));
    await fixture.schedule(fixture.pool());
    const old = fixture.reserves()[0]!;
    const nextKey = "2".repeat(64);
    fixture.nowMs = 1_100;
    fixture.attach(fixture.ready(fixture.seed("source-new", { preparationKey: nextKey })));
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
    fixture.store.transition({ environmentId: old.environmentId, from: "requested", to: "failed" });
    await fixture.schedule(owner);
    expect(fixture.reserves().filter((record) => record.state === "requested")).toEqual([
      expect.objectContaining({
        preparation: {
          key: nextKey,
          demandAtMs: 1_100,
          expiresAtMs: 2_100,
          consumedAtMs: null,
        },
      }),
    ]);
  });

  it("revalidates an earlier source when another awaited preparation changes admission authority", async () => {
    fixture.attach(fixture.ready(fixture.seed("source-a")));
    fixture.attach(fixture.ready(fixture.seed("source-b", { projectKey: "1".repeat(64) })));
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
    fixture.attach(fixture.ready(fixture.seed("source")));
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

  it("retires queued capacity when disabled before its reconciliation lock is acquired", async () => {
    const reserve = fixture.seed("queued-reserve", { reserve: true });
    const entered = createDeferred();
    const release = createDeferred();
    fixture.releases.push(() => release.resolve());
    const provision = vi.fn();
    const cleanup = vi.fn();
    const owner = fixture.pool({
      reconcile: async (record, _signal, beforeReconcile) => {
        entered.resolve();
        await release.promise;
        // The runtime repeats this callback after acquiring its environment lock.
        beforeReconcile();
        const current = fixture.store.get(record.environmentId)!;
        if (current.destroyRequestedAtMs === null) {
          provision(current);
        } else {
          cleanup(current);
        }
      },
    });
    const running = fixture.schedule(owner);
    await entered.promise;
    expect(fixture.store.get(reserve.environmentId)?.destroyRequestedAtMs).toBeNull();
    fixture.developmentProfile.readyWorkers = 0;
    release.resolve();
    await running;
    expect(provision).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: reserve.environmentId,
        destroyRequestedAtMs: fixture.nowMs,
      }),
    );
    expect(fixture.reserves()).toHaveLength(1);
  });

  it.each([
    ["unchanged policy", false, undefined],
    ["changed policy", true, undefined],
    ["expired demand", true, undefined],
    ["project active", false, "project"],
    ["project cleanup", true, "project"],
    ["global active", false, "global"],
    ["global cleanup", true, "global"],
    ["previous provider active", false, "provider"],
    ["previous provider cleanup", true, "provider"],
    ["later global active", false, "later-global"],
    ["later global cleanup", true, "later-global"],
  ] as const)(
    "rechecks reserve intent and capacity after the provider queue (%s)",
    async (_scenario, changed, cleanupScope) => {
      let previous: WorkerEnvironmentRecord | undefined;
      if (cleanupScope === "later-global") {
        fixture.config.cloudWorkers!.preparedPool = { maxTotal: 1 };
        fixture.attach(fixture.ready(fixture.seed("current-source")));
      } else if (cleanupScope) {
        const consumed =
          cleanupScope === "global"
            ? fixture.store.createIntent({
                environmentId: "previous-global-worker",
                providerId: fixture.provider.id,
                profileId: "removed-profile",
                provisionOperationId: "previous-global-operation",
                profileSnapshot: fixture.profile("1".repeat(64)),
                preparation: {
                  key: PREPARATION_KEY,
                  demandAtMs: fixture.nowMs,
                  expiresAtMs: fixture.nowMs + IDLE_TIMEOUT_MS,
                },
              })
            : fixture.seed("previous-worker", { reserve: true });
        previous = fixture.attach(fixture.ready(consumed));
        fixture.nowMs += 100;
        if (cleanupScope === "global") {
          fixture.config.cloudWorkers!.preparedPool = { maxTotal: 1 };
        } else if (cleanupScope === "provider") {
          fixture.provider = { ...fixture.provider, id: "replacement-provider" };
          fixture.developmentProfile.provider = fixture.provider.id;
        }
        if (cleanupScope !== "project") {
          fixture.attach(fixture.ready(fixture.seed("current-source")));
        }
      } else {
        const reserve = fixture.seed("queued-provider-reserve", { reserve: true });
        fixture.store.transition({
          environmentId: reserve.environmentId,
          from: "requested",
          to: "provisioning",
        });
      }
      const entered = createDeferred();
      const release = createDeferred();
      fixture.releases.push(() => release.resolve());
      let intentChanged = false;
      const callProvider = async <T>(_environmentId: string, run: () => Promise<T>): Promise<T> => {
        entered.resolve();
        await release.promise;
        return await run();
      };
      const unexpectedLifecycleOperation = (): never => {
        throw new Error("unexpected worker bootstrap or teardown past the allocation boundary");
      };
      const lifecycleOptions = {
        store: fixture.store,
        callProvider,
        move: (record, to, patch) =>
          fixture.store.transition({
            environmentId: record.environmentId,
            from: record.state,
            expectedOwnerEpoch: record.ownerEpoch,
            to,
            patch,
          }),
        saveError: (record, error) =>
          fixture.store.recordError({
            environmentId: record.environmentId,
            state: record.state,
            error: String(error),
          }),
        withLock: async (_environmentId, task) => await task(),
        serviceError: (code, message) => new TestWorkerServiceError(code, message),
        isStopping: () => false,
        inState: (record: WorkerEnvironmentRecord, ...states: WorkerEnvironmentState[]) =>
          states.includes(record.state),
      } satisfies Pick<
        WorkerProviderLifecycleOptions,
        | "store"
        | "callProvider"
        | "move"
        | "saveError"
        | "withLock"
        | "serviceError"
        | "isStopping"
        | "inState"
      >;
      const prepareInstallation = async () => ({
        install: "bundle" as const,
        ...RECEIPT,
        tarballBytes: 1,
        tarballSha256: "f".repeat(64),
        tarballPath: path.join(fixture.root, "unused.tgz"),
      });
      const lifecycle = createWorkerProviderLifecycle({
        ...lifecycleOptions,
        getConfig: () => fixture.config,
        resolveProvider: (providerId) =>
          providerId === fixture.provider.id ? fixture.provider : undefined,
        now: () => fixture.nowMs,
        projectNamespace: "gateway",
        prepareInstallation,
        credentialBroker: createWorkerCredentialBroker({
          ...lifecycleOptions,
          prepareInstallation,
          now: () => fixture.nowMs,
          cancelInferenceEnvironment: () => {},
        }),
        callBootstrap: unexpectedLifecycleOperation,
        bootstrapWorker: unexpectedLifecycleOperation,
        isServiceError: (error, code) =>
          error instanceof TestWorkerServiceError && error.code === code,
      });
      fixture.provider.supportedExecutionModes = ["worker-turn"];
      fixture.provider.supportsProjectPreparation = () => true;
      fixture.provider.resolvePreparationTarget = () => ({
        machineClass: "standard",
        platform: "linux",
        arch: "x64",
      });
      fixture.provider.provision = vi.fn(async () => {
        throw new Error("allocation boundary reached");
      });
      const assertCurrent = () => {
        if (intentChanged) {
          throw new TestWorkerServiceError(
            "invalid_profile",
            "Worker profile changed during preparation",
          );
        }
      };
      const owner = fixture.pool({
        prepareRetention: async () => ({ assertCurrent }),
        assertIntentCurrent: assertCurrent,
        reconcile: async (record, signal, beforeReconcile) => {
          await lifecycle.resumePrepared(record, signal, beforeReconcile);
        },
      });
      const running = fixture.schedule(owner);
      await Promise.race([entered.promise, running]);
      expect(fixture.provider.provision).not.toHaveBeenCalled();
      const pending = fixture
        .reserves()
        .filter((record) => record.preparation?.consumedAtMs === null);
      expect(pending).toHaveLength(1);
      const reserve = pending[0]!;
      expect(reserve).toMatchObject({
        state: cleanupScope ? "requested" : "provisioning",
        destroyRequestedAtMs: null,
      });
      if (cleanupScope === "later-global") {
        fixture.nowMs += 100;
        fixture.config.cloudWorkers!.preparedPool = { maxTotal: 2 };
        const admitted = fixture.store.ensurePreparedIntent({
          intent: {
            environmentId: "later-global-worker",
            providerId: fixture.provider.id,
            profileId: "other-profile",
            provisionOperationId: "later-global-operation",
            profileSnapshot: fixture.profile("1".repeat(64)),
            preparation: {
              key: PREPARATION_KEY,
              demandAtMs: fixture.nowMs,
              expiresAtMs: fixture.nowMs + IDLE_TIMEOUT_MS,
            },
          },
          projectKey: "1".repeat(64),
          target: 1,
          maxTotal: fixture.config.cloudWorkers!.preparedPool.maxTotal!,
          assertCurrent: () => {},
        });
        expect(admitted).toBeDefined();
        previous = fixture.attach(fixture.ready(admitted!));
        expect(previous.createdAtMs).toBeGreaterThan(reserve.createdAtMs);
        fixture.config.cloudWorkers!.preparedPool = { maxTotal: 1 };
      }
      if (cleanupScope && previous) {
        if (changed) {
          fixture.store.requestDestroy({
            environmentId: previous.environmentId,
            state: previous.state,
          });
        }
      } else if (_scenario === "expired demand") {
        fixture.nowMs += IDLE_TIMEOUT_MS;
      } else {
        intentChanged = changed;
      }
      release.resolve();
      await running;
      expect(fixture.provider.provision).toHaveBeenCalledTimes(changed ? 0 : 1);
      expect(fixture.provider.resolveAllocation).not.toHaveBeenCalled();
      expect(fixture.provider.destroy).not.toHaveBeenCalled();
      expect(fixture.store.get(reserve.environmentId)).toMatchObject({
        state: changed && cleanupScope ? "failed" : "provisioning",
        leaseId: null,
        nodeDeviceId: null,
        preparation: reserve.preparation,
        provisionOperationId: reserve.provisionOperationId,
        destroyRequestedAtMs: changed ? fixture.nowMs : null,
      });
      if (previous) {
        expect(fixture.store.get(previous.environmentId)).toMatchObject({
          state: "attached",
          leaseId: previous.leaseId,
          preparation: previous.preparation,
          destroyRequestedAtMs: changed ? fixture.nowMs : null,
        });
      }
    },
  );

  it("keeps actual service reserve cleanup outside the installed placement fence while stop drains it", async () => {
    const reserve = fixture.ready(fixture.seed("expired", { reserve: true }));
    fixture.nowMs = 2_000;
    const entered = createDeferred();
    const release = createDeferred();
    fixture.releases.push(() => release.resolve());
    fixture.provider.destroy = vi.fn(async () => {
      entered.resolve();
      await release.promise;
    });
    fixture.service = createWorkerEnvironmentService({
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
