import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createWorkerEnvironmentTransportLifecycle } from "./environment-access.js";
import { createNodeWorkerTunnelManager } from "./node-worker-tunnel.js";
import * as nodeTunnelSupport from "./node-worker-tunnel.test-support.js";
import { providerService } from "./provider-lifecycle.test-support.js";
import * as support from "./service.test-support.js";

const retiredOwner = { state: "failed", attachedSessionIds: [], leaseId: null, nodeDeviceId: null };

async function attachedNode(
  environmentId: string,
  sharedHost: boolean | null = false,
  sessionId = "session-destroyed",
) {
  await support.seedReadyNodeDesktop(environmentId);
  return support.testState.store.transition({
    environmentId,
    from: "ready",
    to: "attached",
    patch: {
      ...support.attachedPatch(environmentId, sessionId),
      ...(sharedHost === null ? {} : { sharedHost }),
    },
  });
}

function nodeService(
  nodeTunnelManager: ReturnType<typeof createNodeWorkerTunnelManager>,
  overrides: Parameters<typeof support.createProvider>[0] = {},
) {
  return providerService(
    { supportedExecutionModes: ["worker-turn", "remote-exec"], ...overrides },
    { nodeTunnelManager },
  );
}

async function disconnectedNodeOwner(environmentId: string, sharedHost: boolean | null = false) {
  const deviceId = `node:${environmentId}`;
  const attached = await attachedNode(environmentId, sharedHost);
  const transport = nodeTunnelSupport.transport();
  const connectedNodes = await transport.listCurrentNodes();
  for (const node of connectedNodes) {
    node.nodeId = deviceId;
  }
  const listNodes = vi.fn<typeof transport.listCurrentNodes>(async () => []);
  transport.listCurrentNodes = listNodes;
  const workspaceTransfer = nodeTunnelSupport.workspaceTransfer();
  workspaceTransfer.closeAll = vi.fn(async () => {});
  const nodeTunnels = createNodeWorkerTunnelManager({
    gatewayDeviceId: "gateway-1",
    getEnvironment: (id) => support.testState.store.get(id),
    listEnvironments: () => support.testState.store.list(),
    getTransport: () => transport,
    launchNodeWorker: vi.fn(),
    validateWorkerTurn: () => false,
    workspaceTransfer,
  });
  return {
    attached,
    nodeTunnels,
    listNodes,
    workspaceTransfer,
    start: () =>
      nodeTunnels.start({
        environmentId,
        ownerEpoch: attached.ownerEpoch,
        deviceId,
        sessionId: "session-destroyed",
        executionMode: "worker-turn",
        expectedBuild: support.BOOTSTRAP_RECEIPT,
      }),
    reconnect: () => listNodes.mockResolvedValue(connectedNodes),
  };
}

describe("worker provider node teardown", () => {
  support.setupWorkerEnvironmentServiceSuite();

  // Unknown (null) hosts take the same non-dedicated path; transition patches cannot express null.
  it("rejects stalled computer cleanup on a shared host despite a provider stop reason", async () => {
    const environmentId = "shared-wedged-desktop";
    const record = await attachedNode(environmentId, true, "session-1");
    const driverFinished = createDeferred();
    const warn = vi.fn();
    const transports = createWorkerEnvironmentTransportLifecycle({
      store: support.testState.store,
      nodeTunnelManager: { stop: async () => {} },
      closeEnvironmentComputers: () => driverFinished.promise,
      logger: { warn },
    });
    if (!transports) {
      throw new Error("Expected worker transport lifecycle");
    }
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stopped = transports
      .stop(environmentId, record.ownerEpoch, "provider-destroying")
      .catch((error: unknown) => error);
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await stopped).toMatchObject({
        message: "Worker computer cleanup timed out after 60000ms",
      });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      driverFinished.resolve();
      vi.useRealTimers();
      await stopped;
    }
  });

  it.each(["stop", "force"] as const)(
    "continues %s after a computer driver never settles",
    async (entrance) => {
      const environmentId = "wedged-desktop";
      await attachedNode(environmentId, false, "session-1");
      const cleanupStarted = createDeferred();
      const finalCleanupStarted = createDeferred();
      const driverFinished = createDeferred();
      const destroy = vi.fn(async () => {});
      const warn = vi.fn();
      let cleanupCalls = 0;
      const service = providerService(
        { destroy },
        {
          // The driver ignores cancellation and only settles when finally releases it.
          closeEnvironmentComputers: () => {
            cleanupCalls += 1;
            (cleanupCalls === 1 ? cleanupStarted : finalCleanupStarted).resolve();
            return driverFinished.promise;
          },
          logger: { warn },
          nodeTunnelManager: {
            status: () => "stopped",
            start: vi.fn(),
            stop: async () => {},
            stopAll: async () => {},
            observeProcesses: vi.fn(),
          },
        },
      );
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const forceAbandon = vi.fn(async () => {});
      const stopping = service.destroy(
        environmentId,
        undefined,
        entrance === "force" ? forceAbandon : undefined,
      );
      try {
        await cleanupStarted.promise;
        await vi.advanceTimersByTimeAsync(60_000);
        expect(destroy).toHaveBeenCalledOnce();
        await finalCleanupStarted.promise;
        await vi.advanceTimersByTimeAsync(60_000);
        await expect(stopping).resolves.toMatchObject({ state: "destroyed" });
        expect(warn).toHaveBeenCalledWith(
          expect.stringMatching(
            /computer cleanup.*wedged-desktop.*continuing provider teardown.*retry Stop/i,
          ),
        );
        expect(support.testState.store.getCredential(environmentId)).toBeUndefined();
        if (entrance === "force") {
          expect(forceAbandon).toHaveBeenCalledOnce();
        }
      } finally {
        driverFinished.resolve();
        vi.useRealTimers();
        await stopping;
      }
    },
  );

  it.each(["retained", "restarted"] as const)(
    "cleans the %s node owner after the provider proves the machine is destroyed",
    async (owner) => {
      const environmentId = `worker-destroyed-node-${owner}`;
      const { attached, nodeTunnels, listNodes, workspaceTransfer, start, reconnect } =
        await disconnectedNodeOwner(environmentId);
      const service = nodeService(nodeTunnels, { inspect: async () => ({ status: "destroyed" }) });
      try {
        if (owner === "retained") {
          await start();
          await expect(nodeTunnels.stop(environmentId, attached.ownerEpoch)).rejects.toThrow(
            "not connected",
          );
        }
        listNodes.mockClear();
        vi.mocked(workspaceTransfer.close).mockClear();

        await service.reconcileOnce();

        expect(support.testState.store.get(environmentId)).toMatchObject({
          ...retiredOwner,
          lastError: "Worker environment disappeared before teardown was requested",
        });
        await nodeTunnels.stopAll();
        expect(listNodes).not.toHaveBeenCalled();
        expect(workspaceTransfer.close).toHaveBeenCalledWith(environmentId);
      } finally {
        reconnect();
      }
    },
  );

  it.each(["destroy", "reconcile"] as const)(
    "destroys a disconnected dedicated lease without losing retry ownership via %s",
    async (retry) => {
      const environmentId = "worker-offline-destroy";
      const { attached, nodeTunnels, listNodes, start, reconnect } =
        await disconnectedNodeOwner(environmentId);
      const destroy = vi
        .fn(async () => {})
        .mockRejectedValueOnce(new Error("provider destruction is indeterminate"));
      const service = nodeService(nodeTunnels, {
        inspect: async () => ({ status: "unknown" }),
        destroy,
      });
      try {
        const credential = support.testState.store.getCredential(environmentId);
        await expect(
          service.destroy(environmentId, {
            sessionId: "session-destroyed",
            ownerEpoch: attached.ownerEpoch,
          }),
        ).rejects.toThrow("owner changed before retirement");
        expect(support.testState.store.get(environmentId)).toEqual(attached);
        expect(support.testState.store.getCredential(environmentId)).toEqual(credential);
        expect(destroy).not.toHaveBeenCalled();
        await start();
        await expect(service.requestDestroy(environmentId)).rejects.toMatchObject({
          code: "provider_failure",
        });
        expect(nodeTunnels.status(environmentId)).toBe("stopped");
        expect(support.testState.store.get(environmentId)).toMatchObject({
          state: "attached",
          ownerEpoch: attached.ownerEpoch,
          attachedSessionIds: ["session-destroyed"],
          destroyRequestedAtMs: support.testState.nowMs,
        });
        expect(support.testState.store.getCredential(environmentId)).toBeUndefined();

        const pending = support.testState.store.get(environmentId);
        await expect(service.requestDestroy(environmentId)).rejects.toThrow(
          "provider destruction is indeterminate",
        );
        expect(support.testState.store.get(environmentId)).toEqual(pending);
        expect(destroy).toHaveBeenCalledOnce();

        if (retry === "destroy") {
          await service.destroy(environmentId);
        } else {
          await service.reconcileOnce();
        }
        expect(support.testState.store.get(environmentId)?.state).toBe("destroyed");
        expect(destroy).toHaveBeenCalledTimes(2);
        await nodeTunnels.stopAll();
        expect(listNodes).not.toHaveBeenCalled();
      } finally {
        reconnect();
      }
    },
  );

  it.each([
    [true, true],
    [true, false],
    [null, true],
    [null, false],
  ] as const)(
    "requires confirmed worker stop before retiring a disconnected lease (%s, provider=%s)",
    async (sharedHost, providersEnabled) => {
      const environmentId = "worker-offline-shared-destroy";
      const { nodeTunnels, reconnect } = await disconnectedNodeOwner(environmentId, sharedHost);
      const destroy = vi.fn(async () => {});
      const service = nodeService(nodeTunnels, { destroy });
      support.testState.providersEnabled = providersEnabled;
      try {
        await expect(service.destroy(environmentId)).rejects.toThrow("not connected");
        expect(destroy).not.toHaveBeenCalled();
        expect(support.testState.store.get(environmentId)?.state).toBe("attached");
        expect(support.testState.store.getCredential(environmentId)).toBeUndefined();
      } finally {
        reconnect();
      }
    },
  );

  it.each([
    ["destroyed", true],
    ["destroyed", null],
    ["unknown", true],
    ["unknown", null],
  ] as const)(
    "requires exact worker stop for a %s lease with sharedHost=%s",
    async (status, sharedHost) => {
      const environmentId = "worker-inspected-destroyed-shared";
      const { attached, nodeTunnels, start, reconnect } = await disconnectedNodeOwner(
        environmentId,
        sharedHost,
      );
      const destroy = vi.fn(async () => {});
      const lastError =
        status === "unknown"
          ? "Worker provider no longer recognizes the lease"
          : "Worker environment disappeared before teardown was requested";
      const service = nodeService(nodeTunnels, { inspect: async () => ({ status }), destroy });
      try {
        await start();
        await service.reconcileOnce();

        expect(support.testState.store.get(environmentId)).toMatchObject({
          state: "attached",
          ownerEpoch: attached.ownerEpoch,
          attachedSessionIds: ["session-destroyed"],
          nodeDeviceId: attached.nodeDeviceId,
          leaseId: attached.leaseId,
          destroyRequestedAtMs: support.testState.nowMs,
          teardownTerminalState: "failed",
          lastError,
        });
        expect(support.testState.store.getCredential(environmentId)).toBeUndefined();
        expect(destroy).not.toHaveBeenCalled();

        reconnect();
        await service.reconcileOnce();

        expect(support.testState.store.get(environmentId)).toMatchObject({
          ...retiredOwner,
          lastError,
        });
        expect(destroy).toHaveBeenCalledTimes(status === "unknown" ? 1 : 0);
      } finally {
        reconnect();
      }
    },
  );
});
