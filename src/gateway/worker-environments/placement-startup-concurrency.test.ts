import { describe, expect, it, vi } from "vitest";
import {
  WORKER_EXECUTION_AUTHORITY_PROTOCOL_FEATURE,
  WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { requireOpenClawStateDatabaseIdentity } from "../../state/openclaw-state-db-cache.js";
import { installWorkerPlacementReconcileGuard } from "../server-worker-placement-reconcile-guard.js";
import { coordinateWorkerPlacementDispatch } from "./placement-dispatch-coordinator.js";
import {
  createCoordinatorTestService,
  REQUEST,
} from "./placement-dispatch-coordinator.test-support.js";
import { BUNDLE_HASH, MANIFEST_REF } from "./placement-dispatch-test-fixtures.js";
import { createRecoveryService } from "./placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { writePlacementEnvironmentFixture } from "./placement-test-fixtures.js";
import * as support from "./service.test-support.js";
import { createWorkerEnvironmentCommitAdmission } from "./store-commit-authority.js";
import { workerEnvironmentProjections } from "./store-projection.js";

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
  let placement = await placements.startDispatch({
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
    placement = await placements.transition({
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
      const projectionReads = vi.spyOn(placements, "readProjection");
      const environments = support.createService(
        support.createProvider({ inspect, supportedExecutionModes: ["worker-turn"] }),
      );
      const adopt = vi.spyOn(placements, "adoptActive");
      const recovery = coordinateWorkerPlacementDispatch(
        await createRecoveryService(placements, environments),
        (_request, run) => run(),
      );
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
        expect(projectionReads.mock.calls.filter(([ids]) => ids.length > 1)).toEqual([]);
        expect(outcome).toBe("pending");
        expect(adopt).not.toHaveBeenCalled();

        if (conflictingOwner) {
          const duplicate = await placements.startDispatch({
            sessionId: "session-duplicate",
            sessionKey: "agent:main:session-duplicate",
            agentId: "main",
            executionMode: "worker-turn",
          });
          await placements.transition({
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
          expect(failure).toBeInstanceOf(Error);
          expect(failure).toMatchObject({
            message: "Worker environment worker-8 has multiple placement owners",
          });
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
  it.each(["ready", "caller revoked", "profile changed"] as const)(
    "joins pending setup before reading its changing inventory (%s)",
    async (outcome) => {
      const database = support.testState.stateDb;
      const placements = createWorkerSessionPlacementStore({ database });
      const environments = support.testState.store;
      const inventory = workerEnvironmentProjections.get(
        requireOpenClawStateDatabaseIdentity({ db: database.db }),
      )!;
      const environmentId = "pending-environment";
      writePlacementEnvironmentFixture(database, {
        environmentId,
        state: "ready",
        leaseId: "native-device-lease",
        nodeDeviceId: "native-device",
        bootstrapReceipt: { ...support.BOOTSTRAP_RECEIPT, protocolFeatures },
        ownerEpoch: 1,
        attachedSessionIds: [],
        profileId: REQUEST.profileId,
      });
      const environment = environments.get(environmentId);
      if (environment?.state !== "ready") {
        throw new Error("Setup requires a ready worker environment");
      }
      const readyEnvironment = {
        ...environment,
        state: "attached" as const,
        attachedSessionIds: [REQUEST.sessionId],
      };
      const joined = createDeferredCore();
      const entered = createDeferredCore();
      const finish = createDeferredCore();
      const token = {};
      let callerCurrent = true;
      const dispatch = vi.fn<ReturnType<typeof createCoordinatorTestService>["dispatch"]>(
        async (request, onTransition) => {
          let placement = await placements.startDispatch(request);
          onTransition?.(placement);
          placement = await placements.transition({
            sessionId: request.sessionId,
            from: "requested",
            to: "provisioning",
            expectedGeneration: placement.generation,
            patch: { environmentId },
          });
          onTransition?.(placement);
          // Hold the real inventory's admitted postimage until the setup owner commits it.
          inventory.fence(
            createWorkerEnvironmentCommitAdmission({
              ids: [environmentId],
              environments: [readyEnvironment],
              credentials: [],
              attachments: [],
            }),
            token,
          );
          entered.resolve();
          await finish.promise;
          writePlacementEnvironmentFixture(database, {
            ...readyEnvironment,
            profileId: outcome === "profile changed" ? "another-profile" : REQUEST.profileId,
          });
          inventory.release(token);
          const transitions = [
            { to: "syncing", patch: { workerBundleHash: BUNDLE_HASH } },
            {
              to: "starting",
              patch: { workspaceBaseManifestRef: "manifest", remoteWorkspaceDir: "/workspace" },
            },
            { to: "active", patch: { activeOwnerEpoch: 1 } },
          ] as const;
          for (const transition of transitions) {
            placement = await placements.transition({
              sessionId: request.sessionId,
              from: placement.state,
              expectedGeneration: placement.generation,
              ...transition,
            });
            onTransition?.(placement);
          }
          if (placement.state !== "active") {
            throw new Error("Setup did not publish an active placement");
          }
          return placement;
        },
      );
      const coordinator = coordinateWorkerPlacementDispatch(
        createCoordinatorTestService({ dispatch }),
        (_request, run) => run(),
        undefined,
        undefined,
        { placements, environments, redispatchPlacement: vi.fn(), warn: vi.fn() },
      );
      const waitForInitialPlacement = coordinator.waitForInitialPlacement;
      vi.spyOn(coordinator, "waitForInitialPlacement").mockImplementation(async (...args) => {
        joined.resolve();
        return await waitForInitialPlacement(...args);
      });
      const setup = coordinator.dispatch(REQUEST);
      try {
        await Promise.race([entered.promise, setup]);
        expect(() => environments.get(environmentId)).toThrow("unsettled mutation");
        const admission = coordinator.ensurePlacement({
          request: REQUEST,
          assertCurrent: () => {
            if (!callerCurrent) {
              throw new Error("caller revoked");
            }
          },
          authorizeDispatch: () => {},
          prepareWorkspace: vi.fn(),
        });
        const result = admission.then(
          (lease) => {
            lease.release();
            return "ready";
          },
          (error: unknown) => error,
        );
        await Promise.race([joined.promise, result]);
        callerCurrent = outcome !== "caller revoked";
        finish.resolve();
        await setup;
        if (outcome === "ready") {
          expect(await result).toBe("ready");
        } else {
          expect(await result).toMatchObject({
            message: expect.stringContaining(
              outcome === "caller revoked" ? "caller revoked" : "another worker profile",
            ),
          });
        }
        expect(dispatch).toHaveBeenCalledOnce();
      } finally {
        finish.resolve();
        await setup;
        inventory.release(token);
      }
    },
  );
});
