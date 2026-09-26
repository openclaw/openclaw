import { describe, expect, it, vi } from "vitest";
import {
  WORKER_EXECUTION_AUTHORITY_PROTOCOL_FEATURE,
  WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { installWorkerPlacementReconcileGuard } from "../server-worker-placement-reconcile-guard.js";
import { BUNDLE_HASH, MANIFEST_REF } from "./placement-dispatch-test-fixtures.js";
import { createRecoveryService } from "./placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import * as support from "./service.test-support.js";

const protocolFeatures = [
  WORKER_EXECUTION_AUTHORITY_PROTOCOL_FEATURE,
  WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
];

async function seedActiveNode(
  placements: ReturnType<typeof createWorkerSessionPlacementStore>,
  index: number,
) {
  const environmentId = `worker-${index}`;
  const sessionId = `session-${index}`;
  await support.seedBootstrapping(environmentId);
  await support.testState.store.transition({
    environmentId,
    from: "bootstrapping",
    to: "ready",
    patch: {
      ...support.readyPatch(environmentId, { ...support.BOOTSTRAP_RECEIPT, protocolFeatures }),
      nodeDeviceId: `node:${environmentId}`,
      sshEndpoint: null,
    },
  });
  const environment = await support.testState.store.transition({
    environmentId,
    from: "ready",
    to: "attached",
    patch: support.attachedPatch(environmentId, sessionId),
  });
  let placement = placements.startDispatch({
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
    agentId: "main",
    executionMode: "worker-turn",
  });
  const transitions = [
    { to: "provisioning", patch: { environmentId } },
    { to: "syncing", patch: { workerBundleHash: BUNDLE_HASH } },
    {
      to: "starting",
      patch: {
        workspaceBaseManifestRef: MANIFEST_REF,
        remoteWorkspaceDir: `/worker/workspace-${index}`,
      },
    },
    { to: "active", patch: { activeOwnerEpoch: environment.ownerEpoch } },
  ] as const;
  for (const transition of transitions) {
    placement = placements.transition({
      sessionId,
      from: placement.state,
      expectedGeneration: placement.generation,
      ...transition,
    });
  }
  return { environment, placement };
}

describe("worker placement startup concurrency", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it.each([false, true])(
    "drains bounded startup inspections before recovery (conflicting owner: %s)",
    async (conflictingOwner) => {
      support.testState.prepareInstallation = async () => ({
        ...support.BUNDLE_ARTIFACT,
        protocolFeatures,
      });
      const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
      const workers = await Promise.all(
        Array.from({ length: 9 }, async (_, index) => ({
          ...(await seedActiveNode(placements, index)),
          entered: createDeferredCore(),
          release: createDeferredCore(),
          inspected: createDeferredCore(),
        })),
      );
      const inspect = vi.fn(async ({ leaseId }: support.WorkerLifecycleLease) => {
        const worker = workers.find(({ environment }) => environment.leaseId === leaseId)!;
        worker.entered.resolve();
        await worker.release.promise;
        worker.inspected.resolve();
        return { status: "active" as const };
      });
      const environments = support.createService(
        support.createProvider({ inspect, supportedExecutionModes: ["worker-turn"] }),
      );
      const adopt = vi.spyOn(placements, "adoptActive");
      const recovery = createRecoveryService(placements, environments);
      const uninstall = installWorkerPlacementReconcileGuard({
        placements,
        environments,
        dispatch: recovery,
        isStopping: () => false,
      });
      let outcome = "pending";
      let failure: unknown;
      const starting = recovery.reconcile("startup").then(
        () => {
          outcome = "ready";
        },
        (error: unknown) => {
          outcome = "failed";
          failure = error;
        },
      );
      try {
        await Promise.all(workers.slice(0, 8).map((worker) => worker.entered.promise));
        expect(inspect).toHaveBeenCalledTimes(8);
        expect(outcome).toBe("pending");
        expect(adopt).not.toHaveBeenCalled();

        if (conflictingOwner) {
          const duplicate = placements.startDispatch({
            sessionId: "session-duplicate",
            sessionKey: "agent:main:session-duplicate",
            agentId: "main",
            executionMode: "worker-turn",
          });
          placements.transition({
            sessionId: duplicate.sessionId,
            from: "requested",
            to: "provisioning",
            expectedGeneration: duplicate.generation,
            patch: { environmentId: workers[8]!.environment.environmentId },
          });
        }
        workers[0]!.release.resolve();
        if (!conflictingOwner) {
          await workers[8]!.entered.promise;
        }
        expect(inspect).toHaveBeenCalledTimes(conflictingOwner ? 8 : 9);
        expect(outcome).toBe("pending");
        expect(adopt).not.toHaveBeenCalled();
        for (const worker of workers.slice(1, 8)) {
          worker.release.resolve();
        }
        await Promise.all(workers.slice(0, 8).map((worker) => worker.inspected.promise));
        if (conflictingOwner) {
          await starting;
          expect(outcome).toBe("failed");
          expect(failure).toEqual(
            new Error("Worker environment worker-8 has multiple placement owners"),
          );
          expect(adopt).not.toHaveBeenCalled();
          return;
        }
        expect(outcome).toBe("pending");
        expect(adopt).not.toHaveBeenCalled();
        workers[8]!.release.resolve();
        await starting;

        expect(outcome).toBe("ready");
        expect(adopt).toHaveBeenCalledTimes(9);
        for (const { environment, placement } of workers) {
          expect(environments.get(environment.environmentId)).toMatchObject({
            leaseId: environment.leaseId,
            ownerEpoch: environment.ownerEpoch,
            state: "attached",
          });
          expect(placements.get(placement.sessionId)).toMatchObject({
            environmentId: environment.environmentId,
            activeOwnerEpoch: environment.ownerEpoch,
            state: "active",
          });
        }
      } finally {
        for (const worker of workers) {
          worker.release.resolve();
        }
        await starting;
        await uninstall();
      }
    },
  );
});
