import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import type { NodeWorkerSupervisorTransport } from "../node-registry-private.js";
import { createGatewayNodeWorkerBundleInstaller } from "./node-worker-bundle-installer.js";
import { createNodeWorkerBundleTransferService } from "./node-worker-bundle-transfer-service.js";
import { createNodeWorkerBundleTestNode } from "./node-worker-bundle.test-support.js";
import { create, providerService } from "./provider-lifecycle.test-support.js";
import * as support from "./service.test-support.js";

function createHeldInstaller(
  boundary: "attachment read" | "discovery" | "installation",
  signal?: AbortSignal,
) {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const pause = async <T>(at: typeof boundary, value: T) => {
    if (boundary === at) {
      entered.resolve();
      await release.promise;
    }
    return value;
  };
  const node = createNodeWorkerBundleTestNode({ workerHost: { bundlePrewarm: 1 } });
  const transfer = createNodeWorkerBundleTransferService();
  const grant = vi.spyOn(transfer, "prepare");
  const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>(async () =>
    pause("installation", { ok: true, payload: support.BOOTSTRAP_RECEIPT }),
  );
  const transport: NodeWorkerSupervisorTransport = {
    getCurrentNode: async () => pause("discovery", node),
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
      async (environmentId) => pause("attachment read", await readAttachment(environmentId)),
    );
  }
  const install = createGatewayNodeWorkerBundleInstaller({
    log: { info: vi.fn(), warn: vi.fn() },
    gatewayNamespace: "gateway-owner-test",
    getTransport: () => transport,
    transfer,
  });
  const service = providerService(
    {
      supportedExecutionModes: ["worker-turn"],
      provisionBeforeInstallation: true,
      provision: async () => ({
        leaseId: "cloud-owner-lease",
        node: { deviceId: node.nodeId },
        sharedHost: false,
      }),
      destroy,
    },
    { ensureNodeWorkerBundle: install },
  );
  const creation = create(service, `held-${boundary}`, {
    executionMode: "worker-turn",
    signal,
  }).catch((error: unknown) => ({ error }));
  return {
    node,
    entered,
    release,
    grant,
    invoke,
    destroy,
    creation,
    async [Symbol.asyncDispose]() {
      release.resolve();
      await creation;
      transfer.closeAll();
    },
  };
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
      const controller = new AbortController();
      await using fixture = createHeldInstaller(boundary, controller.signal);
      const { creation } = fixture;
      await Promise.race([fixture.entered.promise, creation]);
      const { environmentId, state } = support.testState.store.list()[0]!;
      if (change === "cancellation") {
        controller.abort(new DOMException("Provisioning cancelled", "AbortError"));
      } else if (change === "destroy intent") {
        await support.testState.store.requestDestroy({ environmentId, state });
      } else {
        await support.testState.store.transition({
          environmentId,
          from: state,
          to: "ready",
          patch: {
            ...support.readyPatch(environmentId),
            leaseId: "replacement-lease",
            nodeDeviceId: fixture.node.nodeId,
            sharedHost: false,
          },
        });
      }
      const replacement = support.testState.store.get(environmentId);
      fixture.release.resolve();
      expect(await creation).toHaveProperty("error");
      expect(fixture.grant).not.toHaveBeenCalled();
      expect(fixture.invoke).not.toHaveBeenCalled();
      if (change !== "replacement owner") {
        expect(fixture.destroy).toHaveBeenCalledOnce();
        expect(support.testState.store.get(environmentId)?.state).toBe("destroyed");
      } else {
        expect(fixture.destroy).not.toHaveBeenCalled();
        expect(support.testState.store.get(environmentId)).toEqual(replacement);
      }
    },
  );

  it("drains an admitted installation before destroying its lease", async () => {
    await using fixture = createHeldInstaller("installation");
    let settled = false;
    const creation = fixture.creation.finally(() => {
      settled = true;
    });
    await Promise.race([fixture.entered.promise, creation]);
    const { environmentId, state } = support.testState.store.list()[0]!;
    await support.testState.store.requestDestroy({ environmentId, state });
    expect(fixture.destroy).not.toHaveBeenCalled();
    expect(settled).toBe(false);
    fixture.release.resolve();
    expect(await creation).toHaveProperty("error");
    expect(fixture.destroy).toHaveBeenCalledOnce();
    expect(support.testState.store.get(environmentId)?.state).toBe("destroyed");
  });
});
