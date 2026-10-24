import { beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { installWorkerPlacementReconcileGuard } from "../server-worker-placement-reconcile-guard.js";
import { coordinateWorkerPlacementDispatch } from "./placement-dispatch-coordinator.js";
import {
  createDispatchEnvironmentFixtures,
  REQUEST,
  seedActivePlacement,
} from "./placement-dispatch-test-fixtures.js";
import { createHarness, createRecoveryService } from "./placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { placementSource } from "./placement-suite.test-support.js";
import type { WorkerEnvironmentService } from "./service.js";
import * as support from "./service.test-support.js";

const RECEIPT = createDispatchEnvironmentFixtures().ready.bootstrapReceipt;

async function observeTarget<T>(
  targeted: Promise<void>,
  blocked: Promise<void>,
  release: () => void,
  snapshot: () => T | Promise<T>,
  cleanup = async () => {},
) {
  try {
    await awaitGateBeforeSettlement(targeted, blocked, "target waited for unrelated work");
    return await snapshot();
  } finally {
    release();
    await targeted;
    await cleanup();
  }
}

describe("targeted worker placement recovery", () => {
  support.setupWorkerEnvironmentServiceSuite();
  let placements: ReturnType<typeof createWorkerSessionPlacementStore>;
  beforeEach(() => {
    placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
    support.testState.prepareInstallation = async () => ({
      ...support.BUNDLE_ARTIFACT,
      protocolFeatures: RECEIPT.protocolFeatures,
    });
  });

  async function activateRemote(environmentId: string) {
    await support.seedBootstrapping(environmentId);
    await support.testState.store.transition({
      environmentId,
      from: "bootstrapping",
      to: "ready",
      patch: support.readyPatch(environmentId, RECEIPT),
    });
    const identity = await support.testState.store.transition({
      environmentId,
      from: "ready",
      to: "attached",
      patch: support.attachedPatch(environmentId, REQUEST.sessionId),
    });
    const active = await seedActivePlacement(placements, {
      environmentId,
      ownerEpoch: identity.ownerEpoch,
      executionMode: "remote-exec",
    });
    return {
      sessionId: active.sessionId,
      source: { generation: active.generation, environmentId, ownerEpoch: identity.ownerEpoch },
    };
  }

  async function createDispatch(environments: WorkerEnvironmentService) {
    return coordinateWorkerPlacementDispatch(
      await createRecoveryService(placements, environments),
      (_request, run) => run(),
    );
  }

  it("does not wait for a sibling provider inspection; full sweeps still inspect and maintain it", async () => {
    const targetId = "worker-target";
    const siblingId = "worker-sibling";
    await activateRemote(targetId);
    await support.seedReady(siblingId);
    const inspectionStarted = createDeferredCore();
    const releaseInspection = createDeferredCore();
    const inspected: string[] = [];
    const maintainProviders = vi.fn(async () => {});
    const environments = support.createService(
      support.createProvider({
        inspect: async ({ leaseId }) => {
          inspected.push(leaseId);
          if (leaseId === `lease:${siblingId}`) {
            inspectionStarted.resolve();
            await releaseInspection.promise;
          }
          return { status: "active" };
        },
      }),
      { maintainProviders },
    );
    const dispatch = await createDispatch(environments);
    const uninstall = installWorkerPlacementReconcileGuard({
      placements,
      environments,
      dispatch,
      isStopping: () => false,
    });
    const snapshot = await observeTarget(
      dispatch.reconcileActive(targetId),
      inspectionStarted.promise,
      releaseInspection.resolve,
      () => [...inspected],
      uninstall,
    );
    inspected.length = 0;
    maintainProviders.mockClear();
    const prune = vi.spyOn(support.testState.store, "pruneTerminalEnvironments");
    await dispatch.reconcileActive();
    expect(inspected.toSorted()).toEqual([`lease:${siblingId}`, `lease:${targetId}`]);
    expect(maintainProviders).toHaveBeenCalledOnce();
    expect(prune).toHaveBeenCalledOnce();
    expect(placements.get(REQUEST.sessionId)?.state).toBe("active");
    expect(snapshot).toEqual([`lease:${targetId}`]);
  });

  it("leaves an unrelated move for the full sweep instead of waiting for its workspace cleanup", async () => {
    const cleanupStarted = createDeferredCore();
    const releaseCleanup = createDeferredCore();
    const harness = await createHarness(support.testState.stateDb, placements, {
      workspacePath: support.testState.root,
      reconcileChanged: false,
      reconcileCommitsManifest: false,
      afterReconcile: async () => {
        cleanupStarted.resolve();
        await releaseCleanup.promise;
      },
    });
    const active = await harness.service.dispatch(REQUEST);
    await placements.beginPlacementMove({
      sessionId: active.sessionId,
      source: placementSource(active),
      target: { kind: "gateway" },
    });
    const dispatch = coordinateWorkerPlacementDispatch(harness.service, (_request, run) => run());
    const snapshot = await observeTarget(
      dispatch.reconcileActive("worker-unrelated"),
      cleanupStarted.promise,
      releaseCleanup.resolve,
      () => placements.getPlacementMoveAsync(active.sessionId),
    );
    await dispatch.reconcileActive();
    expect(placements.get(active.sessionId)?.state).toBe("local");
    expect(await placements.getPlacementMoveAsync(active.sessionId)).toBeUndefined();
    expect(harness.log.filter((event) => event === "workspace:reconcile")).toHaveLength(1);
    expect(harness.environments.destroy).toHaveBeenCalledOnce();
    expect(snapshot).toBeDefined();
  });

  it.each(["source", "destination"] as const)(
    "recovers a move selected by its %s after source cleanup already completed",
    async (match) => {
      const sourceId = "worker-move-source";
      const destinationId = "worker-move-destination";
      const { sessionId, source } = await activateRemote(sourceId);
      const begun = await placements.beginPlacementMove({
        sessionId,
        source,
        target: { kind: "profile", profileId: "development" },
      });
      const reconciling = await placements.startReconcile({
        sessionId,
        environmentId: sourceId,
        ownerEpoch: source.ownerEpoch,
        expectedGeneration: begun.placement.generation,
      });
      await placements.completePlacementMoveSourceToLocal({
        operationId: begun.intent.operationId,
        sessionId,
        expectedGeneration: reconciling.generation,
      });
      const environments = support.createService(support.createProvider());
      await environments.destroy(sourceId);
      if (match === "destination") {
        await activateRemote(destinationId);
      }
      const dispatch = await createDispatch(environments);
      await dispatch.reconcileActive(match === "source" ? sourceId : destinationId);
      expect(await placements.getPlacementMoveAsync(sessionId)).toBeUndefined();
      expect(placements.get(sessionId)?.state).toBe(match === "source" ? "failed" : "active");
      if (match === "source") {
        expect(placements.get(sessionId)?.recoveryError).toContain("authority expired");
      }
    },
  );
});
