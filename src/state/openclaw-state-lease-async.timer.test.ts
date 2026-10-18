import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import type { OpenClawStateDatabaseAsyncResource } from "./openclaw-state-db-async-lifecycle.js";
import {
  expiryAdmission,
  leaseTestContext,
  observe,
  waitUntil,
} from "./openclaw-state-lease-async.test-support.js";
import type { OpenClawStateAsyncLeaseContext } from "./openclaw-state-lease-context.js";
import { withOpenClawStateLeaseAsync } from "./openclaw-state-lease.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";

type Storage = ReturnType<
  typeof import("./openclaw-state-lease-worker-storage.js").createOpenClawStateLeaseWorkerStorage
>;
type LeaseOwner = Parameters<Storage["acquire"]>[0];
type Command = { assertCurrent(): void; publish(expiresAt: number): number };
const lostLease = { ok: false, error: { code: "OPENCLAW_STATE_LEASE_LOST" } };

const { leaseMocks } = await vi.hoisted(() => import("./openclaw-state-lease-async.test-mocks.js"));
const mocks = vi.hoisted(() => ({
  configureStorage: vi.fn<(storage: Storage) => Storage>(),
}));

vi.mock("./openclaw-state-lease-worker-storage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./openclaw-state-lease-worker-storage.js")>();
  return {
    ...actual,
    acquireLease: leaseMocks.forbidden,
    createOpenClawStateLeaseWorkerStorage: (context: OpenClawStateWorkerContext) =>
      mocks.configureStorage(actual.createOpenClawStateLeaseWorkerStorage(context)),
  };
});
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  Worker: vi.fn(function Worker() {
    leaseMocks.forbidden();
  }),
}));
// mock-isolation: The timer fixture drives storage itself and rejects worker-store dispatch.
vi.mock("./openclaw-state-worker-store.js", () => ({
  runOpenClawStateWorkerOperation: leaseMocks.forbidden,
}));

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});
afterEach(() => vi.useRealTimers());

function fixture() {
  const { maintenance, context } = leaseTestContext();
  const resources = new Set<OpenClawStateDatabaseAsyncResource>();
  const leaseMs = 3_000;
  let committedExpiry = Date.now() + leaseMs;
  const entered = createDeferredCore<{
    lease: OpenClawStateAsyncLeaseContext;
    within: ReturnType<typeof AsyncLocalStorage.snapshot>;
  }>();
  const finishCallback = createDeferredCore();
  const events: string[] = [];
  const onRenew = vi.fn(async (command: Command) => command.publish(Date.now() + leaseMs));
  const onVerify = vi.fn(async (command: Command) => command.publish(committedExpiry));
  const execute = (
    owner: LeaseOwner,
    purpose: "acquire" | "verify" | "renew",
    operation: (command: Command) => Promise<number>,
  ) =>
    owner.runLifecycle(purpose, async (scope) => {
      scope.assertCurrent();
      using observation = expiryAdmission(scope);
      return await operation({
        assertCurrent: scope.assertCurrent,
        publish(expiresAt) {
          committedExpiry = expiresAt;
          observation.publish(expiresAt);
          return expiresAt;
        },
      });
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
    storage.withRetainedStartup = leaseMocks.forbidden;
    return storage;
  });
  leaseMocks.registerResource.mockImplementation((resource) => {
    resources.add(resource);
    return () => resources.delete(resource);
  });
  maintenance.own({}, "shared-resources", () => void events.push("actor-close"));
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
    enter: (result: ReturnType<typeof run>) => waitUntil(entered.promise, result),
    maintenance,
    resources,
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
  it.each([false, true])(
    "joins renewal before sealing public methods (committed before reply: %s)",
    async (committedEarly) => {
      const f = fixture();
      const renewing = createDeferredCore();
      const reply = createDeferredCore();
      const verifying = createDeferredCore();
      const finalReply = createDeferredCore();
      f.onRenew.mockImplementationOnce(async (command) => {
        const expiresAt = committedEarly ? command.publish(Date.now() + 3_000) : undefined;
        renewing.resolve();
        await reply.promise;
        command.assertCurrent();
        return expiresAt ?? command.publish(Date.now() + 3_000);
      });
      const result = f.run();
      try {
        const { lease, within } = await f.enter(result);
        await within(() => vi.advanceTimersByTimeAsync(1_000));
        await renewing.promise;
        if (committedEarly) {
          await within(() => vi.advanceTimersByTimeAsync(2_000));
          expect(lease.signal.aborted).toBe(false);
          expect(f.renew).toHaveBeenCalledOnce();
          await within(() => lease.assertOwned());
        }
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
        expect(f.release).toHaveBeenCalledOnce();
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
    },
  );

  it.each(["assertOwned", "result"] as const)(
    "rejects delayed %s after expiry even before the timer callback runs",
    async (boundary) => {
      const f = fixture();
      const checked = createDeferredCore();
      const reply = createDeferredCore();
      const result = f.run();
      try {
        const { lease, within } = await f.enter(result);
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
          expect(await assertion.outcome).toMatchObject(lostLease);
          f.finishCallback.resolve();
        }
        expect(await result.outcome).toMatchObject(lostLease);
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
