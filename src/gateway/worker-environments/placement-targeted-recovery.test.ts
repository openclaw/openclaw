import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  WORKER_EXECUTION_AUTHORITY_PROTOCOL_FEATURE,
  WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { installWorkerPlacementReconcileGuard } from "../server-worker-placement-reconcile-guard.js";
import { coordinateWorkerPlacementDispatch } from "./placement-dispatch-coordinator.js";
import { REQUEST, seedActivePlacement } from "./placement-dispatch-test-fixtures.js";
import { createHarness, createRecoveryService } from "./placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import type { WorkerEnvironmentService } from "./service.js";
import * as support from "./service.test-support.js";

const PROTOCOL_FEATURES = [
  WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
  WORKER_EXECUTION_AUTHORITY_PROTOCOL_FEATURE,
];

async function seedAttached(environmentId: string) {
  await support.seedBootstrapping(environmentId);
  await support.testState.store.transition({
    environmentId,
    from: "bootstrapping",
    to: "ready",
    patch: support.readyPatch(environmentId, {
      ...support.BOOTSTRAP_RECEIPT,
      protocolFeatures: PROTOCOL_FEATURES,
    }),
  });
  return support.testState.store.transition({
    environmentId,
    from: "ready",
    to: "attached",
    patch: support.attachedPatch(environmentId, REQUEST.sessionId),
  });
}

async function observeTarget<T>(
  targeted: Promise<void>,
  blocked: Promise<void>,
  release: () => void,
  snapshot: () => T | Promise<T>,
  cleanup = async () => {},
) {
  try {
    const first = await Promise.race([targeted.then(() => true), blocked.then(() => false)]);
    return { first, snapshot: await snapshot() };
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
      protocolFeatures: PROTOCOL_FEATURES,
    });
  });

  async function activateRemote(environmentId: string) {
    const identity = await seedAttached(environmentId);
    const active = await seedActivePlacement(placements, {
      environmentId,
      ownerEpoch: identity.ownerEpoch,
      executionMode: "remote-exec",
    });
    return { active, ownerEpoch: identity.ownerEpoch };
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
    const { first, snapshot } = await observeTarget(
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
    expect(first).toBe(true);
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
      source: {
        generation: active.generation,
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
      target: { kind: "gateway" },
    });
    const dispatch = coordinateWorkerPlacementDispatch(harness.service, (_request, run) => run());
    const { first, snapshot } = await observeTarget(
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
    expect(first).toBe(true);
    expect(snapshot).toBeDefined();
  });

  it.each(["source", "destination"] as const)(
    "recovers a move selected by its %s after source cleanup already completed",
    async (match) => {
      const sourceId = "worker-move-source";
      const destinationId = "worker-move-destination";
      const { active, ownerEpoch } = await activateRemote(sourceId);
      const begun = await placements.beginPlacementMove({
        sessionId: active.sessionId,
        source: {
          generation: active.generation,
          environmentId: sourceId,
          ownerEpoch,
        },
        target: { kind: "profile", profileId: "development" },
      });
      const reconciling = await placements.startReconcile({
        sessionId: active.sessionId,
        environmentId: sourceId,
        ownerEpoch,
        expectedGeneration: begun.placement.generation,
      });
      await placements.completePlacementMoveSourceToLocal({
        operationId: begun.intent.operationId,
        sessionId: active.sessionId,
        expectedGeneration: reconciling.generation,
      });
      const environments = support.createService(support.createProvider());
      await environments.destroy(sourceId);
      if (match === "destination") {
        await activateRemote(destinationId);
      }
      const dispatch = await createDispatch(environments);
      await dispatch.reconcileActive(match === "source" ? sourceId : destinationId);
      expect(await placements.getPlacementMoveAsync(active.sessionId)).toBeUndefined();
      expect(placements.get(active.sessionId)?.state).toBe(
        match === "source" ? "failed" : "active",
      );
      if (match === "source") {
        expect(placements.get(active.sessionId)?.recoveryError).toContain("authority expired");
      }
    },
  );
});
