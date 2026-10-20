import { describe, expect, it, vi } from "vitest";
import type { WorkerSshIdentity, WorkerSshIdentityRequest } from "../../plugins/types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveWorkerSshIdentity } from "./identity.js";
import * as support from "./service.test-support.js";
import { createWorkerTunnelManager } from "./tunnel.js";
import { fakeRunner, success } from "./tunnel.test-support.js";

type ObservedIdentityRequest = WorkerSshIdentityRequest & { assertCurrent?: () => void };
const IDENTITY = { kind: "path", path: "/keys/worker" } as const;

describe("worker SSH identity invocation lifetime", () => {
  support.setupWorkerEnvironmentServiceSuite();

  async function fixture(
    resolveIdentity: (request: ObservedIdentityRequest) => Promise<WorkerSshIdentity>,
    timeoutMs?: number,
  ) {
    const provider = support.createProvider({ resolveSshIdentity: resolveIdentity });
    const manager = createWorkerTunnelManager({ runner: fakeRunner(() => success()).runner });
    const service = support.createService(provider, {
      tunnelManager: manager,
      ...(timeoutMs ? { providerCallTimeoutMs: timeoutMs } : {}),
      resolveSshIdentity: (request) =>
        resolveWorkerSshIdentity({
          ...request,
          resolveGeneric: async () => ({ kind: "path", path: "/keys/generic" }),
        }),
    });
    const environment = await support.seedReady("worker-identity");
    return {
      manager,
      service,
      environment,
      lookup: () =>
        service.resolveSshIdentity(environment.environmentId).catch((error: unknown) => error),
    };
  }

  it("fences a cooperating legacy resolver when only its initializing tunnel stops", async () => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const effect = vi.fn();
    const { manager, service, environment } = await fixture(async (request) => {
      entered.resolve();
      await release.promise;
      request.assertCurrent?.();
      effect();
      return IDENTITY;
    });
    const starting = service
      .startTunnel({
        environmentId: environment.environmentId,
        ownerEpoch: environment.ownerEpoch,
      })
      .catch((error: unknown) => error);
    try {
      await entered.promise;
      const stopping = manager.stop(environment.environmentId, environment.ownerEpoch);
      expect(service.get(environment.environmentId)?.ownerEpoch).toBe(environment.ownerEpoch);
      release.resolve();
      await stopping;
      expect(await starting).toBeInstanceOf(Error);
      expect(effect).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await starting;
      await manager.stopAll();
    }
  });

  it("closes a retained assertion after direct identity lookup and permits another legacy lookup", async () => {
    let retained: (() => void) | undefined;
    const resolveIdentity = vi.fn(async (request: ObservedIdentityRequest) => {
      retained = request.assertCurrent;
      request.assertCurrent?.();
      return IDENTITY;
    });
    const { service, environment } = await fixture(resolveIdentity);
    await expect(service.resolveSshIdentity(environment.environmentId)).resolves.toEqual(IDENTITY);
    expect(retained).toBeTypeOf("function");
    expect(() => retained?.()).toThrow("identity invocation is closed");
    await expect(service.resolveSshIdentity(environment.environmentId)).resolves.toEqual(IDENTITY);
    expect(resolveIdentity).toHaveBeenCalledTimes(2);
  });

  it("rejects a late identity and its queued lookup after the lease owner changes", async () => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const resolveIdentity = vi.fn(async () => {
      entered.resolve();
      await release.promise;
      return { kind: "material" as const, contents: "synthetic-worker-key" };
    });
    const { service, environment, lookup } = await fixture(resolveIdentity);
    const first = lookup();
    await entered.promise;
    const second = lookup();
    try {
      await service.attachSession({
        environmentId: environment.environmentId,
        ownerEpoch: environment.ownerEpoch,
        sessionId: "queued-new-owner",
      });
      release.resolve();
      expect(await first).toBeInstanceOf(Error);
      expect(await second).toBeInstanceOf(Error);
      expect(resolveIdentity).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      await Promise.all([first, second]);
    }
  });

  it("closes timed-out identity work before a cooperating resolver's next effect", async () => {
    vi.useFakeTimers();
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const settled = createDeferredCore();
    const effect = vi.fn();
    const { lookup } = await fixture(async (request) => {
      entered.resolve();
      try {
        await release.promise;
        request.assertCurrent?.();
        effect();
        return IDENTITY;
      } finally {
        settled.resolve();
      }
    }, 25);
    const pending = lookup();
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(25);
      expect(await pending).toBeInstanceOf(Error);
    } finally {
      release.resolve();
      await settled.promise;
      await pending;
      vi.useRealTimers();
    }
    expect(effect).not.toHaveBeenCalled();
  });
});
