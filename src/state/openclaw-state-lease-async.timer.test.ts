import { AsyncLocalStorage } from "node:async_hooks";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  takeSqliteWorkerOperationAdmissionAttachment,
  withSqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
import type { SqliteWorkerOperationSettlement } from "../infra/sqlite-worker-operation-settlement.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createOpenClawDatabaseMaintenanceScope,
  getOpenClawDatabaseMaintenanceScope,
  type OpenClawStateDatabaseAsyncResource,
} from "./openclaw-state-db-async-lifecycle.js";
import type { OpenClawStateAsyncLeaseContext } from "./openclaw-state-lease-context.js";
import { leaseHeartbeatState } from "./openclaw-state-lease-heartbeat-shared.js";
import { withOpenClawStateLeaseAsync } from "./openclaw-state-lease.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";

type Storage = ReturnType<
  typeof import("./openclaw-state-lease-worker-storage.js").createOpenClawStateLeaseWorkerStorage
>;
type LeaseOwner = Parameters<Storage["acquire"]>[0];
type Command = { assertCurrent(): void; publish(expiresAt: number): number };

const mocks = vi.hoisted(() => ({
  configureStorage: vi.fn<(storage: Storage) => Storage>(),
  registerResource: vi.fn<(resource: OpenClawStateDatabaseAsyncResource) => () => void>(),
  forbidden: vi.fn(() => {
    throw new Error("Controlled timer test reached SQLite or an independent heartbeat worker");
  }),
}));

vi.mock("./openclaw-state-lease-worker-storage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./openclaw-state-lease-worker-storage.js")>();
  return {
    ...actual,
    createOpenClawStateLeaseWorkerStorage: (context: OpenClawStateWorkerContext) =>
      mocks.configureStorage(actual.createOpenClawStateLeaseWorkerStorage(context)),
  };
});
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  Worker: vi.fn(function Worker() {
    mocks.forbidden();
  }),
}));
vi.mock("./openclaw-state-worker-store.js", () => ({
  runOpenClawStateWorkerOperation: mocks.forbidden,
}));
vi.mock("./openclaw-state-db-cache.js", () => ({
  registerOpenClawStateDatabaseAsyncResource: mocks.registerResource,
}));
vi.mock("./openclaw-state-lease-process-exit.js", () => ({
  registerProcessExitLeaseCleanup: () => () => {},
}));
vi.mock("./openclaw-state-lease-storage.js", () => ({
  STATE_LEASE_WRITE_BACKOFF: { initialMs: 25, maxMs: 250, factor: 1.5, jitter: 0.25 },
  isOpenClawStateLeaseWriteContention: () => false,
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
vi.mock("../infra/sqlite-worker-identity.js", () => ({
  inspectDatabasePathIdentitySync: mocks.forbidden,
  readDatabasePathIdentitySync: mocks.forbidden,
}));
vi.mock("../infra/state-database-coordinator.js", () => ({
  acquireStateDatabaseHandleLease: mocks.forbidden,
  retainHeldStateDatabaseCoordinator: mocks.forbidden,
  withStateDatabaseCoordinatorRuntimeDirectory: mocks.forbidden,
}));
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  expect(mocks.forbidden).not.toHaveBeenCalled();
});

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

function fixture() {
  const maintenance = createOpenClawDatabaseMaintenanceScope(mocks.forbidden);
  const resources = new Set<OpenClawStateDatabaseAsyncResource>();
  const leaseMs = 3_000;
  let committedExpiry = Date.now() + leaseMs;
  const entered = createDeferredCore<{
    lease: OpenClawStateAsyncLeaseContext;
    within: ReturnType<typeof AsyncLocalStorage.snapshot>;
  }>();
  const finishCallback = createDeferredCore();
  const events: string[] = [];
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
  const onRenew = vi.fn(async (command: Command) => command.publish(Date.now() + leaseMs));
  const onVerify = vi.fn(async (command: Command) => command.publish(committedExpiry));
  const execute = (
    owner: LeaseOwner,
    purpose: "acquire" | "verify" | "renew",
    operation: (command: Command) => Promise<number>,
  ) =>
    owner.runLifecycle(purpose, async (scope) => {
      scope.assertCurrent();
      const settled = createDeferredCore<SqliteWorkerOperationSettlement>();
      const { admission } = scope.createAdmission({ settled: settled.promise });
      try {
        const attachment = withSqliteWorkerOperationAdmission(
          { port: admission.port },
          takeSqliteWorkerOperationAdmissionAttachment,
        );
        if (
          !isRecord(attachment) ||
          attachment.kind !== "state-lease-expiry" ||
          !(attachment.observation instanceof SharedArrayBuffer)
        ) {
          throw new Error("Missing owner-bound expiry observation");
        }
        expect(attachment.identity).toEqual(scope.identity);
        const observation = new BigInt64Array(attachment.observation);
        return await operation({
          assertCurrent: scope.assertCurrent,
          publish(expiresAt) {
            committedExpiry = expiresAt;
            Atomics.store(observation, leaseHeartbeatState.expiresAt, BigInt(expiresAt));
            return expiresAt;
          },
        });
      } finally {
        admission.finish();
        settled.resolve({ kind: "completed" });
      }
    });
  const renew = vi.fn<Storage["renew"]>((owner) => execute(owner, "renew", onRenew));
  const verify = vi.fn<Storage["verify"]>((owner) => execute(owner, "verify", onVerify));
  const release = vi.fn<Storage["release"]>((owner) =>
    owner.runLifecycle("release", async (scope) => {
      scope.assertCurrent();
      events.push("release");
    }),
  );
  mocks.configureStorage.mockImplementation((storage) => {
    storage.acquire = async (owner) => ({
      kind: "acquired",
      expiresAt: await execute(owner, "acquire", async (command) =>
        command.publish(committedExpiry),
      ),
    });
    storage.renew = renew;
    storage.verify = verify;
    storage.release = release;
    storage.withRetainedStartup = mocks.forbidden;
    return storage;
  });
  mocks.registerResource.mockImplementation((resource) => {
    resources.add(resource);
    return () => {
      resources.delete(resource);
    };
  });
  maintenance.own({}, "shared-resources", () => {
    events.push("actor-close");
  });
  const run = () =>
    observe(
      withOpenClawStateLeaseAsync(
        { scope: "core:mcp-oauth", key: "timer", leaseMs, waitMs: 0 },
        context,
        async (lease) => {
          entered.resolve({ lease, within: AsyncLocalStorage.snapshot() });
          await finishCallback.promise;
          return "completed";
        },
      ),
    );
  return {
    run,
    maintenance,
    resources,
    entered,
    finishCallback,
    onRenew,
    onVerify,
    renew,
    verify,
    release,
    events,
  };
}

describe("async state lease timer", () => {
  it("joins renewal before sealing public methods and keeps private final verification available", async () => {
    const f = fixture();
    const renewing = createDeferredCore();
    const reply = createDeferredCore();
    const verifying = createDeferredCore();
    const finalReply = createDeferredCore();
    f.onRenew.mockImplementationOnce(async (command) => {
      renewing.resolve();
      await reply.promise;
      command.assertCurrent();
      return command.publish(Date.now() + 3_000);
    });
    const result = f.run();
    try {
      const { lease, within } = await Promise.race([
        f.entered.promise,
        result.outcome.then((outcome) => {
          throw outcome.ok ? new Error("Lease completed before callback") : outcome.error;
        }),
      ]);
      await within(() => vi.advanceTimersByTimeAsync(1_000));
      await renewing.promise;
      f.finishCallback.resolve();
      await within(() => lease.assertOwned());
      expect(result.settled()).toBe(false);
      expect(f.release).not.toHaveBeenCalled();
      f.onVerify.mockImplementationOnce(async (command) => {
        const expiresAt = command.publish(Date.now() + 3_000);
        verifying.resolve();
        await finalReply.promise;
        command.assertCurrent();
        return expiresAt;
      });
      reply.resolve();
      await verifying.promise;
      const verifies = f.verify.mock.calls.length;
      await expect(within(() => lease.assertOwned())).rejects.toThrow(
        "differs from its live owner",
      );
      await expect(within(() => lease.renew())).rejects.toThrow("differs from its live owner");
      expect(f.verify).toHaveBeenCalledTimes(verifies);
      await within(() => vi.advanceTimersByTimeAsync(1_000));
      expect(f.renew).toHaveBeenCalledOnce();
      finalReply.resolve();
      expect(await result.outcome).toEqual({ ok: true, value: "completed" });
      await f.maintenance.close();
      expect(f.events).toEqual(["release", "actor-close"]);
      expect(f.resources.size).toBe(0);
    } finally {
      reply.resolve();
      finalReply.resolve();
      f.finishCallback.resolve();
      await result.outcome;
      await f.maintenance.close();
    }
  });

  it("observes committed renewal at the old expiry while the actor reply is still pending", async () => {
    const f = fixture();
    const committed = createDeferredCore();
    const reply = createDeferredCore();
    f.onRenew.mockImplementationOnce(async (command) => {
      const expiresAt = command.publish(Date.now() + 3_000);
      committed.resolve();
      await reply.promise;
      command.assertCurrent();
      return expiresAt;
    });
    const result = f.run();
    try {
      const { lease, within } = await Promise.race([
        f.entered.promise,
        result.outcome.then((outcome) => {
          throw outcome.ok ? new Error("Lease completed before callback") : outcome.error;
        }),
      ]);
      await within(() => vi.advanceTimersByTimeAsync(1_000));
      await committed.promise;
      await within(() => vi.advanceTimersByTimeAsync(2_000));
      expect(lease.signal.aborted).toBe(false);
      expect(f.renew).toHaveBeenCalledOnce();
      await within(() => lease.assertOwned());
      reply.resolve();
      f.finishCallback.resolve();
      expect(await result.outcome).toEqual({ ok: true, value: "completed" });
      expect(f.release).toHaveBeenCalledOnce();
    } finally {
      reply.resolve();
      f.finishCallback.resolve();
      await result.outcome;
      await f.maintenance.close();
    }
  });

  it.each(["assertOwned", "result"] as const)(
    "rejects delayed %s after expiry even before the timer callback runs",
    async (boundary) => {
      const f = fixture();
      const checked = createDeferredCore();
      const reply = createDeferredCore();
      const result = f.run();
      try {
        const { lease, within } = await Promise.race([
          f.entered.promise,
          result.outcome.then((outcome) => {
            throw outcome.ok ? new Error("Lease completed before callback") : outcome.error;
          }),
        ]);
        f.onVerify.mockImplementationOnce(async (command) => {
          const expiresAt = command.publish(Date.now() + 3_000);
          checked.resolve();
          await reply.promise;
          return expiresAt;
        });
        const assertion =
          boundary === "assertOwned" ? observe(within(() => lease.assertOwned())) : undefined;
        if (boundary === "result") {
          f.finishCallback.resolve();
        }
        await checked.promise;
        vi.setSystemTime(Date.now() + 3_001);
        expect(lease.signal.aborted).toBe(false);
        reply.resolve();
        if (assertion) {
          expect(await assertion.outcome).toMatchObject({
            ok: false,
            error: { code: "OPENCLAW_STATE_LEASE_LOST" },
          });
          f.finishCallback.resolve();
        }
        expect(await result.outcome).toMatchObject({
          ok: false,
          error: { code: "OPENCLAW_STATE_LEASE_LOST" },
        });
        expect(lease.signal.aborted).toBe(true);
        expect(f.release).toHaveBeenCalledOnce();
      } finally {
        reply.resolve();
        f.finishCallback.resolve();
        await result.outcome;
        await f.maintenance.close();
      }
    },
  );
});
