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

async function fixture({ cooperate = true, timeoutMs = 0 } = {}) {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const settled = createDeferredCore();
  const effect = vi.fn();
  const resolveIdentity = vi.fn(
    async (request: WorkerSshIdentityRequest & { assertCurrent?: () => void }) => {
      entered.resolve();
      try {
        await release.promise;
        if (cooperate) {
          request.assertCurrent?.();
        }
        effect();
        return IDENTITY;
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
  const { environmentId, ownerEpoch } = await support.seedReady("worker-identity");
  const environment = { environmentId, ownerEpoch };
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
    lookup: () => track(service.resolveSshIdentity(environmentId)),
    start: () => track(service.startTunnel(environment)),
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
    await using f = await fixture({ timeoutMs: mode === "timeout" ? 25 : 0 });
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
    await expect(f.lookup()).resolves.toEqual(IDENTITY);
  },
);

it("rejects a late identity and its queued lookup after the lease owner changes", async () => {
  await using f = await fixture({ cooperate: false });
  const first = f.lookup();
  await f.entered.promise;
  const second = f.lookup();
  await f.service.attachSession({
    ...f.environment,
    sessionId: "queued-new-owner",
  });
  f.release.resolve();
  expect(await Promise.all([first, second])).toEqual([expect.any(Error), expect.any(Error)]);
  expect(f.resolveIdentity).toHaveBeenCalledOnce();
});
