import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { WorkerNodeEnrollment } from "../../plugins/types.js";
import { createWorkerNodeEnrollmentManager } from "./node-enrollment.js";
import { REQUEST } from "./placement-dispatch-test-fixtures.js";
import { WORKER_PROTOCOL_FEATURES } from "./placement-lifecycle.test-support.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import {
  bindProviderReplayNodeAvailability,
  createProviderReplayDispatch,
  createProviderReplayNodeTunnel,
} from "./provider-replay.test-support.js";
import { deriveEnvironmentIntent } from "./service-contract.js";
import * as support from "./service.test-support.js";
import { createWorkerBootstrapArtifactTransferService } from "./worker-bootstrap-artifact-transfer-service.js";

support.setupWorkerEnvironmentServiceSuite();

it("cancels guarded enrollment without releasing the exact lease and adopts it after restart", async () => {
  const deviceId = "device-node-shutdown-replay";
  const leaseId = "lease-node-shutdown-replay";
  const operationIds: string[] = [];
  const physicalLeases = new Set<string>();
  const enrollments: WorkerNodeEnrollment[] = [];
  support.testState.config.gateway = { publicOrigin: "https://gateway.example.test" };
  setRuntimeConfigSnapshot(support.testState.config);
  const prepareArtifact = async () => ({
    tarballPath: "/gateway/cache/node-runtime.tgz",
    tarballSha256: support.NODE_BOOTSTRAP.sha256,
    tarballBytes: support.NODE_BOOTSTRAP.bytes,
    openclawVersion: support.NODE_BOOTSTRAP.openclawVersion,
    enabledPluginIds: support.NODE_BOOTSTRAP.enabledPluginIds,
    buildId: "gateway-source-build",
  });
  const destroy = vi.fn(async ({ leaseId: destroyedLeaseId }: { leaseId: string }) => {
    physicalLeases.delete(destroyedLeaseId);
  });
  let physicalAllocations = 0;
  const provider = support.createProvider({
    supportedExecutionModes: ["worker-turn"],
    provisionBeforeInstallation: true,
    requiresNodeEnrollment: true,
    provision: async (_profile, operationId, options) => {
      operationIds.push(operationId);
      if (!physicalLeases.has(leaseId)) {
        physicalLeases.add(leaseId);
        physicalAllocations += 1;
      }
      const enrollment = await options?.beginNodeEnrollment?.();
      if (!enrollment) {
        throw new Error("node enrollment was not prepared");
      }
      enrollments.push(enrollment);
      return {
        leaseId,
        node: { deviceId: await enrollment.waitForDeviceId() },
        sharedHost: false,
      };
    },
    destroy,
  });
  const protocolFeatures = [...WORKER_PROTOCOL_FEATURES];
  support.testState.prepareInstallation = vi.fn(async () => ({
    ...support.BUNDLE_ARTIFACT,
    protocolFeatures,
  }));
  const placementStore = () =>
    createWorkerSessionPlacementStore({
      database: support.testState.stateDb,
      now: () => support.testState.nowMs,
    });
  let placements = placementStore();
  const requested = await placements.startDispatch(REQUEST);
  const intent = deriveEnvironmentIntent(
    `session-dispatch:${REQUEST.sessionId}:${requested.generation}`,
  );
  const placement = await placements.transition({
    sessionId: requested.sessionId,
    from: "requested",
    to: "provisioning",
    expectedGeneration: requested.generation,
    patch: { environmentId: intent.environmentId },
  });
  const environment = await support.testState.store.createIntent({
    environmentId: intent.environmentId,
    providerId: provider.id,
    profileId: "development",
    profileSnapshot: { install: "bundle", settings: { region: "test" } },
    provisionOperationId: intent.provisionOperationId,
  });
  await support.testState.store.transition({
    environmentId: environment.environmentId,
    from: "requested",
    to: "provisioning",
    patch: { nodeDeviceId: deviceId },
  });
  const receipt = { ...support.BOOTSTRAP_RECEIPT, protocolFeatures };
  async function startService(available: boolean) {
    const node = available ? createProviderReplayNodeTunnel() : undefined;
    const resolveAvailability = vi.fn(async () => ({ available }));
    const transfer = createWorkerBootstrapArtifactTransferService();
    const enrollment = createWorkerNodeEnrollmentManager({
      store: support.testState.store,
      getConfig: () => support.testState.config,
      resolveAvailability,
      prepareArtifact,
      transfer,
    });
    const service = support.createService(provider, {
      prepareNodeBootstrap: enrollment.prepare,
      prepareNodeEnrollment: enrollment.begin,
      closeNodeEnrollment: enrollment.close,
      stopNodeEnrollmentWaits: enrollment.stop,
      ensureNodeWorkerBundle: async () => receipt,
      ...(node ? { nodeTunnelManager: node.nodeTunnelManager } : {}),
    });
    if (node) {
      bindProviderReplayNodeAvailability(service);
    }
    const dispatch = createProviderReplayDispatch({
      initialPlacements: await placements.listAsync(),
      placements,
      environments: service,
      resolveDevicePlacementRequirement: async () => ({
        requiredNodeCommands: [],
        consumesWorkerSlot: true,
      }),
      isCurrentNodePlacement: () => true,
    });
    const uninstall = service.installReconcileEnvironmentGuard(async (environmentId, core) => {
      const owner = expectDefined(
        (await placements.listAsync()).find((row) => row.environmentId === environmentId),
        "provisioning owner",
      );
      if (owner.state !== "provisioning") {
        throw new Error("guarded recovery lost its provisioning owner");
      }
      await dispatch.resumeProvisioning(owner, core);
    });
    return { service, dispatch, transfer, uninstall, resolveAvailability, node };
  }
  const first = await startService(false);
  const recovery = first.dispatch.reconcile();
  await support.waitForFast(() => expect(first.resolveAvailability).toHaveBeenCalled());

  let stopped = false;
  const stopping = first.service.stop().then(() => {
    stopped = true;
  });
  await support.waitForFast(() => expect(stopped).toBe(true), { timeout: 1_000 });
  await Promise.all([recovery, stopping]);
  await first.uninstall();
  expect(enrollments[0]?.signal?.aborted).toBe(true);
  expect(
    first.transfer.authorize({
      token: enrollments[0]!.nodeBootstrap.token,
      artifactKey: enrollments[0]!.nodeBootstrap.sha256,
    }),
  ).toBeUndefined();

  expect(placements.get(REQUEST.sessionId)).toEqual(placement);
  expect(support.testState.store.get(intent.environmentId)).toMatchObject({
    state: "provisioning",
    leaseId: null,
    nodeDeviceId: deviceId,
    destroyRequestedAtMs: null,
    provisionOperationId: intent.provisionOperationId,
  });
  expect(physicalLeases).toEqual(new Set([leaseId]));
  expect(destroy).not.toHaveBeenCalled();

  support.testState.service = undefined;
  await support.reopenWorkerEnvironmentStore();
  placements = placementStore();
  const restarted = await startService(true);

  await restarted.dispatch.reconcile();
  await restarted.uninstall();

  expect(placements.get(REQUEST.sessionId)).toMatchObject({
    state: "active",
    environmentId: intent.environmentId,
  });
  expect(support.testState.store.get(intent.environmentId)).toMatchObject({
    state: "attached",
    leaseId,
    nodeDeviceId: deviceId,
    attachedSessionIds: [REQUEST.sessionId],
    provisionOperationId: intent.provisionOperationId,
  });
  expect(operationIds).toEqual([intent.provisionOperationId, intent.provisionOperationId]);
  expect(physicalAllocations).toBe(1);
  expect(physicalLeases).toEqual(new Set([leaseId]));
  expect(restarted.node?.syncWorkspace).toHaveBeenCalledOnce();
  expect(destroy).not.toHaveBeenCalled();
});
