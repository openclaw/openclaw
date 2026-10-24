import { afterEach, expect, it, vi } from "vitest";
import type { WorkerSshIdentityRequest } from "../../plugins/types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveWorkerSshIdentity } from "./identity.js";
import * as support from "./service.test-support.js";
import { createWorkerTunnelManager } from "./tunnel.js";
import { fakeRunner, success } from "./tunnel.test-support.js";

const IDENTITY = { kind: "path", path: "/keys/worker" } as const;
support.setupWorkerEnvironmentServiceSuite();
afterEach(() => vi.useRealTimers());

async function fixture({ hold = false, cooperate = true, timeoutMs = 0 } = {}) {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const settled = createDeferredCore();
  const effect = vi.fn();
  const resolveIdentity = vi.fn(
    async (request: WorkerSshIdentityRequest & { assertCurrent?: () => void }) => {
      entered.resolve();
      try {
        if (hold) {
          await release.promise;
        }
        if (cooperate) {
          request.assertCurrent?.();
        }
        effect();
        return cooperate
          ? IDENTITY
          : { kind: "material" as const, contents: "synthetic-worker-key" };
      } finally {
        settled.resolve();
      }
    },
  );
  const manager = createWorkerTunnelManager({ runner: fakeRunner(() => success()).runner });
  const service = support.createService(
    support.createProvider({ resolveSshIdentity: resolveIdentity }),
    {
      tunnelManager: manager,
      ...(timeoutMs ? { providerCallTimeoutMs: timeoutMs } : {}),
      resolveSshIdentity: (request) =>
        resolveWorkerSshIdentity({
          ...request,
          resolveGeneric: async () => ({ kind: "path", path: "/keys/generic" }),
        }),
    },
  );
  const environment = await support.seedReady("worker-identity");
  const operations: Promise<unknown>[] = [];
  const track = (operation: Promise<unknown>) => {
    const pending = operation.catch((error: unknown) => error);
    operations.push(pending);
    return pending;
  };
  return {
    manager,
    service,
    environment,
    entered,
    release,
    settled,
    effect,
    resolveIdentity,
    lookup: () => track(service.resolveSshIdentity(environment.environmentId)),
    start: () =>
      track(
        service.startTunnel({
          environmentId: environment.environmentId,
          ownerEpoch: environment.ownerEpoch,
        }),
      ),
    [Symbol.asyncDispose]: async () => {
      release.resolve();
      await Promise.all(operations);
      if (resolveIdentity.mock.calls.length) {
        await settled.promise;
      }
      await manager.stopAll();
    },
  };
}

it.each(["tunnel stop", "timeout"] as const)(
  "fences a cooperating SSH resolver after %s",
  async (mode) => {
    if (mode === "timeout") {
      vi.useFakeTimers();
    }
    await using f = await fixture({ hold: true, timeoutMs: mode === "timeout" ? 25 : 0 });
    const pending = mode === "timeout" ? f.lookup() : f.start();
    await f.entered.promise;
    if (mode === "timeout") {
      await vi.advanceTimersByTimeAsync(25);
    } else {
      const stopping = f.manager.stop(f.environment.environmentId, f.environment.ownerEpoch);
      expect(f.service.get(f.environment.environmentId)?.ownerEpoch).toBe(f.environment.ownerEpoch);
      f.release.resolve();
      await stopping;
    }
    expect(await pending).toBeInstanceOf(Error);
    f.release.resolve();
    await f.settled.promise;
    expect(f.effect).not.toHaveBeenCalled();
  },
);

it("closes retained assertions but permits subsequent legacy lookups", async () => {
  await using f = await fixture();
  await expect(f.lookup()).resolves.toEqual(IDENTITY);
  const retained = f.resolveIdentity.mock.calls[0]?.[0].assertCurrent;
  expect(retained).toBeTypeOf("function");
  expect(() => retained?.()).toThrow("identity invocation is closed");
  await expect(f.lookup()).resolves.toEqual(IDENTITY);
  expect(f.resolveIdentity).toHaveBeenCalledTimes(2);
});

it("rejects a late identity and its queued lookup after the lease owner changes", async () => {
  await using f = await fixture({ hold: true, cooperate: false });
  const first = f.lookup();
  await f.entered.promise;
  const second = f.lookup();
  await f.service.attachSession({
    environmentId: f.environment.environmentId,
    ownerEpoch: f.environment.ownerEpoch,
    sessionId: "queued-new-owner",
  });
  f.release.resolve();
  expect(await Promise.all([first, second])).toEqual([expect.any(Error), expect.any(Error)]);
  expect(f.resolveIdentity).toHaveBeenCalledOnce();
});
