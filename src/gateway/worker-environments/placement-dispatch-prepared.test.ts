import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { getRuntimeConfig } from "../../config/config.js";
import {
  NODE_WORKER_ENVIRONMENT_SESSION_VERSION,
  NODE_WORKER_PREPARED_WORKSPACE_VERSION,
  NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
} from "../../infra/node-runner-inventory.js";
import {
  getSessionRepositoryWorkspaceStore,
  type SessionRepositoryWorkspaceRecord,
} from "../../state/session-repository-workspaces.js";
import type { NodeWorkerPreparedWorkspaceResult } from "../../worker/node-workspace-prepared-protocol.js";
import {
  createNodeRegistryRuntime,
  updateNodeRunnerInventory,
  type NodeWorkerSupervisorNodeProof,
} from "../node-registry-private.js";
import { NodeRegistry } from "../node-registry.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import { bindDeviceWorkerAvailability } from "./device-provider.js";
import { REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import type { WorkerPlacementExecutionMode } from "./placement-record.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import type { WorkerProviderPreparedIntent } from "./preparation-identity.js";
import * as support from "./service.test-support.js";
import {
  readSessionRepositoryCheckpoint,
  stageSessionRepositoryCheckpoint,
} from "./session-repository-checkpoints.js";
import { prepareWorkerGitHubBinding } from "./worker-github-binding.js";
import { serializeWorkerWorkspaceManifest } from "./workspace-manifest.js";
import { readActualWorkspaceManifest } from "./workspace-reconcile-core.js";
import { requireWorkspaceResultGit } from "./workspace-result-git.js";

vi.mock("./worker-github-binding.js", () => ({ prepareWorkerGitHubBinding: vi.fn() }));

vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  getRuntimeConfig: () => ({
    gateway: { nodes: { commands: { allow: ["codex.exec-server.stdio.v1"] } } },
  }),
}));

const PREPARATION_KEY = "c".repeat(64);
const FEATURES = [WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE];

function preparedHarness(
  options: {
    reserve?: boolean;
    executionMode?: WorkerPlacementExecutionMode;
    liveBindingFails?: boolean;
    repository?: SessionRepositoryWorkspaceRecord;
    boundWorkspace?: Pick<
      NodeWorkerPreparedWorkspaceResult,
      "workspaceDir" | "sourceManifestRef" | "preparedManifestRef"
    >;
  } = {},
) {
  const executionMode = options.executionMode ?? "worker-turn";
  const reserve = options.reserve !== false;
  let nodeCurrent = true;
  const placements = createWorkerSessionPlacementStore({
    database: support.testState.stateDb,
    now: () => support.testState.nowMs,
  });
  const harness = createHarness(support.testState.stateDb, placements, {
    ...(options.repository
      ? {
          requiresNodeEnrollment: true,
          resolveWorkspace: async () => ({ kind: "repository", repository: options.repository! }),
        }
      : {}),
    isCurrentNodePlacement: (proof, requirement) =>
      nodeCurrent &&
      transport.isCurrent(proof, requirement.consumesWorkerSlot, requirement.requiredNodeCommands),
  });
  const environmentId = reserve ? "prepared-spare" : harness.ready.environmentId;
  const intent: WorkerProviderPreparedIntent = {
    providerId: "fake",
    preparationKey: PREPARATION_KEY,
    profileSnapshot: {
      settings: { region: "test" },
      executionMode,
      project: {
        key: "d".repeat(64),
        baseCommit: options.repository?.baseCommit ?? "e".repeat(40),
        ...(options.repository
          ? {
              source: {
                kind: "repository",
                url: options.repository.url,
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
            protocolFeatures: FEATURES,
          },
        },
      },
    },
  };
  const store = support.testState.store;
  store.createIntent({
    environmentId,
    profileId: REQUEST.profileId,
    providerId: intent.providerId,
    profileSnapshot: intent.profileSnapshot,
    provisionOperationId: `provision:${environmentId}`,
    ...(reserve
      ? {
          preparation: {
            purpose: "reserve",
            key: PREPARATION_KEY,
            demandAtMs: 900,
            expiresAtMs: 10_000,
          },
        }
      : {}),
  });
  store.transition({ environmentId, from: "requested", to: "provisioning" });
  const ready = store.transition({
    environmentId,
    from: "provisioning",
    to: "ready",
    patch: {
      leaseId: `lease:${environmentId}`,
      nodeDeviceId: "prepared-node",
      sharedHost: false,
      ...support.readyPatch(environmentId, {
        ...support.BOOTSTRAP_RECEIPT,
        protocolFeatures: FEATURES,
      }),
    },
  });
  vi.mocked(support.testState.prepareInstallation).mockResolvedValue({
    ...support.BUNDLE_ARTIFACT,
    protocolFeatures: FEATURES,
  });
  const liveEvents = support.createLiveEvents({
    bindSession: vi.fn(() => !options.liveBindingFails),
  });
  const workerService = support.createService(support.createProvider(), { liveEvents });
  const projected = workerService.get(environmentId)!;
  const ordinaryGet = vi.mocked(harness.environments.get).getMockImplementation()!;
  vi.mocked(harness.environments.get).mockImplementation(
    (id) => workerService.get(id) ?? ordinaryGet(id),
  );
  vi.mocked(harness.environments.prepareProjectIntent).mockResolvedValue(intent);
  vi.mocked(harness.environments.getPreparedCandidates).mockReturnValue(reserve ? [projected] : []);
  const ordinaryAttach = vi.mocked(harness.environments.attachSession).getMockImplementation()!;
  vi.mocked(harness.environments.attachSession).mockImplementation(async (request) => {
    const credential =
      request.environmentId === environmentId
        ? await workerService.attachSession(request)
        : undefined;
    const ordinary = await ordinaryAttach(request);
    return credential ?? ordinary;
  });
  const ordinaryDestroy = vi.mocked(harness.environments.destroy).getMockImplementation()!;
  vi.mocked(harness.environments.destroy).mockImplementation(async (id) =>
    id === environmentId ? await workerService.destroy(id) : await ordinaryDestroy(id),
  );
  const ordinaryTunnel = vi.mocked(harness.environments.startTunnel).getMockImplementation()!;
  vi.mocked(harness.environments.startTunnel).mockImplementation(async (request) => ({
    ...(await ordinaryTunnel(request)),
    environmentId: request.environmentId,
  }));
  const bindPreparedWorkspace = vi.mocked(harness.environments.bindPreparedWorkspace);
  const ordinaryBind = bindPreparedWorkspace.getMockImplementation()!;
  bindPreparedWorkspace.mockImplementation(async (request) => {
    request.assertCurrent();
    harness.log.push("workspace:bind-prepared");
    return { ...(await ordinaryBind(request)), ...options.boundWorkspace };
  });
  if (!reserve) {
    vi.mocked(harness.environments.create).mockResolvedValue(projected);
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
    liveEvents,
    transport,
    resolveAvailability,
    setHostingAvailable,
    revokeNode: () => {
      nodeCurrent = false;
    },
  };
}

describe("prepared worker dispatch", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it.each(["worker-turn", "remote-exec"] as const)(
    "consumes the existing environment and binds its workspace for %s",
    async (executionMode) => {
      const { harness, placements, store, ready, request } = preparedHarness({ executionMode });
      vi.mocked(harness.environments.schedulePreparedRefill).mockImplementation(() => {
        expect(placements.get(request.sessionId)?.state).toBe("active");
        throw new Error("refill scheduling failed");
      });

      const active = await harness.service.dispatch(request);

      expect(active).toMatchObject({
        state: "active",
        environmentId: ready.environmentId,
        executionMode,
      });
      expect(harness.environments.create).not.toHaveBeenCalled();
      expect(harness.environments.createFromProfileSnapshot).not.toHaveBeenCalled();
      expect(store.get(ready.environmentId)?.preparation?.consumedAtMs).toBe(1_000);
      expect(store.getCredential(ready.environmentId)).toMatchObject({
        sessionId: request.sessionId,
        ownerEpoch: active.activeOwnerEpoch,
      });
      expect(harness.log.indexOf("workspace:bind-prepared")).toBeLessThan(
        harness.log.indexOf("sync"),
      );
      expect(harness.environments.schedulePreparedRefill).toHaveBeenCalledWith(ready.environmentId);
      const tunnel = await vi.mocked(harness.environments.startTunnel).mock.results[0]?.value;
      expect(tunnel?.syncWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ sessionKey: request.sessionKey }),
      );
    },
  );

  it("binds a freshly prepared cold workspace without turning its ordinary row into a reserve", async () => {
    const { harness, store, ready, intent, request } = preparedHarness({ reserve: false });

    const active = await harness.service.dispatch(request);

    expect(active.environmentId).toBe(ready.environmentId);
    expect(harness.environments.create).toHaveBeenCalledWith(
      request.profileId,
      expect.any(String),
      undefined,
      request.executionMode,
      "/gateway/workspace",
      undefined,
      undefined,
      undefined,
      intent,
    );
    expect(store.get(ready.environmentId)?.preparation).toBeNull();
    expect(harness.environments.bindPreparedWorkspace).toHaveBeenCalledOnce();
    expect(harness.log.indexOf("workspace:bind-prepared")).toBeLessThan(
      harness.log.indexOf("sync"),
    );
  });

  it.each(["build", "node"] as const)(
    "uses the cold path when a candidate's %s proof is stale",
    async (stale) => {
      const { harness, store, ready, request, revokeNode } = preparedHarness();
      if (stale === "build") {
        const environment = harness.environments.get(ready.environmentId)!;
        vi.mocked(harness.environments.getPreparedCandidates).mockReturnValue([
          {
            ...environment,
            bootstrapReceipt: { ...ready.bootstrapReceipt!, bundleHash: "9".repeat(64) },
          },
        ]);
      } else {
        revokeNode();
      }

      const active = await harness.service.dispatch(request);

      expect(active.environmentId).toBe(harness.ready.environmentId);
      expect(active.environmentId).not.toBe(ready.environmentId);
      expect(harness.environments.create).toHaveBeenCalledOnce();
      expect(store.get(ready.environmentId)?.preparation?.consumedAtMs).toBeNull();
      expect(harness.environments.bindPreparedWorkspace).not.toHaveBeenCalled();
    },
  );

  it.each([
    { executionMode: "worker-turn", reconnect: false },
    { executionMode: "remote-exec", reconnect: false },
    { executionMode: "worker-turn", reconnect: true },
    { executionMode: "remote-exec", reconnect: true },
  ] as const)(
    "keeps a $executionMode reserve unconsumed after session hosting is disabled (reconnect=$reconnect)",
    async ({ executionMode, reconnect }) => {
      const { harness, store, ready, request, setHostingAvailable } = preparedHarness({
        executionMode,
      });
      setHostingAvailable(false, reconnect);

      const active = await harness.service.dispatch(request);

      expect(active.environmentId).toBe(harness.ready.environmentId);
      expect(harness.environments.create).toHaveBeenCalledOnce();
      expect(store.get(ready.environmentId)?.preparation?.consumedAtMs).toBeNull();
      expect(store.getCredential(ready.environmentId)?.sessionId).toBeNull();
      expect(harness.environments.bindPreparedWorkspace).not.toHaveBeenCalled();
    },
  );

  it.each(["worker-turn", "remote-exec"] as const)(
    "does not consume a %s reserve when session hosting is disabled during admission",
    async (executionMode) => {
      const {
        harness,
        store,
        ready,
        request,
        transport,
        resolveAvailability,
        setHostingAvailable,
      } = preparedHarness({ executionMode });
      const admitted = createDeferred();
      const release = createDeferred();
      resolveAvailability.mockImplementationOnce(async () => {
        const [node] = await transport.listCurrentNodes();
        admitted.resolve();
        await release.promise;
        return { available: true, node };
      });
      const dispatch = harness.service.dispatch(request);
      try {
        await admitted.promise;
        setHostingAvailable(false);
        release.resolve();
        const active = await dispatch;

        expect(active.environmentId).toBe(harness.ready.environmentId);
        expect(harness.environments.create).toHaveBeenCalledOnce();
        expect(store.get(ready.environmentId)?.preparation?.consumedAtMs).toBeNull();
        expect(store.getCredential(ready.environmentId)?.sessionId).toBeNull();
        expect(harness.environments.bindPreparedWorkspace).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await dispatch;
      }
    },
  );

  it("does not mint attachment authority after request revocation during build validation", async () => {
    const { harness, store, ready, request, liveEvents } = preparedHarness();
    let authorized = true;
    vi.mocked(support.testState.prepareInstallation).mockImplementation(async () => {
      authorized = false;
      return { ...support.BUNDLE_ARTIFACT, protocolFeatures: FEATURES };
    });

    await expect(
      harness.service.dispatch(request, undefined, () => {
        if (!authorized) {
          throw new Error("request revoked");
        }
      }),
    ).rejects.toThrow("request revoked");

    expect(liveEvents.bindSession).not.toHaveBeenCalled();
    expect(store.get(ready.environmentId)?.preparation?.consumedAtMs).toBe(1_000);
    expect(harness.environments.startTunnel).not.toHaveBeenCalled();
    expect(harness.environments.destroy).toHaveBeenCalledWith(ready.environmentId);
  });

  it("uses the cold path when pool policy removes a candidate during node admission", async () => {
    const { harness, store, ready, request } = preparedHarness();
    const candidates = vi.mocked(harness.environments.getPreparedCandidates);
    const selected = candidates.getMockImplementation()!;
    candidates.mockImplementationOnce(selected).mockReturnValue([]);

    const active = await harness.service.dispatch(request);

    expect(active.environmentId).toBe(harness.ready.environmentId);
    expect(harness.environments.create).toHaveBeenCalledOnce();
    expect(store.get(ready.environmentId)?.preparation?.consumedAtMs).toBeNull();
    expect(harness.environments.bindPreparedWorkspace).not.toHaveBeenCalled();
  });

  it("rejects direct attachment without the prepared placement reservation", async () => {
    const { store, workerService, ready, request, liveEvents } = preparedHarness();

    await expect(
      workerService.attachSession({
        environmentId: ready.environmentId,
        ownerEpoch: ready.ownerEpoch,
        sessionId: request.sessionId,
      }),
    ).rejects.toThrow("placement reservation");

    expect(store.get(ready.environmentId)).toMatchObject({
      state: "ready",
      preparation: { consumedAtMs: null },
    });
    expect(store.getCredential(ready.environmentId)?.sessionId).toBeNull();
    expect(liveEvents.bindSession).not.toHaveBeenCalled();
  });

  it("fences a profile change after node eligibility before consuming its reserve", async () => {
    const { harness, store, ready, request } = preparedHarness();
    vi.mocked(harness.environments.assertPreparedIntentCurrent)
      .mockImplementationOnce(() => {})
      .mockImplementation(() => {
        throw new Error("profile changed");
      });

    await expect(harness.service.dispatch(request)).rejects.toThrow("profile changed");

    expect(store.get(ready.environmentId)?.preparation?.consumedAtMs).toBeNull();
    expect(harness.environments.attachSession).not.toHaveBeenCalled();
    expect(harness.environments.create).not.toHaveBeenCalled();
  });

  it("cannot recycle a consumed environment after live attachment rollback", async () => {
    const { harness, store, ready, request, workerService } = preparedHarness({
      liveBindingFails: true,
    });

    await expect(harness.service.dispatch(request)).rejects.toThrow(
      "Attached session target is unavailable",
    );

    expect(store.get(ready.environmentId)?.preparation?.consumedAtMs).toBe(1_000);
    expect(
      workerService.getPreparedCandidates({
        providerId: ready.providerId,
        profileSnapshot: ready.profileSnapshot,
        preparationKey: PREPARATION_KEY,
      }),
    ).toEqual([]);
    expect(harness.environments.bindPreparedWorkspace).not.toHaveBeenCalled();
  });

  it("fences workspace upload when node authority closes during prepared binding", async () => {
    const { harness, store, ready, request, revokeNode } = preparedHarness();
    const bind = vi.mocked(harness.environments.bindPreparedWorkspace);
    const ordinaryBind = bind.getMockImplementation()!;
    bind.mockImplementation(async (binding) => {
      const prepared = await ordinaryBind(binding);
      revokeNode();
      return prepared;
    });

    await expect(harness.service.dispatch(request)).rejects.toThrow("node authority");

    expect(harness.log).not.toContain("sync");
    expect(store.get(ready.environmentId)?.preparation?.consumedAtMs).toBe(1_000);
    expect(harness.environments.destroy).toHaveBeenCalledWith(ready.environmentId);
    expect(harness.environments.schedulePreparedRefill).not.toHaveBeenCalled();
  });
  it.each([true, false])(
    "claims a repository-only reserve with setup %s and overlays its accepted checkpoint on the bound source",
    async (runSetupScript) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", support.testState.root);
      onTestFinished(() => {
        vi.unstubAllEnvs();
      });
      vi.mocked(prepareWorkerGitHubBinding).mockResolvedValue(undefined);
      const stagingRoot = path.join(support.testState.root, "checkpoint-source");
      await fs.mkdir(stagingRoot);
      await fs.writeFile(path.join(stagingRoot, "tracked.txt"), "pinned source\n");
      await requireWorkspaceResultGit(stagingRoot, ["init", "--quiet"]);
      await requireWorkspaceResultGit(stagingRoot, ["add", "."]);
      await requireWorkspaceResultGit(stagingRoot, [
        "-c",
        "user.name=Dispatch Fixture",
        "-c",
        "user.email=dispatch@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--quiet",
        "-m",
        "source",
      ]);
      const baseCommit = await requireWorkspaceResultGit(stagingRoot, ["rev-parse", "HEAD"]);
      const base = await readActualWorkspaceManifest({ root: stagingRoot, baseCommit });
      await fs.writeFile(path.join(stagingRoot, "session.txt"), "accepted session change\n");
      const current = await readActualWorkspaceManifest({ root: stagingRoot, baseCommit });
      const repositoryStore = getSessionRepositoryWorkspaceStore();
      expect(repositoryStore.path).toBe(support.testState.stateDb.path);
      const created = repositoryStore.create({
        agentId: REQUEST.agentId,
        sessionKey: REQUEST.sessionKey,
        url: "https://github.com/example/project.git",
        requestedRef: "refs/heads/main",
        runSetupScript: true,
        assertCurrent: () => {},
      });
      const pinned = repositoryStore.bindBase({
        workspaceId: created.workspaceId,
        expectedRevision: created.revision,
        baseCommit,
        baseManifestHash: base.manifestRef,
        assertCurrent: () => {},
      });
      const staged = await stageSessionRepositoryCheckpoint({
        workspaceId: pinned.workspaceId,
        expectedRevision: pinned.revision,
        stagingRoot,
        baseManifestRaw: serializeWorkerWorkspaceManifest(base.manifest),
        currentManifestRaw: serializeWorkerWorkspaceManifest(current.manifest),
        baseManifestRef: base.manifestRef,
        currentManifestRef: current.manifestRef,
        assertCurrent: () => {},
      });
      try {
        await staged.publish();
      } finally {
        await staged.discard();
      }
      const accepted = repositoryStore.get(created.workspaceId)!;
      const boundWorkspace = {
        workspaceDir: "/worker/prepared/project",
        sourceManifestRef: base.manifestRef,
        preparedManifestRef: base.manifestRef,
      };
      const { harness, store, ready, request } = preparedHarness({
        repository: accepted,
        boundWorkspace,
      });
      const startTunnel = vi.mocked(harness.environments.startTunnel);
      const ordinaryTunnel = startTunnel.getMockImplementation()!;
      startTunnel.mockImplementation(async (params) => {
        const tunnel = await ordinaryTunnel(params);
        vi.spyOn(tunnel, "syncWorkspace").mockImplementation(async ({ source }) => {
          harness.log.push("sync");
          expect(source).toMatchObject({
            kind: "repository",
            url: accepted.url,
            ref: accepted.requestedRef,
            branch: accepted.branch,
            baseCommit,
            runSetupScript: false,
            prepared: { ...boundWorkspace, baseCommit },
          });
          if (source.kind !== "repository" || !source.checkpoint) {
            throw new Error("Prepared dispatch lost its accepted repository checkpoint");
          }
          expect(
            await fs.readFile(path.join(source.checkpoint.stagingRoot, "session.txt"), "utf8"),
          ).toBe("accepted session change\n");
          return {
            mode: "repository",
            remoteWorkspaceDir: boundWorkspace.workspaceDir,
            baseCommit,
            baseManifestRef: base.manifestRef,
            manifestRef: current.manifestRef,
          };
        });
        return tunnel;
      });

      const active = await harness.service.dispatch({ ...request, runSetupScript });

      expect(harness.environments.prepareProjectIntent).toHaveBeenCalledWith(request.profileId, {
        machineClass: undefined,
        os: undefined,
        executionMode: request.executionMode,
        projectPath: undefined,
        repository: {
          agentId: request.agentId,
          url: accepted.url,
          ref: accepted.requestedRef,
          baseCommit,
        },
        runSetupScript,
        inherited: undefined,
        signal: undefined,
        setupAuthorized: true,
      });
      expect(active).toMatchObject({
        state: "active",
        environmentId: ready.environmentId,
        remoteWorkspaceDir: boundWorkspace.workspaceDir,
        workspaceBaseManifestRef: current.manifestRef,
      });
      expect(harness.environments.create).not.toHaveBeenCalled();
      expect(harness.environments.createFromProfileSnapshot).not.toHaveBeenCalled();
      expect(store.get(ready.environmentId)?.preparation?.consumedAtMs).toBe(1_000);
      expect(harness.log.indexOf("workspace:bind-prepared")).toBeLessThan(
        harness.log.indexOf("sync"),
      );
      expect(repositoryStore.get(accepted.workspaceId)).toEqual(accepted);
      const checkpoint = await readSessionRepositoryCheckpoint({
        workspaceId: accepted.workspaceId,
      });
      expect(checkpoint.currentManifestRef).toBe(current.manifestRef);
      expect(harness.environments.schedulePreparedRefill).toHaveBeenCalledWith(ready.environmentId);
      const tunnel = await startTunnel.mock.results[0]!.value;
      expect(tunnel.quiesceWorkspace).not.toHaveBeenCalled();
      expect(tunnel.reconcileWorkspace).not.toHaveBeenCalled();
    },
  );
});
