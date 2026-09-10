import { describe, expect, it, vi } from "vitest";
import { WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { installWorkerPlacementReconcileGuard } from "../server-worker-placement-reconcile-guard.js";
import { coordinateWorkerPlacementDispatch } from "./placement-dispatch-coordinator.js";
import { MANIFEST_REF, REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createRecoveryService } from "./placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { deriveEnvironmentIntent } from "./service-contract.js";
import * as support from "./service.test-support.js";

describe("worker placement shutdown replay", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("retains interrupted provisioning after database reopen until explicit Stop and fresh dispatch", async () => {
    support.testState.prepareInstallation = async () => ({
      ...support.BUNDLE_ARTIFACT,
      protocolFeatures: [WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE],
    });
    const interrupted = createDeferredCore<never>();
    const provisionStarted = createDeferredCore();
    const operationIds: string[] = [];
    const destroy = vi.fn(async () => {});
    const provider = support.createProvider({
      provision: async (_profile, operationId) => {
        operationIds.push(operationId);
        if (operationIds.length === 1) {
          provisionStarted.resolve();
          await interrupted.promise;
        }
        return { leaseId: "lease-shutdown-replay", ssh: support.SSH_ENDPOINT, sharedHost: false };
      },
      destroy,
    });
    let placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
    const first = support.createService(provider);
    let shuttingDown = false;
    const dispatch = createRecoveryService(placements, first, () => shuttingDown);
    const transitions: string[] = [];
    const request = { ...REQUEST, executionMode: "remote-exec" as const };
    const rejected = expect(
      dispatch.dispatch(request, (placement) => transitions.push(placement.state)),
    ).rejects.toThrow("provider interrupted");
    await provisionStarted.promise;
    const provisioning = placements.get(REQUEST.sessionId)!;
    const environmentId = provisioning.environmentId!;
    const operationId = support.testState.store.get(environmentId)!.provisionOperationId;
    shuttingDown = true;
    interrupted.reject(new Error("provider interrupted"));
    await rejected;

    expect(placements.get(REQUEST.sessionId)).toMatchObject({
      state: "provisioning",
      terminalAtMs: null,
      generation: provisioning.generation,
      environmentId,
    });
    expect(support.testState.store.get(environmentId)).toMatchObject({
      state: "provisioning",
      destroyRequestedAtMs: null,
      provisionOperationId: operationId,
      lastError: expect.stringContaining("provider interrupted"),
    });
    expect(transitions).toEqual(["requested", "provisioning", "provisioning"]);
    expect(destroy).not.toHaveBeenCalled();

    await support.reopenWorkerEnvironmentStore();
    placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
    const restarted = support.createService(provider);
    const syncWorkspace = vi.fn(async () => ({
      mode: "git" as const,
      remoteWorkspaceDir: "/worker/workspace",
      manifestRef: MANIFEST_REF,
    }));
    const startTunnel = vi.spyOn(restarted, "startTunnel").mockImplementation(async (owner) => ({
      ...owner,
      syncWorkspace,
      runWorkspaceCommand: vi.fn(),
      quiesceWorkspace: vi.fn(),
      reconcileWorkspace: vi.fn(),
      stop: vi.fn(),
    }));
    const attach = vi.spyOn(restarted, "attachSession");
    const recovery = coordinateWorkerPlacementDispatch(
      createRecoveryService(placements, restarted),
      (_request, run, authorize) => {
        authorize?.();
        return run();
      },
    );
    expect(recovery).not.toHaveProperty("resumeProvisioning");
    const uninstall = installWorkerPlacementReconcileGuard({
      placements,
      environments: restarted,
      dispatch: recovery,
      isStopping: () => false,
    });
    const owner = placements.get(REQUEST.sessionId)!;
    if (owner.state !== "provisioning") {
      throw new Error("restart lost its provisioning owner");
    }
    try {
      await recovery.reconcile("startup");
      await recovery.reconcileActive(environmentId);
      expect(placements.get(REQUEST.sessionId)).toEqual(owner);
      expect(restarted.get(environmentId)).toMatchObject({
        state: "provisioning",
        destroyRequestedAtMs: null,
        provisionOperationId: operationId,
        lastError: expect.stringContaining(
          "Stop the unfinished worker and retry with fresh authority",
        ),
      });
      expect(restarted.get(environmentId)?.lastError).toContain("provider interrupted");
      expect(operationIds).toEqual([operationId]);
      expect(attach).not.toHaveBeenCalled();
      expect(startTunnel).not.toHaveBeenCalled();
      expect(syncWorkspace).not.toHaveBeenCalled();
      expect(destroy).not.toHaveBeenCalled();
      expect(support.testState.bootstrapWorker).not.toHaveBeenCalled();

      await expect(recovery.reclaim(request)).resolves.toMatchObject({ state: "local" });
      expect(restarted.get(environmentId)?.state).toBe("destroyed");
      expect(destroy).toHaveBeenCalledOnce();
      const authorize = vi.fn();
      const active = await recovery.dispatch(request, undefined, authorize);
      expect(active.state).toBe("active");
      expect(active.environmentId).not.toBe(environmentId);
      expect(active.generation).toBeGreaterThan(owner.generation);
      expect(authorize).toHaveBeenCalled();
      expect(operationIds).toHaveLength(2);
      expect(operationIds[1]).not.toBe(operationId);
      expect(attach).toHaveBeenCalledOnce();
      expect(syncWorkspace).toHaveBeenCalledOnce();
      await recovery.reconcile("startup");
      expect(placements.get(REQUEST.sessionId)).toMatchObject({
        state: "active",
        environmentId: active.environmentId,
        activeOwnerEpoch: active.activeOwnerEpoch,
      });
      expect(operationIds).toHaveLength(2);
      expect(attach).toHaveBeenCalledOnce();
      expect(syncWorkspace).toHaveBeenCalledOnce();
    } finally {
      await uninstall();
    }
  });

  it.each([
    { shutdown: false, destroyRequested: false },
    { shutdown: true, destroyRequested: true },
  ])(
    "tears down rejected provisioning with $shutdown shutdown and $destroyRequested destroy intent",
    async ({ shutdown, destroyRequested }) => {
      const provider = support.createProvider({
        provision: async (_profile, operationId) => {
          const environment = support.testState.store
            .list()
            .find((record) => record.provisionOperationId === operationId)!;
          if (destroyRequested) {
            support.testState.store.requestDestroy({
              environmentId: environment.environmentId,
              state: environment.state,
            });
          }
          throw new Error("provider interrupted");
        },
      });
      const environments = support.createService(provider);
      const destroy = vi.spyOn(environments, "destroy");
      const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
      const dispatch = createRecoveryService(placements, environments, () => shutdown);

      await expect(dispatch.dispatch({ ...REQUEST, executionMode: "remote-exec" })).rejects.toThrow(
        "provider interrupted",
      );

      expect(placements.get(REQUEST.sessionId)).toMatchObject({ state: "failed" });
      expect(placements.get(REQUEST.sessionId)?.terminalAtMs).not.toBeNull();
      expect(destroy).toHaveBeenCalledOnce();
      expect(destroy).toHaveBeenCalledWith(
        deriveEnvironmentIntent(`session-dispatch:${REQUEST.sessionId}:1`).environmentId,
      );
    },
  );
});
