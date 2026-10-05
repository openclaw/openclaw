import { onTestFinished, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import {
  WORKER_EXECUTION_AUTHORITY_PROTOCOL_FEATURE,
  WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
  WORKER_LAUNCH_V2_PROTOCOL_FEATURE,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { getRuntimeConfig } from "../../config/config.js";
import {
  NODE_WORKER_ENVIRONMENT_SESSION_VERSION,
  NODE_WORKER_PREPARED_WORKSPACE_VERSION,
  NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
} from "../../infra/node-runner-inventory.js";
import type { SessionRepositoryWorkspaceRecord } from "../../state/session-repository-workspaces.types.js";
import type { NodeWorkerPreparedWorkspaceResult } from "../../worker/node-workspace-prepared-protocol.js";
import {
  createNodeRegistryRuntime,
  updateNodeRunnerInventory,
  type NodeWorkerSupervisorNodeProof,
} from "../node-registry-private.js";
import { NodeRegistry } from "../node-registry.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import { bindDeviceWorkerAvailability } from "./device-provider.js";
import { MANIFEST_REF, REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import type { WorkerPlacementDispatchOptions } from "./placement-dispatch.types.js";
import type { WorkerPlacementExecutionMode } from "./placement-record.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import {
  readWorkerProjectPreparation,
  type WorkerProviderPreparedIntent,
} from "./preparation-identity.js";
import { createPreparedWorkerPool } from "./prepared-pool.js";
import { createWorkerProviderIntent } from "./provider-intent.js";
import * as repositoryAdmission from "./repository-project-admission.js";
import { deriveEnvironmentIntent } from "./service-contract.js";
import * as support from "./service.test-support.js";
import type { WorkerEnvironmentRecord } from "./store.js";

const PREPARATION_KEY = "c".repeat(64);
export const FEATURES = [
  WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
  WORKER_EXECUTION_AUTHORITY_PROTOCOL_FEATURE,
  WORKER_LAUNCH_V2_PROTOCOL_FEATURE,
];

export async function preparedHarness(
  options: {
    reserve?: boolean;
    protocolFeatures?: string[];
    executionMode?: WorkerPlacementExecutionMode;
    repository?: SessionRepositoryWorkspaceRecord;
    reserveBaseCommit?: string;
    reserveSourceUrl?: string;
    imageReserve?: boolean;
    prepareRepositoryRefRecovery?: WorkerPlacementDispatchOptions["prepareRepositoryRefRecovery"];
    resolveWorkspace?: WorkerPlacementDispatchOptions["resolveWorkspace"];
    boundWorkspace?: Pick<
      NodeWorkerPreparedWorkspaceResult,
      "workspaceDir" | "sourceManifestRef" | "preparedManifestRef"
    >;
    seeded?: {
      intent: WorkerProviderPreparedIntent;
      ready: WorkerEnvironmentRecord[];
      candidates: (intent: WorkerProviderPreparedIntent) => WorkerEnvironmentRecord[];
    };
  } = {},
) {
  const protocolFeatures = options.protocolFeatures ?? FEATURES;
  const executionMode = options.executionMode ?? "worker-turn";
  const reserve = options.reserve !== false;
  let nodeCurrent = true;
  const placements = createWorkerSessionPlacementStore({
    database: support.testState.stateDb,
    now: () => support.testState.nowMs,
  });
  const harness = createHarness(support.testState.stateDb, placements, {
    prepareRepositoryRefRecovery: options.prepareRepositoryRefRecovery,
    ...(options.repository
      ? {
          requiresNodeEnrollment: true,
          resolveWorkspace: async () => ({ kind: "repository", repository: options.repository! }),
        }
      : {}),
    ...(options.resolveWorkspace ? { resolveWorkspace: options.resolveWorkspace } : {}),
    isCurrentNodePlacement: (proof, requirement, mode) =>
      nodeCurrent &&
      transport.isCurrent(
        proof,
        requirement.consumesWorkerSlot,
        requirement.requiredNodeCommands,
        mode === "worker-turn",
      ),
  });
  const environmentId =
    options.seeded?.ready[0]?.environmentId ??
    (reserve ? "prepared-spare" : harness.ready.environmentId);
  const defaultIntent: WorkerProviderPreparedIntent = {
    providerId: "fake",
    preparationKey: PREPARATION_KEY,
    profileSnapshot: {
      settings: { region: "test" },
      executionMode,
      project: {
        key: "d".repeat(64),
        baseCommit: options.reserveBaseCommit ?? options.repository?.baseCommit ?? "e".repeat(40),
        ...(options.repository
          ? {
              source: {
                kind: "repository",
                url: options.reserveSourceUrl ?? options.repository.url,
                repositoryId: "R_dispatch_fixture",
                owner: {
                  agent: { agentId: REQUEST.agentId, provenance: null },
                  identity: { source: "anonymous" },
                },
              },
            }
          : { root: "/gateway/workspace" }),
        preparation: {
          key: PREPARATION_KEY,
          cacheKey: "a".repeat(64),
          contractVersion: 1,
          target: { machineClass: "standard", platform: "linux", arch: "x64" },
          artifacts: {
            nodeBootstrapSha256: "f".repeat(64),
            enabledPluginIds: [],
            workerBundleHash: support.BUNDLE_HASH,
            workerArchiveSha256: "b".repeat(64),
            openclawVersion: support.BOOTSTRAP_RECEIPT.openclawVersion,
            protocolFeatures,
          },
        },
      },
    },
  };
  const intent = options.seeded?.intent ?? defaultIntent;
  const storedProfile = options.imageReserve
    ? {
        ...intent.profileSnapshot,
        project: {
          kind: "image" as const,
          key: "f".repeat(64),
          preparation: {
            ...readWorkerProjectPreparation(intent.profileSnapshot.project)!,
            key: "b".repeat(64),
          },
        },
      }
    : intent.profileSnapshot;
  const store = support.testState.store;
  let ready = options.seeded?.ready[0];
  const createReady = async (readyEnvironmentId: string) => {
    await store.createIntent({
      environmentId: readyEnvironmentId,
      profileId: REQUEST.profileId,
      providerId: intent.providerId,
      profileSnapshot: storedProfile,
      provisionOperationId: `provision:${readyEnvironmentId}`,
      ...(reserve
        ? {
            preparation: {
              purpose: "reserve",
              key: options.imageReserve ? "b".repeat(64) : PREPARATION_KEY,
              demandAtMs: 900,
              expiresAtMs: 10_000,
            },
          }
        : {}),
    });
    await store.transition({
      environmentId: readyEnvironmentId,
      from: "requested",
      to: "provisioning",
    });
    const created = await store.transition({
      environmentId: readyEnvironmentId,
      from: "provisioning",
      to: "ready",
      patch: {
        leaseId: `lease:${readyEnvironmentId}`,
        nodeDeviceId: "prepared-node",
        sharedHost: false,
        ...support.readyPatch(readyEnvironmentId, {
          ...support.BOOTSTRAP_RECEIPT,
          protocolFeatures,
        }),
      },
    });
    return created;
  };
  if (!ready) {
    ready = await createReady(environmentId);
  }
  vi.mocked(support.testState.prepareInstallation).mockResolvedValue({
    ...support.BUNDLE_ARTIFACT,
    protocolFeatures,
  });
  const workerService = support.createService(support.createProvider());
  const projected = workerService.get(environmentId)!;
  const ordinaryGet = vi.mocked(harness.environments.get).getMockImplementation()!;
  vi.mocked(harness.environments.get).mockImplementation(
    (id) => workerService.get(id) ?? ordinaryGet(id),
  );
  vi.mocked(harness.environments.prepareProjectIntent).mockResolvedValue(intent);
  vi.mocked(harness.environments.getPreparedCandidates).mockImplementation((requestedIntent) =>
    options.seeded
      ? options.seeded
          .candidates(requestedIntent)
          .map((candidate) => workerService.get(candidate.environmentId))
          .filter((candidate) => candidate !== undefined)
      : reserve
        ? [projected]
        : [],
  );
  const ordinaryAttach = vi.mocked(harness.environments.attachSession).getMockImplementation()!;
  vi.mocked(harness.environments.attachSession).mockImplementation(async (request) => {
    const credential = workerService.get(request.environmentId)
      ? await workerService.attachSession(request)
      : undefined;
    const ordinary = await ordinaryAttach(request);
    return credential ?? ordinary;
  });
  const ordinaryDestroy = vi.mocked(harness.environments.destroy).getMockImplementation()!;
  vi.mocked(harness.environments.destroy).mockImplementation(async (id) =>
    workerService.get(id) ? await workerService.destroy(id) : await ordinaryDestroy(id),
  );
  const ordinaryTunnel = vi.mocked(harness.environments.startTunnel).getMockImplementation()!;
  vi.mocked(harness.environments.startTunnel).mockImplementation(async (request) => {
    const tunnel = await ordinaryTunnel(request);
    return {
      ...tunnel,
      environmentId: request.environmentId,
      ...(options.imageReserve
        ? {
            syncWorkspace: async (input: Parameters<typeof tunnel.syncWorkspace>[0]) => ({
              ...(await tunnel.syncWorkspace(input)),
              mode: "repository" as const,
              baseCommit: "e".repeat(40),
              baseManifestRef: MANIFEST_REF,
              manifestRef: MANIFEST_REF,
              remoteWorkspaceDir: "/worker/repository",
            }),
            reconcileWorkspace: async () => ({
              manifestRef: MANIFEST_REF,
              changed: false,
              verifyStable: async () => {},
              verifyLocalStable: async () => {},
              publishStagedResult: async () => {},
              discardPreparedStagedResult: async () => {},
            }),
          }
        : {}),
    };
  });
  const bindPreparedWorkspace = vi.mocked(harness.environments.bindPreparedWorkspace);
  const ordinaryBind = bindPreparedWorkspace.getMockImplementation()!;
  bindPreparedWorkspace.mockImplementation(async (request) => {
    request.assertCurrent();
    harness.log.push("workspace:bind-prepared");
    return { ...(await ordinaryBind(request)), ...options.boundWorkspace };
  });
  if (!reserve) {
    vi.mocked(harness.environments.createWithRequest).mockImplementation(async (request) => {
      const expected = deriveEnvironmentIntent(request.idempotencyKey).environmentId;
      if (!workerService.get(expected)) {
        await createReady(expected);
      }
      return workerService.get(expected)!;
    });
  }
  const node: NodeWorkerSupervisorNodeProof = {
    nodeId: "prepared-node",
    connId: "prepared-connection",
    pairingIdentity: "prepared-identity",
    pairingGeneration: "prepared-generation",
    clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
    clientMode: GATEWAY_CLIENT_MODES.NODE,
    protocolFeature: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
    workerHost: {
      enabled: true,
      capacity: { total: 1, available: 1 },
      environmentSession: NODE_WORKER_ENVIRONMENT_SESSION_VERSION,
      preparedWorkspace: NODE_WORKER_PREPARED_WORKSPACE_VERSION,
      capturedExecPolicy: true,
      promptContext: 1,
    },
    commands: ["codex.exec-server.stdio.v1"],
  };
  const { nodeRegistry, nodeWorkerSupervisorTransport: transport } = createNodeRegistryRuntime(
    () => new NodeRegistry({ getConfig: getRuntimeConfig }),
  );
  const connectNode = () =>
    nodeRegistry.register(
      {
        connId: node.connId,
        usesSharedGatewayAuth: false,
        socket: {
          readyState: 1,
          bufferedAmount: 0,
          send: vi.fn(),
          close: vi.fn(),
          // SAFETY: NodeRegistry fixtures use only readyState, bufferedAmount, send, and close; no native WebSocket transport methods run.
        } as unknown as GatewayWsClient["socket"],
        connect: {
          minProtocol: 1,
          maxProtocol: 1,
          client: { id: node.clientId, version: "test", platform: "linux", mode: node.clientMode },
          device: {
            id: node.nodeId,
            publicKey: "fixture",
            signature: "fixture",
            signedAt: 1,
            nonce: "fixture",
          },
          commands: [...node.commands],
        },
      },
      { pairingIdentity: node.pairingIdentity, pairingGeneration: node.pairingGeneration },
    );
  const setHostingAvailable = (available: boolean, reconnect = false) => {
    if (reconnect) {
      node.connId = "reconnected-without-hosting";
      connectNode();
    }
    updateNodeRunnerInventory({
      registry: nodeRegistry,
      nodeId: node.nodeId,
      connId: node.connId,
      declaration: {
        protocolFeatures: [node.protocolFeature],
        workerHost: available ? node.workerHost : { enabled: false },
      },
    });
  };
  connectNode();
  setHostingAvailable(true);
  onTestFinished(() => {
    nodeRegistry.unregister(node.connId);
  });
  const resolveAvailability = vi.fn(async () => ({
    available: true,
    node: (await transport.listCurrentNodes())[0],
  }));
  bindDeviceWorkerAvailability(harness.environments, resolveAvailability);
  const request = {
    ...REQUEST,
    executionMode,
    setupAuthorized: true,
    devicePlacement: {
      requiredNodeCommands: executionMode === "remote-exec" ? ["codex.exec-server.stdio.v1"] : [],
      consumesWorkerSlot: executionMode === "worker-turn",
    },
  };
  return {
    harness,
    placements,
    store,
    workerService,
    ready,
    intent,
    request,
    transport,
    resolveAvailability,
    setHostingAvailable,
    revokeNode: () => {
      nodeCurrent = false;
    },
  };
}

export async function presencePreparedReserves(repository: SessionRepositoryWorkspaceRecord) {
  const repositoryProject = {
    key: "d".repeat(64),
    baseCommit: "e".repeat(40),
    source: {
      kind: "repository" as const,
      url: repository.url,
      repositoryId: "R_example_project",
      owner: {
        agent: { agentId: REQUEST.agentId, provenance: null },
        identity: { source: "anonymous" as const },
      },
    },
  };
  const admittedRepository = {
    project: repositoryProject,
    setupRecipe: undefined,
    assertCurrent: () => {},
    revalidate: async () => {},
  };
  const admission = vi
    .spyOn(repositoryAdmission, "prepareRepositoryWorkerProjectSource")
    .mockResolvedValue(admittedRepository);
  onTestFinished(() => admission.mockRestore());

  const provider = support.createProvider({
    requiresNodeEnrollment: true,
    supportsProjectPreparation: () => true,
    resolvePreparationTarget: (_profile, machineClass, os) => ({
      machineClass: machineClass ?? "small",
      platform: os ?? "linux",
    }),
  });
  const artifacts = {
    nodeBootstrapSha256: "f".repeat(64),
    enabledPluginIds: [],
    workerBundleHash: support.BUNDLE_HASH,
    workerArchiveSha256: "b".repeat(64),
    openclawVersion: support.BOOTSTRAP_RECEIPT.openclawVersion,
    protocolFeatures: FEATURES,
  };
  const intentOwner = createWorkerProviderIntent({
    store: support.testState.store,
    getConfig: () => support.testState.config,
    projectNamespace: "gateway-test",
    providerFor: () => provider,
    isStopping: () => false,
    withLock: async (_id, task) => task(),
    resumeProvision: async () => {
      throw new Error("Unexpected cold provider create");
    },
    prepareNodeArtifacts: async () => ({ artifacts, assertCurrent: () => {} }),
  });
  const intent = await intentOwner.prepareIntent(REQUEST.profileId, {
    executionMode: "remote-exec",
    repository: { agentId: REQUEST.agentId, url: repository.url, ref: "main" },
  });
  support.getDevelopmentProfile().readyWorkers = 3;
  support.testState.config.cloudWorkers!.preparedPool = { maxTotal: 3 };
  const abort = new AbortController();
  onTestFinished(() => abort.abort());
  let demand: Parameters<
    NonNullable<Parameters<typeof createPreparedWorkerPool>[0]["presenceDemandStore"]>["write"]
  >[0] = null;
  const pool = createPreparedWorkerPool({
    store: support.testState.store,
    getConfig: () => support.testState.config,
    resolveProvider: () => support.createProvider(),
    prepareIntent: intentOwner.prepareIntent,
    assertIntentCurrent: intentOwner.assertPreparedIntentCurrent,
    prepareRetention: async () => ({ isCurrent: () => true }),
    reconcile: async () => {},
    now: () => support.testState.nowMs,
    signal: abort.signal,
    warn: vi.fn(),
    resolveHumanPresenceDemand: () => ({
      profileId: REQUEST.profileId,
      executionMode: "remote-exec",
      repository: { agentId: REQUEST.agentId, url: repository.url, ref: "main" },
    }),
    presenceDemandStore: {
      read: async () => demand ?? undefined,
      write: async (value, assertCurrent) => {
        assertCurrent();
        demand = value;
        return value ?? undefined;
      },
    },
  });
  await pool.setHumanPresence(true);
  const ready = await Promise.all(
    support.testState.store
      .list()
      .filter((record) => record.preparation?.consumedAtMs === null)
      .map(async (record, index) => {
        await support.testState.store.transition({
          environmentId: record.environmentId,
          from: "requested",
          to: "provisioning",
        });
        return support.testState.store.transition({
          environmentId: record.environmentId,
          from: "provisioning",
          to: "ready",
          patch: {
            leaseId: `lease:${record.environmentId}`,
            nodeDeviceId: index === 0 ? "prepared-node" : `unused-node-${index}`,
            sharedHost: false,
            ...support.readyPatch(record.environmentId, {
              ...support.BOOTSTRAP_RECEIPT,
              protocolFeatures: FEATURES,
            }),
          },
        });
      }),
  );
  return {
    intentOwner,
    intent,
    pool,
    ready,
    artifacts,
    repositoryProject,
    admittedRepository,
    admission,
  };
}
