import { describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_IDS } from "../../../packages/gateway-protocol/src/client-info.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../../infra/node-runner-inventory.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type {
  NodeWorkerSupervisorNodeProof,
  NodeWorkerSupervisorTransport,
} from "../node-registry-private.js";
import { createNodeRegistryRuntime, updateNodeRunnerInventory } from "../node-registry-private.js";
import { NodeRegistry } from "../node-registry.js";
import { createWorkerSupervisorNodeClient } from "../server-methods/nodes.runner-inventory.test-support.js";
import { createGatewayNodeWorkerBundleInstaller } from "./node-worker-bundle-installer.js";
import { createNodeWorkerBundleTransferService } from "./node-worker-bundle-transfer-service.js";
import * as support from "./service.test-support.js";

function createHeldInstaller(boundary: "attachment read" | "discovery" | "installation") {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const node: NodeWorkerSupervisorNodeProof = {
    nodeId: "cloud-owner-node",
    connId: "owner-connection",
    pairingIdentity: "owner-pairing",
    pairingGeneration: "owner-generation",
    clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
    clientMode: "node",
    protocolFeature: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
    workerHost: { enabled: true, capacity: { total: 1, available: 1 }, bundlePrewarm: 1 },
    commands: [],
  };
  const transfer = createNodeWorkerBundleTransferService();
  const grant = vi.spyOn(transfer, "prepare");
  const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>(async () => {
    if (boundary === "installation") {
      entered.resolve();
      await release.promise;
    }
    return { ok: true, payload: support.BOOTSTRAP_RECEIPT };
  });
  const transport: NodeWorkerSupervisorTransport = {
    getCurrentNode: async () => {
      if (boundary === "discovery") {
        entered.resolve();
        await release.promise;
      }
      return node;
    },
    hasCurrentRunner: () => true,
    listCurrentNodes: async () => [node],
    isCurrent: (candidate) => candidate === node,
    invoke,
  };
  const destroy = vi.fn(async () => {});
  if (boundary === "attachment read") {
    const readAttachment = support.testState.store.hasSessionAttachment.bind(
      support.testState.store,
    );
    vi.spyOn(support.testState.store, "hasSessionAttachment").mockImplementation(
      async (environmentId) => {
        const attached = await readAttachment(environmentId);
        entered.resolve();
        await release.promise;
        return attached;
      },
    );
  }
  const install = vi.fn(
    createGatewayNodeWorkerBundleInstaller({
      log: { info: vi.fn(), warn: vi.fn() },
      gatewayNamespace: "gateway-owner-test",
      getTransport: () => transport,
      transfer,
    }),
  );
  const service = support.createService(
    support.createProvider({
      supportedExecutionModes: ["worker-turn"],
      provisionBeforeInstallation: true,
      provision: async () => ({
        leaseId: "cloud-owner-lease",
        node: { deviceId: node.nodeId },
        sharedHost: false,
      }),
      destroy,
    }),
    {
      ensureNodeWorkerBundle: install,
    },
  );
  return { node, service, entered, release, transfer, grant, invoke, install, destroy };
}

describe("node provisioning installer ownership", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it.each(["reconnect", "cancelled", "owner changed", "revoked", "incompatible"] as const)(
    "uses current enrollment and installer ownership after disconnect: %s",
    async (scenario) => {
      let pairing: { identity: string; generation: string } | undefined = {
        identity: "enrolled-device-key",
        generation: "enrolled-device-generation",
      };
      const { nodeRegistry, nodeWorkerSupervisorTransport: transport } = createNodeRegistryRuntime(
        () =>
          new NodeRegistry({
            resolveCurrentPairingState: async () => pairing,
            isPairingStateCurrent: (_nodeId, expected) =>
              pairing?.identity === expected.identity &&
              pairing?.generation === expected.generation,
          }),
      );
      const connect = (connId: string) => {
        nodeRegistry.register(createWorkerSupervisorNodeClient(connId), {
          pairingIdentity: "enrolled-device-key",
          pairingGeneration: "enrolled-device-generation",
        });
        updateNodeRunnerInventory({
          registry: nodeRegistry,
          nodeId: "node-1",
          connId,
          declaration:
            scenario === "incompatible" && connId === "fresh-connection"
              ? { protocolFeatures: ["node-worker-supervisor-v5"] }
              : {
                  protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
                  workerHost: { enabled: true, capacity: { total: 1, available: 1 } },
                },
        });
      };
      const transfer = createNodeWorkerBundleTransferService();
      const grants = vi.spyOn(transfer, "prepare");
      const discovery = createDeferredCore();
      const read = transport.getCurrentNode.bind(transport);
      vi.spyOn(transport, "getCurrentNode").mockImplementation((...args) => {
        discovery.resolve();
        return read(...args);
      });
      const invoke = vi.spyOn(transport, "invoke").mockImplementation(async ({ node, params }) => {
        expect(node.connId).toBe("fresh-connection");
        expect(transport.isCurrent(node)).toBe(true);
        expect(params).toHaveProperty("archive.token");
        return { ok: true, payload: support.BOOTSTRAP_RECEIPT };
      });
      const service = support.createService(
        support.createProvider({
          supportedExecutionModes: ["worker-turn"],
          provisionBeforeInstallation: true,
          provision: async () => {
            connect("enrolled-connection");
            expect(await read("node-1")).toMatchObject({
              connId: "enrolled-connection",
            });
            nodeRegistry.unregister("enrolled-connection");
            return {
              leaseId: "enrolled-device-lease",
              node: { deviceId: "node-1" },
              sharedHost: false,
            };
          },
        }),
        {
          ensureNodeWorkerBundle: createGatewayNodeWorkerBundleInstaller({
            gatewayNamespace: "enrolled-reconnect-test",
            getTransport: () => transport,
            transfer,
            log: { info: vi.fn(), warn: vi.fn() },
          }),
        },
      );
      const controller = new AbortController();
      const creation = service
        .createWithRequest({
          profileId: "development",
          idempotencyKey: "enrolled-reconnect",
          executionMode: "worker-turn",
          signal: controller.signal,
        })
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
      try {
        await discovery.promise;
        expect(grants).not.toHaveBeenCalled();
        if (scenario === "cancelled") {
          controller.abort(new Error("Request stopped while reconnecting"));
        }
        if (scenario === "owner changed") {
          const record = support.testState.store.list()[0]!;
          await support.testState.store.transition({
            environmentId: record.environmentId,
            from: record.state,
            to: "ready",
            patch: {
              ...support.readyPatch(record.environmentId),
              leaseId: "replacement-lease",
              nodeDeviceId: "node-1",
              sharedHost: false,
            },
          });
        }
        if (scenario === "revoked") {
          pairing = undefined;
        }
        connect("fresh-connection");
        if (scenario === "revoked") {
          expect(await read("node-1")).toBeUndefined();
          expect(grants).not.toHaveBeenCalled();
          controller.abort(new Error("Join the refused revoked-device wait"));
        }
        if (scenario === "reconnect") {
          expect(await creation).toMatchObject({ value: { state: "ready" } });
          expect(grants).toHaveBeenCalledOnce();
          expect(invoke).toHaveBeenCalledOnce();
        } else {
          expect(await creation).toHaveProperty("error");
          expect(grants).not.toHaveBeenCalled();
          expect(invoke).not.toHaveBeenCalled();
        }
      } finally {
        await creation;
        transfer.closeAll();
      }
    },
  );

  it.each([
    { boundary: "discovery", change: "destroy intent" },
    { boundary: "discovery", change: "replacement owner" },
    { boundary: "attachment read", change: "destroy intent" },
    { boundary: "attachment read", change: "replacement owner" },
    { boundary: "attachment read", change: "cancellation" },
  ] as const)(
    "refuses installation after $change during $boundary",
    async ({ boundary, change }) => {
      const fixture = createHeldInstaller(boundary);
      const controller = new AbortController();
      const creation = fixture.service
        .createWithRequest({
          profileId: "development",
          idempotencyKey: "held-discovery",
          executionMode: "worker-turn",
          signal: controller.signal,
        })
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
      try {
        await Promise.race([fixture.entered.promise, creation]);
        const record = support.testState.store.list()[0]!;
        expect(record.state).toBe("provisioning");
        if (change === "cancellation") {
          controller.abort(new DOMException("Provisioning cancelled", "AbortError"));
        } else if (change === "destroy intent") {
          await support.testState.store.requestDestroy({
            environmentId: record.environmentId,
            state: record.state,
          });
        } else {
          await support.testState.store.transition({
            environmentId: record.environmentId,
            from: record.state,
            to: "ready",
            patch: {
              ...support.readyPatch(record.environmentId),
              leaseId: "replacement-lease",
              nodeDeviceId: fixture.node.nodeId,
              sharedHost: false,
            },
          });
        }
        const replacement = support.testState.store.get(record.environmentId);
        expect(controller.signal.aborted).toBe(change === "cancellation");
        fixture.release.resolve();
        expect(await creation).toHaveProperty("error");
        expect(fixture.grant).not.toHaveBeenCalled();
        expect(fixture.invoke).not.toHaveBeenCalled();
        if (boundary === "attachment read") {
          expect(fixture.install).not.toHaveBeenCalled();
        }
        if (change !== "replacement owner") {
          expect(fixture.destroy).toHaveBeenCalledOnce();
          expect(support.testState.store.get(record.environmentId)?.state).toBe("destroyed");
        } else {
          expect(fixture.destroy).not.toHaveBeenCalled();
          expect(support.testState.store.get(record.environmentId)).toEqual(replacement);
        }
      } finally {
        fixture.release.resolve();
        await creation;
        fixture.transfer.closeAll();
      }
    },
  );

  it("drains an admitted installation before destroying its lease", async () => {
    const fixture = createHeldInstaller("installation");
    let settled = false;
    const creation = fixture.service
      .createWithRequest({
        profileId: "development",
        idempotencyKey: "held-installation",
        executionMode: "worker-turn",
      })
      .then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      )
      .finally(() => {
        settled = true;
      });
    try {
      await Promise.race([fixture.entered.promise, creation]);
      const record = support.testState.store.list()[0]!;
      await support.testState.store.requestDestroy({
        environmentId: record.environmentId,
        state: record.state,
      });
      expect(fixture.grant).toHaveBeenCalledOnce();
      expect(fixture.invoke).toHaveBeenCalledOnce();
      expect(fixture.destroy).not.toHaveBeenCalled();
      expect(settled).toBe(false);
      fixture.release.resolve();
      expect(await creation).toHaveProperty("error");
      expect(fixture.destroy).toHaveBeenCalledOnce();
      expect(support.testState.store.get(record.environmentId)?.state).toBe("destroyed");
    } finally {
      fixture.release.resolve();
      await creation;
      fixture.transfer.closeAll();
    }
  });
});
