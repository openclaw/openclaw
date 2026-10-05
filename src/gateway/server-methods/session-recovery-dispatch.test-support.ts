import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import type { WorkerAdmissionHandshake } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  NODE_WORKER_ENVIRONMENT_SESSION_VERSION,
  NODE_WORKER_PREPARED_WORKSPACE_VERSION,
  NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
} from "../../infra/node-runner-inventory.js";
import type { WorkerProvider } from "../../plugins/types.js";
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import type { SessionRepositoryWorkspaceRecord } from "../../state/session-repository-workspaces.types.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { createNodeRegistryRuntime, updateNodeRunnerInventory } from "../node-registry-private.js";
import { NodeRegistry } from "../node-registry.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import { createDevicePlacementAuthority } from "../worker-environments/device-placement-eligibility.js";
import { bindDeviceWorkerAvailability } from "../worker-environments/device-provider.js";
import { readImageReserveProject } from "../worker-environments/image-reserve.js";
import { createNodeWorkerProcessObserver } from "../worker-environments/node-worker-process-observation.js";
import { createHarness } from "../worker-environments/placement-dispatch-test-harness.js";
import type { WorkerSessionPlacementStore } from "../worker-environments/placement-store.js";
import { writePlacementEnvironmentFixture } from "../worker-environments/placement-test-fixtures.js";
import { createWorkerSessionPlacementGate } from "../worker-environments/placement-worker-gate.js";
import { createWorkerEnvironmentService } from "../worker-environments/service.js";
import type { createNodeCarrier } from "../worker-environments/skill-resource-transfer.test-support.js";
import { createWorkerEnvironmentStore } from "../worker-environments/store.js";
import type { WorkerTunnelHandle } from "../worker-environments/tunnel-contract.js";
import {
  measureLaunchTurn,
  readLaunchToolNames,
} from "../worker-environments/worker-turn-launcher.test-support.js";
import { captureWorkspaceSnapshot } from "../worker-environments/workspace-manifest-worker.js";
import { serializeWorkerWorkspaceManifest } from "../worker-environments/workspace-manifest.js";
import { requireWorkspaceResultGit } from "../worker-environments/workspace-result-git.js";
import { prepareFailedSourceRecoveryFixture } from "./session-recovery-failed-source.test-support.js";
import { createLateRecoveryResultFixture } from "./session-recovery-late-result.test-support.js";

/** Only the external provider, enrollment, bundle and node transports are synthetic. */
export type RecoveryPreparedScenario = "warm" | "miss" | "unknown-claim" | "target-replaced";

export async function createRecoveryDispatchFixture(params: {
  database: OpenClawStateDatabase;
  placements: WorkerSessionPlacementStore;
  cfg: OpenClawConfig;
  repository: SessionRepositoryWorkspaceRecord;
  tunnel: WorkerTunnelHandle;
  remoteWorkspaceDir: string;
  build: WorkerAdmissionHandshake;
  exactWorkerWorkspace?: Awaited<ReturnType<typeof createNodeCarrier>>;
  preparedScenario?: RecoveryPreparedScenario;
  pendingReclaim?: boolean;
  lateResult?: {
    originalEnvironmentId: string;
    sessionId: string;
    carrier: Awaited<ReturnType<typeof createNodeCarrier>>;
    afterCurrentRead?: () => Promise<void>;
  };
  failedSource?: {
    sessionId: string;
    environmentId: string;
    leaseId: string;
    oldWorkspaceDir: string;
  };
}) {
  const { cfg, database, placements } = params;
  let remoteWorkspaceDir = params.remoteWorkspaceDir;
  cfg.cloudWorkers = {
    profiles: { development: { provider: "crabbox", settings: { region: "test" } } },
  };
  cfg.gateway = {
    ...cfg.gateway,
    nodes: { ...cfg.gateway?.nodes, commands: { allow: ["codex.exec-server.stdio.v1"] } },
  };
  const { nodeRegistry, nodeWorkerSupervisorTransport: transport } = createNodeRegistryRuntime(
    () => new NodeRegistry({ getConfig: () => cfg }),
  );
  const nodeId = "fresh-recovery-node";
  const connId = "fresh-recovery-connection";
  const registerNode = (registeredNodeId: string, registeredConnId: string) => {
    nodeRegistry.register(
      {
        connId: registeredConnId,
        usesSharedGatewayAuth: false,
        socket: {
          readyState: 1,
          bufferedAmount: 0,
          send: vi.fn(),
          close: vi.fn(),
        } as unknown as GatewayWsClient["socket"],
        connect: {
          minProtocol: 1,
          maxProtocol: 1,
          client: {
            id: GATEWAY_CLIENT_IDS.NODE_HOST,
            version: "test",
            platform: "linux",
            mode: GATEWAY_CLIENT_MODES.NODE,
          },
          device: {
            id: registeredNodeId,
            publicKey: "fixture",
            signature: "fixture",
            signedAt: 1,
            nonce: "fixture",
          },
          commands: ["codex.exec-server.stdio.v1"],
        },
      },
      { pairingIdentity: "recovery-node-identity", pairingGeneration: "recovery-node-generation" },
    );
    updateNodeRunnerInventory({
      registry: nodeRegistry,
      nodeId: registeredNodeId,
      connId: registeredConnId,
      declaration: {
        protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
        workerHost: {
          enabled: true,
          capacity: { total: 1, available: 1 },
          environmentSession: NODE_WORKER_ENVIRONMENT_SESSION_VERSION,
          preparedWorkspace: NODE_WORKER_PREPARED_WORKSPACE_VERSION,
          capturedExecPolicy: true,
        },
      },
    });
  };
  registerNode(nodeId, connId);
  if (params.lateResult || params.pendingReclaim) {
    registerNode("synthetic-native-worker", "original-recovery-connection");
  }
  const store = await createWorkerEnvironmentStore({ database });
  const lateResult = params.lateResult
    ? createLateRecoveryResultFixture({ ...params.lateResult, store, placements, transport })
    : undefined;
  const failedRecovery = params.failedSource
    ? await prepareFailedSourceRecoveryFixture({
        cfg,
        placements,
        store,
        repository: params.repository,
        sessionId: params.failedSource.sessionId,
        originalEnvironmentId: params.failedSource.environmentId,
        originalLeaseId: params.failedSource.leaseId,
        oldWorkspaceDir: params.failedSource.oldWorkspaceDir,
        freshWorkspaceDir: remoteWorkspaceDir,
        resolveFreshWorkspaceDir: () => remoteWorkspaceDir,
      })
    : undefined;
  if (params.failedSource) {
    await store.ensureNodeEnrollment(params.failedSource.environmentId);
  }
  const provision = vi.fn<WorkerProvider["provision"]>(async (_profile, operationId, options) => {
    options?.assertCurrent?.();
    if (params.preparedScenario) {
      await options?.beginNodeEnrollment?.();
      options?.assertCurrent?.();
      const enrolling = expectDefined(
        store.list().find((record) => record.provisionOperationId === operationId),
        "enrolling provider operation",
      );
      // The synthetic node pairing result follows the final allocation authority check.
      writePlacementEnvironmentFixture(database, { ...enrolling, nodeDeviceId: nodeId });
    }
    return {
      leaseId: params.preparedScenario ? `lease:${operationId}` : "fresh-recovery-lease",
      node: { deviceId: nodeId },
      sharedHost: false,
    };
  });
  const destroy = vi.fn<WorkerProvider["destroy"]>(async ({ leaseId }) => {
    if (params.preparedScenario === "unknown-claim" && leaseId === warmLeaseId) {
      throw new Error("Synthetic provider cleanup outcome remains unknown");
    }
  });
  let warmEnvironmentId: string | undefined;
  let warmLeaseId: string | undefined;
  let warmReceipt: { environmentId: string; leaseId: string; ownerEpoch: number } | undefined;
  const provider: WorkerProvider = {
    id: "crabbox",
    supportedExecutionModes: ["remote-exec"],
    requiresNodeEnrollment: true,
    provision,
    resolveAllocation: async () => ({ leaseId: "fresh-recovery-lease", sharedHost: false }),
    inspect: async () => ({ status: "active", sharedHost: false }),
    destroy,
    ...(params.preparedScenario
      ? {
          supportsProjectPreparation: () => true,
          resolvePreparationTarget: () => ({ machineClass: "standard", platform: "linux" }),
        }
      : {}),
    ...(failedRecovery
      ? { holdFailedLease: failedRecovery.holdFailedLease, destroy: failedRecovery.destroy }
      : {}),
  };
  const scheduler = createTestGatewayScheduler();
  const service = createWorkerEnvironmentService({
    scheduler,
    placementStore: createWorkerSessionPlacementGate(placements),
    store,
    getConfig: () => cfg,
    resolveProvider: (id) => (id === provider.id ? provider : undefined),
    projectNamespace: "startup-native-recovery",
    ...(params.preparedScenario
      ? {
          resolveStandingImageDemand: () => ({
            profileId: "development",
            executionMode: "remote-exec" as const,
          }),
          prepareNodeArtifacts: async () => ({
            artifacts: {
              nodeBootstrapSha256: "c".repeat(64),
              enabledPluginIds: [],
              workerBundleHash: params.build.bundleHash,
              workerArchiveSha256: "b".repeat(64),
              openclawVersion: params.build.openclawVersion,
              protocolFeatures: params.build.protocolFeatures,
            },
            assertCurrent: () => {},
          }),
        }
      : {}),
    ...(failedRecovery ? { retireNodeEnrollment: failedRecovery.retireNodeEnrollment } : {}),
    prepareInstallation: async () => ({
      install: "bundle",
      ...params.build,
      tarballBytes: 1,
      tarballSha256: "b".repeat(64),
      tarballPath: "/synthetic/worker-bundle.tgz",
    }),
    prepareNodeBootstrap: async () => "c".repeat(64),
    prepareNodeEnrollment: async (record) => {
      if (params.preparedScenario) {
        await store.ensureNodeEnrollment(record.environmentId);
      }
      return {
        mode: "resume",
        deviceId: nodeId,
        gatewayUrl: "wss://gateway.example.test",
        nodeBootstrap: {
          url: "https://gateway.example.test/bootstrap",
          token: "synthetic-bootstrap-token",
          sha256: "c".repeat(64),
          bytes: 1,
          openclawVersion: params.build.openclawVersion,
          enabledPluginIds: [],
        },
        openclawVersion: params.build.openclawVersion,
        displayName: "Synthetic recovery worker",
        waitForDeviceId: async () => nodeId,
      };
    },
    ensureNodeWorkerBundle: async ({ assertCurrent }) => {
      assertCurrent?.();
      return params.build;
    },
    bootstrapWorker: async () => {
      throw new Error("Recovery must use its managed node, not SSH");
    },
    executeInference: async () => ({ type: "error", reason: "cancelled", message: "unused" }),
    nodeTunnelManager: {
      isNodeConnected: async (deviceId) => Boolean(await transport.getCurrentNode(deviceId)),
      observeProcesses:
        lateResult?.manager.observeProcesses ??
        createNodeWorkerProcessObserver({
          gatewayNamespace: "startup-recovery-gateway",
          getEnvironment: (environmentId) => store.get(environmentId),
          getTransport: () => transport,
        }),
      start: async (request) => {
        const actual = await lateResult?.manager.start(request);
        return {
          ...params.tunnel,
          ...(actual ? { runWorkspaceCommand: actual.runWorkspaceCommand } : {}),
          environmentId: request.environmentId,
          ownerEpoch: request.ownerEpoch,
          measureLaunchTurn,
          readLaunchToolNames,
          launchTurn: async () => {
            throw new Error("Remote-exec recovery must not launch an embedded worker turn");
          },
        };
      },
      status: (id) => (lateResult ? lateResult.manager.status(id) : "connected"),
      stop: async (...args) => {
        await lateResult?.manager.stop(...args);
      },
      stopAll: async () => {
        await lateResult?.manager.stopAll();
      },
    },
  });
  const resolveAvailability = async (requestedNode: string) => ({
    available: requestedNode === nodeId,
    node: await transport.getCurrentNode(requestedNode),
  });
  bindDeviceWorkerAvailability(service, resolveAvailability);
  if (!failedRecovery) {
    await fs.writeFile(path.join(remoteWorkspaceDir, "accepted.txt"), "accepted marker");
    await requireWorkspaceResultGit(remoteWorkspaceDir, ["init", "--quiet"]);
    await requireWorkspaceResultGit(remoteWorkspaceDir, ["add", "."]);
    await requireWorkspaceResultGit(remoteWorkspaceDir, [
      "-c",
      "user.name=Recovery Fixture",
      "-c",
      "user.email=recovery@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "accepted source",
    ]);
  }
  const baseCommit =
    failedRecovery?.baseCommit ??
    (await requireWorkspaceResultGit(remoteWorkspaceDir, ["rev-parse", "HEAD"]));
  const base =
    failedRecovery?.base ??
    (await captureWorkspaceSnapshot({ root: remoteWorkspaceDir, baseCommit }));
  let assertDispatchCurrent: (() => void) | undefined;
  params.tunnel.syncWorkspace = async ({ source, sessionId, generation }) => {
    expect(source).toMatchObject({ kind: "repository", url: params.repository.url });
    if (params.exactWorkerWorkspace) {
      const current = expectDefined(placements.get(sessionId), "current syncing placement");
      const environment = expectDefined(
        store.get(expectDefined(current.environmentId, "syncing environment")),
        "exact node workspace owner",
      );
      expect(current).toMatchObject({ state: "syncing", generation, sessionId });
      expectDefined(assertDispatchCurrent, "original workspace preparation authority")();
      remoteWorkspaceDir = await params.exactWorkerWorkspace.bindWorkspace({
        gatewayNamespace: "startup-recovery-gateway",
        environmentId: environment.environmentId,
        sessionId,
        generation: environment.ownerEpoch,
      });
      expectDefined(assertDispatchCurrent, "original workspace preparation authority")();
    }
    if (failedRecovery) {
      await failedRecovery.restoreFreshCheckpoint(() => {
        expectDefined(assertDispatchCurrent, "original dispatch transport authority")();
        expect(placements.get(sessionId)).toMatchObject({ state: "syncing", generation });
      });
    }
    const current = failedRecovery
      ? await captureWorkspaceSnapshot({ root: remoteWorkspaceDir, baseCommit })
      : base;
    return {
      mode: "repository",
      remoteWorkspaceDir,
      baseCommit,
      baseManifestRef: base.manifestRef,
      manifestRef: current.manifestRef,
    };
  };
  const reconcileLocal = params.tunnel.reconcileWorkspace.bind(params.tunnel);
  params.tunnel.reconcileWorkspace = async (request) => {
    if (request.source.kind === "local") {
      return reconcileLocal(request);
    }
    const current = await captureWorkspaceSnapshot({ root: remoteWorkspaceDir, baseCommit });
    const prepared = await request.source.prepareCheckpoint({
      stagingRoot: remoteWorkspaceDir,
      baseManifestRaw: serializeWorkerWorkspaceManifest(base.manifest),
      currentManifestRaw: serializeWorkerWorkspaceManifest(current.manifest),
      baseManifestRef: base.manifestRef,
      currentManifestRef: current.manifestRef,
    });
    return {
      manifestRef: current.manifestRef,
      changed: current.manifestRef !== base.manifestRef,
      verifyStable: async () => {},
      verifyLocalStable: () => prepared.verify(),
      publishStagedResult: async () => {
        await prepared.publish();
      },
      discardPreparedStagedResult: () => prepared.discard(),
    };
  };
  const harness = createHarness(database, placements, {
    environmentService: service,
    resolveWorkspace: async () => ({
      kind: "repository",
      repository: expectDefined(
        await getSessionRepositoryWorkspaceStore().get(params.repository.workspaceId),
        "current repository workspace",
      ),
    }),
    isCurrentNodePlacement: createDevicePlacementAuthority(() => transport),
    ...(failedRecovery ? failedRecovery.recoveryOptions : {}),
  });
  bindDeviceWorkerAvailability(harness.environments, resolveAvailability);
  const credentialErrors: string[] = [];
  const dispatch: typeof harness.service.dispatch = async (...args) => {
    const [request, , authorize] = args;
    if (params.preparedScenario && request.readNativeCredential) {
      const read = request.readNativeCredential;
      request.readNativeCredential = async (env) => {
        try {
          return await read(env);
        } catch (error) {
          credentialErrors.push(error instanceof Error ? error.message : String(error));
          throw error;
        }
      };
    }
    const previous = assertDispatchCurrent;
    assertDispatchCurrent = () => {
      authorize?.();
      if (failedRecovery) {
        expectDefined(
          request.operatorAuthority,
          "original failed-source dispatch issuer",
        ).assertCurrent();
      } else {
        request.operatorAuthority?.assertCurrent();
      }
    };
    try {
      return await harness.service.dispatch(...args);
    } finally {
      assertDispatchCurrent = previous;
    }
  };
  const prepareWarm = async () => {
    if (!params.preparedScenario) {
      return;
    }
    cfg.cloudWorkers!.preparedPool = { maxTotal: 1 };
    await service.setHumanPresence(true);
    const ready = store.list().filter((record) => record.state === "ready" && record.preparation);
    expect(
      ready,
      JSON.stringify(
        store.list().map((record) => ({
          state: record.state,
          preparation: record.preparation,
          error: record.lastError,
        })),
      ),
    ).toHaveLength(1);
    const reserve = ready[0]!;
    expect(readImageReserveProject(reserve.profileSnapshot.project)).toBeDefined();
    warmEnvironmentId = reserve.environmentId;
    warmLeaseId = expectDefined(reserve.leaseId, "ready reserve lease");
    warmReceipt = {
      environmentId: reserve.environmentId,
      leaseId: warmLeaseId,
      ownerEpoch: reserve.ownerEpoch,
    };
    const bind = placements.bindPreparedEnvironment.bind(placements);
    if (params.preparedScenario === "miss" || params.preparedScenario === "unknown-claim") {
      vi.spyOn(placements, "bindPreparedEnvironment").mockImplementation(async (input) => {
        // The external lost reply occurs after the real atomic claim; a CAS miss commits none.
        if (params.preparedScenario === "miss") {
          // A concurrent node-binding publication makes the original exact CAS fail.
          writePlacementEnvironmentFixture(database, {
            ...reserve,
            nodeDeviceId: "retired-reserve-node",
          });
        }
        const claimed = await bind(input);
        if (params.preparedScenario === "unknown-claim") {
          expect(claimed).toMatchObject({
            state: "provisioning",
            environmentId: reserve.environmentId,
          });
          throw new Error("Synthetic committed warm claim reply lost");
        }
        expect(claimed).toBeUndefined();
        return claimed;
      });
    }
  };
  return {
    service,
    lateResult,
    credentialErrors,
    warmReceipt: () => warmReceipt,
    prepareWarm,
    warmEnvironment: () => (warmEnvironmentId ? service.get(warmEnvironmentId) : undefined),
    coldAllocations: () =>
      provision.mock.calls.filter(
        ([, operationId]) =>
          !store
            .list()
            .some((record) => record.provisionOperationId === operationId && record.preparation),
      ).length,
    readWarmClaim: async () => {
      if (!warmEnvironmentId) {
        return undefined;
      }
      const reply = await executeExistingOpenClawStateRead(
        { path: database.path },
        { type: "workerEnvironments.snapshot", ids: [warmEnvironmentId] },
      );
      if (!reply || !reply.ok || reply.type !== "workerEnvironments.snapshot") {
        throw new Error("Committed warm claim readback was unavailable");
      }
      return reply.facts.environments.find((record) => record.environmentId === warmEnvironmentId);
    },
    dispatch,
    provision,
    resolveAvailability,
    recoverFailedPlacement: harness.service.recoverFailedPlacement,
    reconcileFailedPlacement: harness.service.reconcileActive,
    failedRecovery,
    async close() {
      lateResult?.release();
      await service.stop();
      nodeRegistry.unregister(connId);
      nodeRegistry.unregister("original-recovery-connection");
      await scheduler.stop();
      await store.close();
    },
  };
}
