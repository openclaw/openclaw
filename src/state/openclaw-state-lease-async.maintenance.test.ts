import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createOpenClawDatabaseMaintenanceScope,
  getOpenClawDatabaseMaintenanceScope,
  type OpenClawStateDatabaseAsyncResource,
} from "./openclaw-state-db-async-lifecycle.js";
import type { OpenClawStateAsyncLeaseContext } from "./openclaw-state-lease-context.js";
import type { LeaseHeartbeatCleanup } from "./openclaw-state-lease-heartbeat.js";
import type { OpenClawStateLeaseIdentity } from "./openclaw-state-lease-store.js";
import { withOpenClawStateLeaseWorkerAdmission } from "./openclaw-state-lease-worker-owner.js";
import { withOpenClawStateLeaseAsync } from "./openclaw-state-lease.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";

type CreateStorage =
  typeof import("./openclaw-state-lease-worker-storage.js").createOpenClawStateLeaseWorkerStorage;
type StartHeartbeat =
  typeof import("./openclaw-state-lease-heartbeat.js").startOpenClawStateLeaseHeartbeat;
type RegisterResource =
  typeof import("./openclaw-state-db-cache.js").registerOpenClawStateDatabaseAsyncResource;

const mocks = vi.hoisted(() => ({
  createStorage: vi.fn<CreateStorage>(),
  startHeartbeat: vi.fn<StartHeartbeat>(),
  registerResource: vi.fn<RegisterResource>(),
  unregisterExit: vi.fn<() => void>(),
  isWriteContention: vi.fn<(_error: unknown) => boolean>(() => false),
  forbidden: vi.fn(() => {
    throw new Error("Controlled lease test reached native storage, identity lookup, or transport");
  }),
}));

vi.mock("./openclaw-state-lease-worker-storage.js", () => ({
  createOpenClawStateLeaseWorkerStorage: mocks.createStorage,
}));
vi.mock("./openclaw-state-lease-heartbeat.js", () => ({
  startOpenClawStateLeaseHeartbeat: mocks.startHeartbeat,
}));
vi.mock("./openclaw-state-db-cache.js", () => ({
  registerOpenClawStateDatabaseAsyncResource: mocks.registerResource,
}));
vi.mock("./openclaw-state-lease-process-exit.js", () => ({
  registerProcessExitLeaseCleanup: () => mocks.unregisterExit,
}));
vi.mock("./openclaw-state-lease-storage.js", () => ({
  STATE_LEASE_WRITE_BACKOFF: { initialMs: 25, maxMs: 250, factor: 1.5, jitter: 0.25 },
  isOpenClawStateLeaseWriteContention: mocks.isWriteContention,
  releaseOpenClawStateLeaseBestEffort: async (_params: unknown, execute?: () => Promise<void>) =>
    execute?.(),
  readLeaseDatabase: mocks.forbidden,
  resolveLeaseDatabasePath: mocks.forbidden,
  acquireLease: mocks.forbidden,
  renewOpenClawStateLease: mocks.forbidden,
  assertOpenClawStateLeaseOwnedInDatabase: mocks.forbidden,
  verifyOpenClawStateLeaseOwnership: mocks.forbidden,
  releaseOpenClawStateLease: mocks.forbidden,
}));
vi.mock("./openclaw-state-db-readonly.js", () => ({
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnly: mocks.forbidden,
}));
vi.mock("./openclaw-state-lease-exclusion.js", () => ({
  createOpenClawStateLeaseExclusion: mocks.forbidden,
}));
vi.mock("../infra/sqlite-worker-operation-admission.js", () => ({
  createSqliteWorkerOperationAdmission: mocks.forbidden,
}));
vi.mock("../infra/sqlite-worker-identity.js", () => ({
  inspectDatabasePathIdentitySync: mocks.forbidden,
  readDatabasePathIdentitySync: mocks.forbidden,
}));
vi.mock("../infra/state-database-coordinator.js", () => ({
  StateDatabaseCoordinatorContentionError: class extends Error {
    readonly family = "state-lifecycle";
  },
}));
vi.mock("../infra/sqlite-coordinator.js", () => ({
  createSqliteLifecycleAggregateError: (errors: unknown[], message: string, cause: unknown) =>
    new AggregateError(errors, message, { cause }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isWriteContention.mockReturnValue(false);
});
afterEach(() => expect(mocks.forbidden).not.toHaveBeenCalled());

function observe<T>(promise: Promise<T>) {
  let settled = false;
  const outcome = promise.then(
    (value) => {
      settled = true;
      return { ok: true as const, value };
    },
    (error: unknown) => {
      settled = true;
      return { ok: false as const, error };
    },
  );
  return { outcome, settled: () => settled };
}

function fixture(
  options: {
    pauseAcquisition?: boolean;
    firstCleanupError?: Error;
    firstReleaseError?: Error;
  } = {},
) {
  const maintenance = createOpenClawDatabaseMaintenanceScope(mocks.forbidden);
  const events: string[] = [];
  const registered = new Set<OpenClawStateDatabaseAsyncResource>();
  const acquiring = createDeferredCore();
  const allowAcquire = createDeferredCore();
  const started = createDeferredCore();
  const ready = createDeferredCore();
  const cleanupStarted = createDeferredCore();
  const allowCleanup = createDeferredCore();
  const retryStarted = createDeferredCore();
  const allowRetry = createDeferredCore();
  const acquired: OpenClawStateLeaseIdentity[] = [];
  const released: OpenClawStateLeaseIdentity[] = [];
  let releaseAttempts = 0;
  let cleanupComplete = false;
  let cleanupAttempts = 0;
  let cleanupAttempt: Promise<void> | undefined;
  const context: OpenClawStateWorkerContext = {
    environment: { OPENCLAW_STATE_DIR: "/synthetic-state" },
    coordinatorRuntime: { directory: "/synthetic-coordinator", keepAlive: false },
    maintenanceScope: maintenance,
    admission: {
      databasePath: "/synthetic-state/lease.sqlite",
      identity: { key: "file:synthetic-state", canonicalPath: "/synthetic-state/lease.sqlite" },
      assertCurrent() {
        expect(getOpenClawDatabaseMaintenanceScope()).toBe(maintenance);
      },
    },
  };
  const assertCurrent = () => {
    maintenance.assertAdmission();
    context.admission.assertCurrent();
  };
  mocks.registerResource.mockImplementation((resource) => {
    events.push("register");
    registered.add(resource);
    return () => registered.delete(resource);
  });
  mocks.createStorage.mockImplementation((originalContext) => {
    expect(originalContext).toBe(context);
    return {
      path: context.admission.databasePath,
      assertCurrent,
      verify: mocks.forbidden,
      renew: mocks.forbidden,
      startTimer: mocks.forbidden,
      async withRetainedStartup(operation, assertActive) {
        assertCurrent();
        assertActive();
        return operation(originalContext);
      },
      acquire: (owner, leaseMs) =>
        owner.runLifecycle("acquire", async (scope) => {
          scope.assertCurrent();
          events.push("acquire");
          acquiring.resolve();
          if (options.pauseAcquisition) {
            await allowAcquire.promise;
            scope.assertCurrent();
          }
          acquired.push(scope.identity);
          return { kind: "acquired", expiresAt: Date.now() + leaseMs };
        }),
      release: (owner) =>
        owner.runLifecycle("release", async (scope) => {
          scope.assertCurrent();
          expect(cleanupComplete).toBe(true);
          events.push("release");
          if (releaseAttempts++ === 0 && options.firstReleaseError) {
            throw options.firstReleaseError;
          }
          released.push(scope.identity);
        }),
    };
  });
  const cleanup: LeaseHeartbeatCleanup = {
    get pending() {
      return !cleanupComplete;
    },
    close() {
      if (cleanupComplete) {
        return Promise.resolve();
      }
      return (cleanupAttempt ??= Promise.resolve()
        .then(async () => {
          assertCurrent();
          cleanupAttempts += 1;
          if (cleanupAttempts === 1) {
            cleanupStarted.resolve();
            await allowCleanup.promise;
            if (options.firstCleanupError) {
              events.push("heartbeat-cleanup-failed");
              throw options.firstCleanupError;
            }
          } else {
            retryStarted.resolve();
            await allowRetry.promise;
          }
          cleanupComplete = true;
          events.push("heartbeat-cleanup-complete");
        })
        .catch((error: unknown) => {
          cleanupAttempt = undefined;
          throw error;
        }));
    },
  };
  mocks.startHeartbeat.mockImplementation((params) => {
    expect(params.startupContext).toBe(context);
    params.retainCleanup?.(cleanup);
    started.resolve();
    return {
      ready: ready.promise,
      assertRunning: assertCurrent,
      verify: async () => Date.now() + params.leaseMs,
      renew: async () => Date.now() + params.leaseMs,
      assertResponsive: mocks.forbidden,
      close: mocks.forbidden,
      stop: async () => {
        await cleanup.close();
        return 0;
      },
    };
  });
  const closeActor = vi.fn(() => {
    events.push("actor-close");
  });
  // Insert first: phase ordering, rather than insertion ordering, must protect it.
  maintenance.own({}, "shared-resources", closeActor);
  return {
    maintenance,
    context,
    events,
    registered,
    acquiring,
    allowAcquire,
    started,
    ready,
    cleanupStarted,
    allowCleanup,
    retryStarted,
    allowRetry,
    acquired,
    released,
    closeActor,
    options: {
      scope: "core:mcp-oauth",
      key: "synthetic-maintenance",
      leaseMs: 30_000,
      waitMs: 0,
      heartbeat: "worker" as const,
    },
  };
}

describe("async lease maintenance ownership", () => {
  it.each([false, true])(
    "bridges a short lease across delayed independent-heartbeat startup (contention: %s)",
    async (contention) => {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const f = fixture();
      const createStorage = mocks.createStorage.getMockImplementation();
      const startHeartbeat = mocks.startHeartbeat.getMockImplementation();
      if (!createStorage || !startHeartbeat) {
        throw new Error("Lease fixture did not install its owners");
      }
      let expiresAt = 0;
      const busy = new Error("Synthetic startup write contention");
      mocks.isWriteContention.mockImplementation((error) => error === busy);
      mocks.createStorage.mockImplementation((context) => {
        const storage = createStorage(context);
        const acquire = storage.acquire.bind(storage);
        storage.acquire = async (...args) => {
          const result = await acquire(...args);
          if (result.kind === "acquired") {
            expiresAt = result.expiresAt;
          }
          return result;
        };
        storage.renew = (owner, leaseMs) =>
          owner.runLifecycle("renew", async (scope) => {
            scope.assertCurrent();
            expiresAt = Date.now() + leaseMs;
            if (contention) {
              // The independent child renewed while the actor was denied its writer turn.
              throw busy;
            }
            return expiresAt;
          });
        storage.verify = (owner) =>
          owner.runLifecycle("verify", async (scope) => {
            scope.assertCurrent();
            return expiresAt;
          });
        return storage;
      });
      mocks.startHeartbeat.mockImplementation((params) => {
        const heartbeat = startHeartbeat(params);
        setTimeout(() => {
          void Promise.resolve(params.renewDuringStartup?.()).catch(f.ready.reject);
        }, params.heartbeatMs);
        setTimeout(() => {
          if (expiresAt <= Date.now()) {
            f.ready.reject(new Error("The lease expired while the heartbeat was starting"));
          } else {
            f.ready.resolve();
          }
        }, 1_100);
        return heartbeat;
      });
      f.allowCleanup.resolve();
      const callback = vi.fn(async () => "completed");
      const observed = observe(
        withOpenClawStateLeaseAsync({ ...f.options, leaseMs: 1_000 }, f.context, callback),
      );
      try {
        await Promise.race([
          f.started.promise,
          observed.outcome.then((result) => {
            throw result.ok ? new Error("Lease completed before startup") : result.error;
          }),
        ]);
        await f.maintenance.run(() => vi.advanceTimersByTimeAsync(1_100));
        expect(await observed.outcome).toEqual({ ok: true, value: "completed" });
        expect(callback).toHaveBeenCalledOnce();
        expect(f.released).toEqual(f.acquired);
      } finally {
        f.ready.resolve();
        f.allowCleanup.resolve();
        f.allowRetry.resolve();
        await observed.outcome;
        await f.maintenance.close();
        vi.useRealTimers();
      }
    },
  );

  it("keeps the complete lease with its original scope when another scope invokes it", async () => {
    const f = fixture();
    const other = createOpenClawDatabaseMaintenanceScope(mocks.forbidden);
    const entered = createDeferredCore();
    const finishCallback = createDeferredCore();
    const callback = vi.fn(async () => {
      expect(getOpenClawDatabaseMaintenanceScope()).toBe(f.maintenance);
      entered.resolve();
      await finishCallback.promise;
      return "completed";
    });
    // The caller borrows the captured context without enrolling its Promise in the other scope.
    const { operation } = other.run(() => ({
      operation: withOpenClawStateLeaseAsync(f.options, f.context, callback),
    }));
    const observed = observe(operation);
    try {
      await f.started.promise;
      f.ready.resolve();
      await entered.promise;
      const closing = observe(f.maintenance.close());
      await other.close();
      expect(closing.settled()).toBe(false);
      expect(f.closeActor).not.toHaveBeenCalled();
      finishCallback.resolve();
      await f.cleanupStarted.promise;
      expect(observed.settled()).toBe(false);
      expect(closing.settled()).toBe(false);
      expect(f.released).toEqual([]);
      f.allowCleanup.resolve();
      expect(await observed.outcome).toEqual({ ok: true, value: "completed" });
      expect(await closing.outcome).toEqual({ ok: true, value: undefined });
      expect(f.events).toEqual([
        "register",
        "acquire",
        "heartbeat-cleanup-complete",
        "release",
        "actor-close",
      ]);
      expect(f.released).toEqual(f.acquired);
      expect(f.registered.size).toBe(0);
    } finally {
      f.ready.resolve();
      finishCallback.resolve();
      f.allowCleanup.resolve();
      f.allowRetry.resolve();
      await observed.outcome;
      await f.maintenance.close();
      await other.close();
    }
  });

  it("retries retained heartbeat cleanup before actor close without replaying a rejected callback", async () => {
    const callbackError = new Error("Synthetic callback failed");
    const cleanupError = new Error("Synthetic heartbeat cleanup failed once");
    const f = fixture({ firstCleanupError: cleanupError });
    const write = vi.fn();
    const callback = vi.fn(async (lease: OpenClawStateAsyncLeaseContext) => {
      await withOpenClawStateLeaseWorkerAdmission(
        lease,
        f.context.admission.databasePath,
        async (scope) => {
          scope.assertCurrent();
          write();
        },
      );
      throw callbackError;
    });
    const observed = observe(withOpenClawStateLeaseAsync(f.options, f.context, callback));
    try {
      await f.started.promise;
      f.ready.resolve();
      await f.cleanupStarted.promise;
      f.allowCleanup.resolve();
      expect(await observed.outcome).toMatchObject({
        ok: false,
        error: { cause: callbackError, errors: [callbackError, { errors: [cleanupError] }] },
      });
      expect(f.registered.size).toBe(1);
      expect(f.released).toEqual([]);
      const closing = observe(f.maintenance.close());
      await f.retryStarted.promise;
      expect(closing.settled()).toBe(false);
      expect(f.closeActor).not.toHaveBeenCalled();
      expect(f.released).toEqual([]);
      f.allowRetry.resolve();
      expect(await closing.outcome).toEqual({ ok: true, value: undefined });
      await f.maintenance.close();
      expect(callback).toHaveBeenCalledOnce();
      expect(write).toHaveBeenCalledOnce();
      expect(f.acquired).toHaveLength(1);
      expect(f.released).toEqual(f.acquired);
      expect(f.closeActor).toHaveBeenCalledOnce();
      expect(f.registered.size).toBe(0);
      expect(f.events).toEqual([
        "register",
        "acquire",
        "heartbeat-cleanup-failed",
        "heartbeat-cleanup-complete",
        "release",
        "actor-close",
      ]);
    } finally {
      f.ready.resolve();
      f.allowCleanup.resolve();
      f.allowRetry.resolve();
      await observed.outcome;
      await f.maintenance.close();
    }
  });

  it("retains a failed exact-owner release for cleanup retry without replaying the callback", async () => {
    const releaseError = new Error("Synthetic known release failure");
    const f = fixture({ firstReleaseError: releaseError });
    const callback = vi.fn(async () => "completed");
    f.allowCleanup.resolve();
    const observed = observe(withOpenClawStateLeaseAsync(f.options, f.context, callback));
    try {
      await f.started.promise;
      f.ready.resolve();
      expect(await observed.outcome).toEqual({ ok: false, error: releaseError });
      expect(f.registered.size).toBe(1);
      expect(f.released).toEqual([]);
      await f.maintenance.close();
      expect(callback).toHaveBeenCalledOnce();
      expect(f.released).toEqual(f.acquired);
      expect(f.registered.size).toBe(0);
      expect(f.events).toEqual([
        "register",
        "acquire",
        "heartbeat-cleanup-complete",
        "release",
        "release",
        "actor-close",
      ]);
    } finally {
      f.ready.resolve();
      f.allowCleanup.resolve();
      f.allowRetry.resolve();
      await observed.outcome;
      await f.maintenance.close();
    }
  });

  it.each(["all", "identity", "replacement"] as const)(
    "registers before acquisition so an external canonical close can drain the pending lease (%s)",
    async (closeKind) => {
      const f = fixture({ pauseAcquisition: true });
      const callback = vi.fn(async () => "must not enter");
      const observed = observe(withOpenClawStateLeaseAsync(f.options, f.context, callback));
      try {
        await f.acquiring.promise;
        expect(f.events).toEqual(["register", "acquire"]);
        expect(f.registered.size).toBe(1);
        await Promise.all(
          [...f.registered].map((resource) =>
            resource.close({
              key: "file:sibling",
              canonicalPath: "/synthetic-state/sibling.sqlite",
            }),
          ),
        );
        const identity = f.context.admission.identity;
        const closingIdentity =
          closeKind === "all"
            ? undefined
            : closeKind === "identity"
              ? identity
              : { ...identity, key: "file:replacement" };
        // Model the registry's resource snapshot; no path resolution or native close runs.
        const closing = observe(
          Promise.all([...f.registered].map((resource) => resource.close(closingIdentity))),
        );
        expect(observed.settled()).toBe(false);
        expect(closing.settled()).toBe(false);
        f.allowAcquire.resolve();
        f.ready.resolve();
        f.allowCleanup.resolve();
        expect(await observed.outcome).toMatchObject({
          ok: false,
          error: { code: "OPENCLAW_STATE_LEASE_LOST" },
        });
        expect(await closing.outcome).toEqual({ ok: true, value: [undefined] });
        expect(callback).not.toHaveBeenCalled();
        expect(mocks.startHeartbeat).not.toHaveBeenCalled();
        expect(f.acquired).toEqual([]);
        expect(f.released).toEqual([]);
        expect(f.registered.size).toBe(0);
      } finally {
        f.allowAcquire.resolve();
        await observed.outcome;
        await f.maintenance.close();
      }
    },
  );
});
