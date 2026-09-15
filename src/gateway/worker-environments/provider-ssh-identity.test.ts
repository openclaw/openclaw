import { describe, expect, it, vi } from "vitest";
import type { WorkerSshIdentity, WorkerSshIdentityRequest } from "../../plugins/types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveWorkerSshIdentity } from "./identity.js";
import { createWorkerSshIdentityResolver } from "./provider-ssh-identity.js";
import * as support from "./service.test-support.js";
import { createWorkerTunnelManager } from "./tunnel.js";
import { fakeRunner, success } from "./tunnel.test-support.js";

describe("worker SSH identity invocation authority", () => {
  support.setupWorkerEnvironmentServiceSuite();

  function fixture(
    resolveIdentity: (request: WorkerSshIdentityRequest) => Promise<WorkerSshIdentity>,
    options: { legacy?: boolean; timeoutMs?: number } = {},
  ) {
    const common = {
      resolveSshIdentity: resolveIdentity,
      provision: vi.fn(support.createLegacyProvider().provision),
    };
    const provider = options.legacy
      ? support.createLegacyProvider(common)
      : support.createProvider(common);
    const manager = createWorkerTunnelManager({ runner: fakeRunner(() => success()).runner });
    const service = support.createService(provider, {
      tunnelManager: manager,
      ...(options.timeoutMs ? { providerCallTimeoutMs: options.timeoutMs } : {}),
      resolveSshIdentity: (request) =>
        resolveWorkerSshIdentity({
          ...request,
          resolveGeneric: async () => ({ kind: "path", path: "/keys/generic" }),
        }),
    });
    const environment = support.seedReady("worker-identity");
    return { provider, manager, service, environment };
  }

  it("denies the next identity effect after only its initializing tunnel stops", async () => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const sourceSignal = new AbortController();
    const effect = vi.fn();
    const { manager, service, environment } = fixture(async (request) => {
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
        authorize: () => sourceSignal.signal.throwIfAborted(),
      })
      .catch((error: unknown) => error);
    await entered.promise;
    const stopping = manager.stop(environment.environmentId, environment.ownerEpoch);
    expect(service.get(environment.environmentId)?.ownerEpoch).toBe(environment.ownerEpoch);
    release.resolve();
    await stopping;
    expect(await starting).toBeInstanceOf(Error);
    expect(sourceSignal.signal.aborted).toBe(false);
    expect(effect).not.toHaveBeenCalled();
  });

  it("refuses queued identity effects after their caller closes", async () => {
    const queued = createDeferredCore();
    const release = createDeferredCore();
    let current = true;
    const effect = vi.fn();
    const environment = support.seedReady("worker-queued-identity");
    if (!environment.leaseId) {
      throw new Error("fixture needs a lease");
    }
    const identityFor = createWorkerSshIdentityResolver({
      requireCurrentOwner: (record) => record,
      isStopping: () => false,
      callProvider: async <T>(_environmentId: string, operation: () => Promise<T>) => {
        queued.resolve();
        await release.promise;
        return await operation();
      },
      requireWorkerProfile: () => ({}),
      resolveSshIdentity: async ({ assertAuthorized }) => {
        assertAuthorized();
        effect();
        return { kind: "path", path: "/keys/queued" };
      },
    });
    const resolve = identityFor(environment, support.createProvider(), environment.leaseId);
    const pending = resolve(support.SSH_ENDPOINT.keyRef, {
      assertCurrent: () => {
        if (!current) {
          throw new Error("initializing owner closed");
        }
      },
    }).catch((error: unknown) => error);
    await queued.promise;
    current = false;
    release.resolve();
    expect(await pending).toBeInstanceOf(Error);
    expect(effect).not.toHaveBeenCalled();
  });

  it("closes a retained assertion after successful identity resolution", async () => {
    let retained: (() => void) | undefined;
    const { service, environment } = fixture(async (request) => {
      retained = request.assertCurrent;
      retained?.();
      return { kind: "path", path: "/keys/worker" };
    });
    await service.startTunnel({
      environmentId: environment.environmentId,
      ownerEpoch: environment.ownerEpoch,
      authorize: () => {},
    });
    expect(retained).toBeTypeOf("function");
    expect(() => retained?.()).toThrow();
  });

  it("closes timed-out identity work before its next effect without aborting the source", async () => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const effect = vi.fn();
    const settled = createDeferredCore();
    const sourceSignal = new AbortController();
    const { service, environment } = fixture(
      async (request) => {
        entered.resolve();
        try {
          await release.promise;
          request.assertCurrent?.();
          effect();
          return { kind: "path", path: "/keys/worker" };
        } finally {
          settled.resolve();
        }
      },
      { timeoutMs: 25 },
    );
    const starting = service
      .startTunnel({
        environmentId: environment.environmentId,
        ownerEpoch: environment.ownerEpoch,
        authorize: () => sourceSignal.signal.throwIfAborted(),
      })
      .catch((error: unknown) => error);
    await entered.promise;
    try {
      expect(await starting).toBeInstanceOf(Error);
    } finally {
      release.resolve();
      await settled.promise;
    }
    expect(sourceSignal.signal.aborted).toBe(false);
    expect(effect).not.toHaveBeenCalled();
  });

  it("restores an accepted legacy allocation under the child's own authority without provisioning", async () => {
    const resolveIdentity = vi.fn(async (request: WorkerSshIdentityRequest) => {
      request.assertCurrent?.();
      return { kind: "path" as const, path: "/keys/legacy" };
    });
    const { provider, service, environment } = fixture(resolveIdentity, { legacy: true });
    const child = await service.attachSession({
      environmentId: environment.environmentId,
      ownerEpoch: environment.ownerEpoch,
      sessionId: "accepted-child",
    });
    const currentChild = () => {
      if (service.get(environment.environmentId)?.ownerEpoch !== child.ownerEpoch) {
        throw new Error("child owner changed");
      }
    };
    const request = {
      environmentId: environment.environmentId,
      ownerEpoch: child.ownerEpoch,
      authorize: currentChild,
    };
    await service.startTunnel(request);
    await service.stopTunnel(environment.environmentId, child.ownerEpoch);
    await service.startTunnel(request);
    expect(resolveIdentity).toHaveBeenCalledTimes(2);
    expect(provider.provision).not.toHaveBeenCalled();
    await service.stopTunnel(environment.environmentId, child.ownerEpoch);
  });
});
