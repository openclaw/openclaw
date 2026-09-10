import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { REQUEST, seedActivePlacement } from "./placement-dispatch-test-fixtures.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import * as support from "./service.test-support.js";
import { createWorkerTunnelManager } from "./tunnel.js";

describe("worker environment runtime upgrades", () => {
  support.setupWorkerEnvironmentServiceSuite();

  const currentReceipt = {
    ...support.BOOTSTRAP_RECEIPT,
    bundleHash: "b".repeat(64),
    openclawVersion: "2026.7.3",
  };

  function setupUpgrade(
    transport: "node" | "ssh",
    state: "ready" | "idle" | "attached" = "attached",
  ) {
    const environmentId = "worker-runtime-upgrade";
    const ready =
      transport === "node"
        ? support.seedReadyNodeDesktop(environmentId)
        : support.seedReadyDesktop(environmentId);
    const environment =
      state === "ready"
        ? ready
        : support.testState.store.transition({
            environmentId,
            from: "ready",
            to: state,
            ...(state === "attached"
              ? { patch: support.attachedPatch(environmentId, REQUEST.sessionId) }
              : {}),
          });
    const placements = createWorkerSessionPlacementStore({
      database: support.testState.stateDb,
      now: () => support.testState.nowMs,
    });
    const placement =
      state === "attached"
        ? seedActivePlacement(placements, {
            environmentId,
            ownerEpoch: environment.ownerEpoch,
            executionMode: transport === "node" ? "worker-turn" : "remote-exec",
          })
        : undefined;
    const oldCredential = support.testState.store.getCredential(environmentId)!;
    const events: string[] = [];
    const tunnelManager = createWorkerTunnelManager();
    const stop = vi.spyOn(tunnelManager, "stop").mockImplementation(async () => {
      expect(support.testState.store.getCredential(environmentId)).toBeUndefined();
      events.push("stopped");
    });
    const install = vi.fn(async () => {
      expect(events.at(-1)).toBe("stopped");
      expect(support.testState.store.getCredential(environmentId)).toBeUndefined();
      events.push("installed");
      return currentReceipt;
    });
    support.testState.prepareInstallation = vi.fn(async () => ({
      ...support.BUNDLE_ARTIFACT,
      ...currentReceipt,
    }));
    support.testState.bootstrapWorker = vi.fn(async ({ installation, sshEndpoint }) => {
      expect(installation.bundleHash).toBe(currentReceipt.bundleHash);
      expect(sshEndpoint).toEqual(environment.sshEndpoint);
      return install();
    });
    const provision = vi.fn(support.createProvider().provision);
    const destroy = vi.fn(async () => {});
    const ensureNodeWorkerBundle = vi.fn(
      async (
        params: Parameters<
          NonNullable<support.WorkerEnvironmentServiceOptions["ensureNodeWorkerBundle"]>
        >[0],
      ) => {
        expect(params.deviceId).toBe(environment.nodeDeviceId);
        expect(params.artifact.bundleHash).toBe(currentReceipt.bundleHash);
        params.assertCurrent?.();
        return install();
      },
    );
    const service = support.createService(support.createProvider({ provision, destroy }), {
      tunnelManager,
      placementStore: createWorkerSessionPlacementGate(placements),
      ensureNodeWorkerBundle,
    });
    return {
      environment,
      placement,
      placements,
      oldCredential,
      events,
      stop,
      install,
      provision,
      destroy,
      ensureNodeWorkerBundle,
      service,
    };
  }

  it.each([
    ["node", "attached"],
    ["ssh", "attached"],
    ["node", "ready"],
    ["node", "idle"],
  ] as const)(
    "upgrades the %s %s runtime while retaining its machine and workspace",
    async (transport, state) => {
      const h = setupUpgrade(transport, state);
      await h.service.reconcileOnce();
      expect(h.events).toEqual(["stopped", "installed"]);
      expect(h.stop).toHaveBeenCalledWith(h.environment.environmentId, h.environment.ownerEpoch);
      expect(h.provision).not.toHaveBeenCalled();
      expect(h.destroy).not.toHaveBeenCalled();
      expect(support.testState.store.get(h.environment.environmentId)).toMatchObject({
        state,
        leaseId: h.environment.leaseId,
        ownerEpoch: h.environment.ownerEpoch,
        nodeDeviceId: h.environment.nodeDeviceId,
        desktop: h.environment.desktop,
        attachedSessionIds: h.environment.attachedSessionIds,
        bootstrapReceipt: { ...currentReceipt, installKind: "bundle" },
        destroyRequestedAtMs: null,
      });
      if (h.placement) {
        expect(h.placements.get(h.placement.sessionId)).toEqual({
          ...h.placement,
          workerBundleHash: currentReceipt.bundleHash,
        });
      }
      expect(support.testState.store.getCredential(h.environment.environmentId)).toMatchObject({
        bundleHash: currentReceipt.bundleHash,
        ownerEpoch: h.environment.ownerEpoch,
        sessionId: state === "attached" ? REQUEST.sessionId : null,
      });
      expect(
        support.testState.store.getCredential(h.environment.environmentId)?.credentialHash,
      ).not.toBe(h.oldCredential.credentialHash);
      expect(
        transport === "node" ? h.ensureNodeWorkerBundle : support.testState.bootstrapWorker,
      ).toHaveBeenCalledOnce();
    },
  );

  it.each(["node", "ssh"] as const)(
    "retains the %s machine after an interrupted install and retries its runtime",
    async (transport) => {
      const h = setupUpgrade(transport);
      h.install.mockRejectedValueOnce(new Error("runtime download interrupted"));
      await h.service.reconcileOnce();
      expect(support.testState.store.get(h.environment.environmentId)).toMatchObject({
        state: "attached",
        leaseId: h.environment.leaseId,
        ownerEpoch: h.environment.ownerEpoch,
        bootstrapReceipt: h.environment.bootstrapReceipt,
        destroyRequestedAtMs: null,
        lastError: "runtime download interrupted",
      });
      expect(support.testState.store.getCredential(h.environment.environmentId)).toBeUndefined();
      expect(h.placements.get(REQUEST.sessionId)).toEqual(h.placement);
      await expect(
        h.service.startTunnel({
          environmentId: h.environment.environmentId,
          ownerEpoch: h.environment.ownerEpoch,
        }),
      ).rejects.toThrow(
        "Cloud worker runtime update is pending; recovery will retry when the worker is available: runtime download interrupted",
      );
      await h.service.reconcileOnce();
      expect(
        support.testState.store.get(h.environment.environmentId)?.bootstrapReceipt?.bundleHash,
      ).toBe(currentReceipt.bundleHash);
      expect(h.placements.get(REQUEST.sessionId)?.workerBundleHash).toBe(currentReceipt.bundleHash);
      expect(h.provision).not.toHaveBeenCalled();
      expect(h.destroy).not.toHaveBeenCalled();
    },
  );

  it.each(["shutdown", "destroy", "move", "live turn"] as const)(
    "rejects a finished installation after %s closes its authority",
    async (race) => {
      const h = setupUpgrade("node");
      const started = createDeferred();
      const installed = createDeferred<typeof currentReceipt>();
      h.install.mockImplementationOnce(async () => {
        started.resolve();
        return installed.promise;
      });
      const recovery = h.service.reconcileOnce();
      await started.promise;
      let stopping: Promise<void> | undefined;
      if (race === "shutdown") {
        stopping = h.service.stop();
      } else if (race === "destroy") {
        support.testState.store.requestDestroy({
          environmentId: h.environment.environmentId,
          state: "attached",
        });
      } else if (race === "move") {
        h.placements.beginPlacementMove({
          sessionId: REQUEST.sessionId,
          source: {
            generation: h.placement!.generation,
            environmentId: h.environment.environmentId,
            ownerEpoch: h.environment.ownerEpoch,
          },
          target: { kind: "gateway" },
        });
      } else {
        h.placements.claimTurn({
          ...REQUEST,
          claimId: "new-live-claim",
          runId: "new-live-run",
          owner: {
            kind: "worker",
            environmentId: h.environment.environmentId,
            ownerEpoch: h.environment.ownerEpoch,
          },
        });
      }
      installed.resolve(currentReceipt);
      await recovery;
      await stopping;
      expect(support.testState.store.get(h.environment.environmentId)?.bootstrapReceipt).toEqual(
        h.environment.bootstrapReceipt,
      );
      expect(h.placements.get(REQUEST.sessionId)?.workerBundleHash).toBe(
        h.placement!.workerBundleHash,
      );
      expect(support.testState.store.getCredential(h.environment.environmentId)).toBeUndefined();
      expect(h.provision).not.toHaveBeenCalled();
      expect(h.destroy).not.toHaveBeenCalled();
    },
  );
});
