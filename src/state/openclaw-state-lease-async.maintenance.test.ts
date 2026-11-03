import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import {
  getOpenClawDatabaseMaintenanceScope,
  type OpenClawStateDatabaseAsyncResource as AsyncResource,
} from "./openclaw-state-db-async-lifecycle.js";
import {
  expiryAdmission,
  leaseTestContext,
  observe,
  waitUntil,
} from "./openclaw-state-lease-async.test-support.js";
import type { OpenClawStateAsyncLeaseContext } from "./openclaw-state-lease-context.js";
import type { LeaseHeartbeatCleanup } from "./openclaw-state-lease-heartbeat.js";
import {
  withOpenClawStateLeaseWorkerAdmission,
  type WorkerLeaseScope,
} from "./openclaw-state-lease-worker-owner.js";
import { withOpenClawStateLeaseAsync } from "./openclaw-state-lease.js";
import type { OpenClawStateLeaseIdentity } from "./openclaw-state-lease.types.js";

type CreateStorage =
  typeof import("./openclaw-state-lease-worker-storage.js").createOpenClawStateLeaseWorkerStorage;
type StartHeartbeat =
  typeof import("./openclaw-state-lease-heartbeat.js").startOpenClawStateLeaseHeartbeat;

const { leaseMocks } = await vi.hoisted(() => import("./openclaw-state-lease-async.test-mocks.js"));
const mocks = vi.hoisted(() => ({
  createStorage: vi.fn<CreateStorage>(),
  startHeartbeat: vi.fn<StartHeartbeat>(),
}));

// mock-isolation: Drive the real lease owner with controlled storage and reject native acquisition.
vi.mock("./openclaw-state-lease-worker-storage.js", () => ({
  createOpenClawStateLeaseWorkerStorage: mocks.createStorage,
  acquireLease: leaseMocks.forbidden,
}));
vi.mock("./openclaw-state-lease-heartbeat.js", () => ({
  startOpenClawStateLeaseHeartbeat: mocks.startHeartbeat,
}));
function publishExpiry(scope: WorkerLeaseScope, expiresAt: number): number {
  using observation = expiryAdmission(scope);
  return observation.publish(expiresAt);
}

function fixture(
  options: {
    pauseAcquisition?: boolean;
    failure?: { phase: "heartbeat" | "release"; error: Error };
    startupContention?: boolean;
  } = {},
) {
  const f = {
    ...leaseTestContext(),
    registered: new Set<AsyncResource>(),
    acquiring: createDeferredCore(),
    allowAcquire: createDeferredCore(),
    started: createDeferredCore(),
    ready: createDeferredCore(),
    cleanupStarted: createDeferredCore(),
    allowCleanup: createDeferredCore(),
    retryStarted: createDeferredCore(),
    allowRetry: createDeferredCore(),
    acquired: new Array<OpenClawStateLeaseIdentity>(),
    released: new Array<OpenClawStateLeaseIdentity>(),
    closeActor: vi.fn((): void => {
      expect(f.released).toEqual(f.acquired);
    }),
    closeResources(identity?: Parameters<AsyncResource["close"]>[0]): Promise<void[]> {
      return Promise.all([...f.registered].map((resource) => resource.close(identity)));
    },
    async dispose(outcome: Promise<unknown>): Promise<void> {
      for (const gate of [f.allowAcquire, f.ready, f.allowCleanup, f.allowRetry]) {
        gate.resolve();
      }
      await outcome;
      await f.maintenance.close();
    },
    options: {
      scope: "core:mcp-oauth",
      key: "synthetic-maintenance",
      leaseMs: 30_000,
      waitMs: 0,
      heartbeat: "worker" as const,
    },
  };
  const { maintenance, context } = f;
  let releaseAttempts = 0;
  let cleanupComplete = false;
  let cleanupAttempts = 0;
  let cleanupAttempt: Promise<void> | undefined;
  let expiresAt = 0;
  const startup = options.startupContention !== undefined;
  const busy = Object.assign(new Error("Synthetic startup write contention"), {
    code: "ERR_SQLITE_ERROR",
    errcode: 5,
  });
  leaseMocks.isWriteContention.mockImplementation((error) => error === busy);
  const assertCurrent = () => {
    maintenance.assertAdmission();
    context.admission.assertCurrent();
  };
  leaseMocks.registerResource.mockImplementation((resource) => {
    f.registered.add(resource);
    return () => f.registered.delete(resource);
  });
  mocks.createStorage.mockImplementation((originalContext) => {
    expect(originalContext).toBe(context);
    return {
      path: context.admission.databasePath,
      assertCurrent,
      verify: startup
        ? (owner) =>
            owner.runLifecycle("verify", async (scope) => {
              scope.assertCurrent();
              return publishExpiry(scope, expiresAt);
            })
        : leaseMocks.forbidden,
      renew: startup
        ? (owner, leaseMs) =>
            owner.runLifecycle("renew", async (scope) => {
              scope.assertCurrent();
              expiresAt = Date.now() + leaseMs;
              // The independent child can renew while the actor is denied its writer turn.
              if (options.startupContention) {
                throw busy;
              }
              return publishExpiry(scope, expiresAt);
            })
        : leaseMocks.forbidden,
      startTimer: leaseMocks.forbidden,
      async withRetainedStartup(operation, assertActive) {
        assertCurrent();
        assertActive();
        return operation(originalContext);
      },
      acquire: (owner, leaseMs) =>
        owner.runLifecycle("acquire", async (scope) => {
          scope.assertCurrent();
          expect(f.registered.size).toBe(1);
          f.acquiring.resolve();
          if (options.pauseAcquisition) {
            await f.allowAcquire.promise;
            scope.assertCurrent();
          }
          f.acquired.push(scope.identity);
          expiresAt = publishExpiry(scope, Date.now() + leaseMs);
          return { kind: "acquired", expiresAt };
        }),
      release: (owner) =>
        owner.runLifecycle("release", async (scope) => {
          scope.assertCurrent();
          expect(cleanupComplete).toBe(true);
          if (releaseAttempts++ === 0 && options.failure?.phase === "release") {
            throw options.failure.error;
          }
          f.released.push(scope.identity);
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
          if (++cleanupAttempts === 1) {
            f.cleanupStarted.resolve();
            await f.allowCleanup.promise;
            if (options.failure?.phase === "heartbeat") {
              throw options.failure.error;
            }
          } else {
            f.retryStarted.resolve();
            await f.allowRetry.promise;
          }
          cleanupComplete = true;
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
    f.started.resolve();
    if (startup) {
      setTimeout(() => {
        void Promise.resolve(params.renewDuringStartup?.()).catch(f.ready.reject);
      }, params.heartbeatMs);
      setTimeout(() => {
        if (expiresAt <= Date.now()) {
          f.ready.reject(new Error("Lease expired during heartbeat startup"));
        } else {
          f.ready.resolve();
        }
      }, 1_100);
    }
    return {
      ready: f.ready.promise,
      assertRunning: assertCurrent,
      verify: async () => Date.now() + params.leaseMs,
      renew: async () => Date.now() + params.leaseMs,
      holdOwnerFence: leaseMocks.forbidden,
      close: leaseMocks.forbidden,
      stop: async () => {
        await cleanup.close();
        return 0;
      },
    };
  });
  // Insert first: phase ordering, rather than insertion ordering, must protect it.
  maintenance.own({}, "shared-resources", f.closeActor);
  return f;
}

describe("async lease maintenance ownership", () => {
  it.each([false, true])(
    "bridges a short lease across delayed independent-heartbeat startup (contention: %s)",
    async (contention) => {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const f = fixture({ startupContention: contention });
      f.allowCleanup.resolve();
      const callback = vi.fn(async () => "completed");
      const observed = observe(
        withOpenClawStateLeaseAsync({ ...f.options, leaseMs: 1_000 }, f.context, callback),
      );
      try {
        await waitUntil(f.started.promise, observed);
        await f.maintenance.run(() => vi.advanceTimersByTimeAsync(1_100));
        expect(await observed.outcome).toEqual({ ok: true, value: "completed" });
        expect(callback).toHaveBeenCalledOnce();
        expect(f.released).toEqual(f.acquired);
      } finally {
        await f.dispose(observed.outcome);
        vi.useRealTimers();
      }
    },
  );

  it("keeps the complete lease with its original scope when another scope invokes it", async () => {
    const f = fixture();
    const { maintenance: other } = leaseTestContext();
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
      expect(f.closeActor).toHaveBeenCalledOnce();
      expect(f.released).toEqual(f.acquired);
      expect(f.registered.size).toBe(0);
    } finally {
      finishCallback.resolve();
      await f.dispose(observed.outcome);
      await other.close();
    }
  });

  it.each(["heartbeat", "release"] as const)(
    "retries retained %s cleanup before actor close without replaying the callback",
    async (phase) => {
      const callbackError = new Error("Synthetic callback failed");
      const cleanupError = new Error("Synthetic cleanup failed once");
      const f = fixture({ failure: { phase, error: cleanupError } });
      const write = vi.fn();
      const callback = vi.fn(async (lease: OpenClawStateAsyncLeaseContext) => {
        if (phase === "heartbeat") {
          await withOpenClawStateLeaseWorkerAdmission(
            lease,
            f.context.admission.databasePath,
            async (scope) => {
              scope.assertCurrent();
              write();
            },
          );
          throw callbackError;
        }
        return "completed";
      });
      const observed = observe(withOpenClawStateLeaseAsync(f.options, f.context, callback));
      try {
        await f.started.promise;
        f.ready.resolve();
        await f.cleanupStarted.promise;
        f.allowCleanup.resolve();
        if (phase === "heartbeat") {
          expect(await observed.outcome).toMatchObject({
            ok: false,
            error: { cause: callbackError, errors: [callbackError, { errors: [cleanupError] }] },
          });
        } else {
          expect(await observed.outcome).toEqual({ ok: false, error: cleanupError });
        }
        expect(f.registered.size).toBe(1);
        expect(f.released).toEqual([]);
        const closing = observe(f.maintenance.close());
        if (phase === "heartbeat") {
          await f.retryStarted.promise;
          expect(closing.settled()).toBe(false);
          expect(f.closeActor).not.toHaveBeenCalled();
          expect(f.released).toEqual([]);
          f.allowRetry.resolve();
        }
        expect(await closing.outcome).toEqual({ ok: true, value: undefined });
        await f.maintenance.close();
        expect(callback).toHaveBeenCalledOnce();
        expect(write).toHaveBeenCalledTimes(phase === "heartbeat" ? 1 : 0);
        expect(f.acquired).toHaveLength(1);
        expect(f.released).toEqual(f.acquired);
        expect(f.closeActor).toHaveBeenCalledOnce();
        expect(f.registered.size).toBe(0);
      } finally {
        await f.dispose(observed.outcome);
      }
    },
  );

  it.each(["all", "identity", "replacement"] as const)(
    "registers before acquisition so an external canonical close can drain the pending lease (%s)",
    async (closeKind) => {
      const f = fixture({ pauseAcquisition: true });
      const callback = vi.fn(async () => "must not enter");
      const observed = observe(withOpenClawStateLeaseAsync(f.options, f.context, callback));
      try {
        await f.acquiring.promise;
        expect(f.registered.size).toBe(1);
        await f.closeResources({
          key: "file:sibling",
          canonicalPath: "/synthetic-state/sibling.sqlite",
        });
        const identity = f.context.admission.identity;
        const closingIdentity =
          closeKind === "all"
            ? undefined
            : closeKind === "identity"
              ? identity
              : { ...identity, key: "file:replacement" };
        const closing = observe(f.closeResources(closingIdentity));
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
        await f.dispose(observed.outcome);
      }
    },
  );
});
