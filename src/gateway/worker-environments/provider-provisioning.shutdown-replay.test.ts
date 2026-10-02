import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import {
  WORKER_EXECUTION_AUTHORITY_PROTOCOL_FEATURE,
  WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { WorkerNodeEnrollment } from "../../plugins/types.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { createWorkerNodeEnrollmentManager } from "./node-enrollment.js";
import { REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import {
  bindProviderReplayNodeAvailability,
  createProviderReplayDispatch,
  createProviderReplayNodeTunnel,
} from "./provider-replay.test-support.js";
import { deriveEnvironmentIntent } from "./service-contract.js";
import * as support from "./service.test-support.js";
import { createWorkerEnvironmentStore } from "./store.js";
import { createWorkerBootstrapArtifactTransferService } from "./worker-bootstrap-artifact-transfer-service.js";

describe("worker node provisioning shutdown replay", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("cancels guarded enrollment without releasing the exact lease and adopts it after restart", async () => {
    const deviceId = "device-node-shutdown-replay";
    const leaseId = "lease-node-shutdown-replay";
    const operationIds: string[] = [];
    const physicalLeases = new Set<string>();
    const enrollments: WorkerNodeEnrollment[] = [];
    support.testState.config.gateway = { publicOrigin: "https://gateway.example.test" };
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
    support.testState.prepareInstallation = vi.fn(async () => ({
      ...support.BUNDLE_ARTIFACT,
      protocolFeatures: [
        WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
        WORKER_EXECUTION_AUTHORITY_PROTOCOL_FEATURE,
      ],
    }));
    let placements = createWorkerSessionPlacementStore({
      database: support.testState.stateDb,
      now: () => support.testState.nowMs,
    });
    const requested = await placements.startDispatch(REQUEST);
    const intent = deriveEnvironmentIntent(
      `session-dispatch:${REQUEST.sessionId}:${requested.generation}`,
    );
    const placement = placements.transition({
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
    const unavailable = vi.fn(async () => ({ available: false as const }));
    const firstTransfer = createWorkerBootstrapArtifactTransferService();
    const firstEnrollment = createWorkerNodeEnrollmentManager({
      store: support.testState.store,
      getConfig: () => support.testState.config,
      resolveAvailability: unavailable,
      prepareArtifact,
      transfer: firstTransfer,
    });
    const receipt = {
      ...support.BOOTSTRAP_RECEIPT,
      protocolFeatures: [
        WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
        WORKER_EXECUTION_AUTHORITY_PROTOCOL_FEATURE,
      ],
    };
    const first = support.createService(provider, {
      prepareNodeBootstrap: firstEnrollment.prepare,
      prepareNodeEnrollment: firstEnrollment.begin,
      closeNodeEnrollment: firstEnrollment.close,
      stopNodeEnrollmentWaits: firstEnrollment.stop,
      ensureNodeWorkerBundle: async () => receipt,
    });

    const createDispatch = (environments: typeof first) =>
      createProviderReplayDispatch({
        placements,
        environments,
        resolveDevicePlacementRequirement: async () => ({
          requiredNodeCommands: [],
          consumesWorkerSlot: true,
        }),
        isCurrentNodePlacement: () => true,
      });
    const firstDispatch = createDispatch(first);
    const uninstallFirstGuard = first.installReconcileEnvironmentGuard(
      async (environmentId, reconcileCore) => {
        const owner = placements
          .list()
          .find((candidate) => candidate.environmentId === environmentId);
        if (owner?.state !== "provisioning") {
          throw new Error("guarded recovery lost its provisioning owner");
        }
        await firstDispatch.resumeProvisioning(owner, reconcileCore);
      },
    );
    const recovery = firstDispatch.reconcile();
    await support.waitForFast(() => expect(unavailable).toHaveBeenCalled());

    let stopped = false;
    const stopping = first.stop().then(() => {
      stopped = true;
    });
    await support.waitForFast(() => expect(stopped).toBe(true), { timeout: 1_000 });
    await Promise.all([recovery, stopping]);
    await uninstallFirstGuard();
    expect(enrollments[0]?.signal?.aborted).toBe(true);
    expect(
      firstTransfer.authorize({
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
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    support.testState.stateDb = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: support.testState.root },
    });
    support.testState.store = await createWorkerEnvironmentStore({
      database: support.testState.stateDb,
      now: () => support.testState.nowMs,
    });
    placements = createWorkerSessionPlacementStore({
      database: support.testState.stateDb,
      now: () => support.testState.nowMs,
    });
    const restartedTransfer = createWorkerBootstrapArtifactTransferService();
    const restartedEnrollment = createWorkerNodeEnrollmentManager({
      store: support.testState.store,
      getConfig: () => support.testState.config,
      resolveAvailability: async () => ({ available: true }),
      prepareArtifact,
      transfer: restartedTransfer,
    });
    const { nodeTunnelManager, syncWorkspace } = createProviderReplayNodeTunnel();
    const restarted = support.createService(provider, {
      prepareNodeBootstrap: restartedEnrollment.prepare,
      prepareNodeEnrollment: restartedEnrollment.begin,
      closeNodeEnrollment: restartedEnrollment.close,
      stopNodeEnrollmentWaits: restartedEnrollment.stop,
      ensureNodeWorkerBundle: async () => receipt,
      nodeTunnelManager,
    });
    bindProviderReplayNodeAvailability(restarted);
    const restartedDispatch = createDispatch(restarted);
    const uninstallRestartedGuard = restarted.installReconcileEnvironmentGuard(
      async (environmentId, reconcileCore) => {
        const owner = expectDefined(
          placements.list().find((candidate) => candidate.environmentId === environmentId),
          "restarted provisioning owner",
        );
        if (owner.state !== "provisioning") {
          throw new Error("restarted recovery lost its provisioning placement");
        }
        await restartedDispatch.resumeProvisioning(owner, reconcileCore);
      },
    );

    await restartedDispatch.reconcile();
    await uninstallRestartedGuard();

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
    expect(syncWorkspace).toHaveBeenCalledOnce();
    expect(destroy).not.toHaveBeenCalled();
  });
});
