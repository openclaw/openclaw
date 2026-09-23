import { describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_IDS } from "../../../packages/gateway-protocol/src/client-info.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../../infra/node-runner-inventory.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type {
  NodeWorkerSupervisorNodeProof,
  NodeWorkerSupervisorTransport,
} from "../node-registry-private.js";
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
