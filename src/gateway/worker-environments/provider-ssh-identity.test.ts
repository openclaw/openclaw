import { describe, expect, it, vi } from "vitest";
import type { WorkerSshIdentity, WorkerSshIdentityRequest } from "../../plugins/types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveWorkerSshIdentity } from "./identity.js";
import * as support from "./service.test-support.js";
import { createWorkerTunnelManager } from "./tunnel.js";
import { fakeRunner, success } from "./tunnel.test-support.js";

type ObservedIdentityRequest = WorkerSshIdentityRequest & { assertCurrent?: () => void };

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
    return { provider, manager, service, environment };
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
      return { kind: "path", path: "/keys/worker" };
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
      return { kind: "path" as const, path: "/keys/worker" };
    });
    const { service, environment } = await fixture(resolveIdentity);
    await expect(service.resolveSshIdentity(environment.environmentId)).resolves.toEqual({
      kind: "path",
      path: "/keys/worker",
    });
    expect(retained).toBeTypeOf("function");
    expect(() => retained?.()).toThrow("identity invocation is closed");
    await expect(service.resolveSshIdentity(environment.environmentId)).resolves.toEqual({
      kind: "path",
      path: "/keys/worker",
    });
    expect(resolveIdentity).toHaveBeenCalledTimes(2);
  });

  it("rejects a direct legacy identity result after the exact lease owner changes", async () => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const { service, environment } = await fixture(async () => {
      entered.resolve();
      await release.promise;
      return { kind: "material", contents: "synthetic-worker-key" };
    });
    const lookup = service
      .resolveSshIdentity(environment.environmentId)
      .catch((error: unknown) => error);
    try {
      await entered.promise;
      await service.attachSession({
        environmentId: environment.environmentId,
        ownerEpoch: environment.ownerEpoch,
        sessionId: "new-owner",
      });
      release.resolve();
      expect(await lookup).toBeInstanceOf(Error);
    } finally {
      release.resolve();
      await lookup;
    }
  });

  it("does not enter a queued resolver after its lease owner changes", async () => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const resolveIdentity = vi.fn(async () => {
      entered.resolve();
      await release.promise;
      return { kind: "path" as const, path: "/keys/worker" };
    });
    const { service, environment } = await fixture(resolveIdentity);
    const first = service
      .resolveSshIdentity(environment.environmentId)
      .catch((error: unknown) => error);
    await entered.promise;
    const second = service
      .resolveSshIdentity(environment.environmentId)
      .catch((error: unknown) => error);
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
    const { service, environment } = await fixture(async (request) => {
      entered.resolve();
      try {
        await release.promise;
        request.assertCurrent?.();
        effect();
        return { kind: "path", path: "/keys/worker" };
      } finally {
        settled.resolve();
      }
    }, 25);
    const lookup = service
      .resolveSshIdentity(environment.environmentId)
      .catch((error: unknown) => error);
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(25);
      expect(await lookup).toBeInstanceOf(Error);
    } finally {
      release.resolve();
      await settled.promise;
      await lookup;
      vi.useRealTimers();
    }
    expect(effect).not.toHaveBeenCalled();
  });
});
