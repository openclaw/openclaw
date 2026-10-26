import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import vm from "node:vm";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createGitHubReadIdentity } from "../../agents/github-read-identity.js";
import { getRuntimeConfig } from "../../config/config.js";
import {
  areDiagnosticsEnabledForProcess,
  setDiagnosticsEnabledForProcess,
} from "../../infra/diagnostic-events.js";
import {
  NODE_WORKER_ENVIRONMENT_SESSION_VERSION,
  NODE_WORKER_PREPARED_WORKSPACE_VERSION,
} from "../../infra/node-runner-inventory.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import type { SessionRepositoryWorkspaceRecord } from "../../state/session-repository-workspaces.types.js";
import { createCommandResult } from "../../test-utils/npm-spec-install-test-helpers.js";
import type { NodeWorkerPreparedWorkspaceResult } from "../../worker/node-workspace-prepared-protocol.js";
import {
  createNodeRegistryRuntime,
  updateNodeRunnerInventory,
  type NodeWorkerSupervisorNodeProof,
} from "../node-registry-private.js";
import { NodeRegistry } from "../node-registry.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import { sessionLog } from "../session-log.js";
import { bindDeviceWorkerAvailability } from "./device-provider.js";
import type { EnvironmentRecipe } from "./environment-recipe.js";
import { createNodeWorkerBundleTestNode } from "./node-worker-bundle.test-support.js";
import { REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { WORKER_PROTOCOL_FEATURES } from "./placement-lifecycle.test-support.js";
import type { WorkerPlacementExecutionMode } from "./placement-record.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import type { WorkerProviderPreparedIntent } from "./preparation-identity.js";
import type { WorkerProjectPreparationIdentity } from "./preparation-identity.schema.js";
import { prepareRepositoryGitHubIdentity } from "./repository-github-identity.js";
import * as support from "./service.test-support.js";
import {
  readSessionRepositoryArtifacts,
  stageSessionRepositoryCheckpoint,
} from "./session-repository-checkpoints.js";
import type { WorkerProjectSnapshot } from "./workspace-git-base.js";
import { captureWorkspaceManifest } from "./workspace-manifest-worker.js";
import { serializeWorkerWorkspaceManifest } from "./workspace-manifest.js";
import { requireWorkspaceResultGit } from "./workspace-result-git.js";

// mock-isolation: Workspace startup supplies a synthetic identity without credential discovery.
vi.mock("./repository-github-identity.js", () => ({ prepareRepositoryGitHubIdentity: vi.fn() }));

vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  getRuntimeConfig: () => ({
    gateway: { nodes: { commands: { allow: ["codex.exec-server.stdio.v1"] } } },
  }),
}));

const PREPARATION_KEY = "c".repeat(64);
const FEATURES = [...WORKER_PROTOCOL_FEATURES];

async function preparedHarness(
  options: {
    reserve?: boolean;
    protocolFeatures?: string[];
    executionMode?: WorkerPlacementExecutionMode;
    emptyWorkspace?: boolean;
    repository?: SessionRepositoryWorkspaceRecord & { baseCommit: string };
    recipe?: EnvironmentRecipe;
    lifecycleFailure?: boolean;
    boundWorkspace?: Pick<
      NodeWorkerPreparedWorkspaceResult,
      "workspaceDir" | "sourceManifestRef" | "preparedManifestRef"
    >;
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
  const harness = await createHarness(support.testState.stateDb, placements, {
    ...(options.repository
      ? {
          requiresNodeEnrollment: true,
          resolveWorkspace: async () => ({ kind: "repository", repository: options.repository! }),
        }
      : {}),
    isCurrentNodePlacement: (proof, requirement, mode) =>
      nodeCurrent &&
      transport.isCurrent(
        proof,
        requirement.consumesWorkerSlot,
        requirement.requiredNodeCommands,
        mode === "worker-turn",
      ),
  });
  const environmentId = reserve ? "prepared-spare" : harness.ready.environmentId;
  const preparation: WorkerProjectPreparationIdentity = {
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
  };
  const project: WorkerProjectSnapshot = options.repository
    ? {
        key: "d".repeat(64),
        baseCommit: options.repository.baseCommit,
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
    : { key: "d".repeat(64), baseCommit: "e".repeat(40), root: "/gateway/workspace" };
  const profile = { settings: { region: "test" }, executionMode };
  const intent: WorkerProviderPreparedIntent = {
    providerId: "fake",
    profileSnapshot: options.emptyWorkspace
      ? { ...profile, runtimePreparation: { ...preparation, source: "empty" } }
      : {
          ...profile,
          project: {
            ...project,
            preparation: {
              ...preparation,
              ...(options.recipe
                ? { recipe: options.recipe, setupRecipe: options.recipe.identity }
                : {}),
            },
          },
        },
  };
  const store = support.testState.store;
  await store.createIntent({
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
  await store.transition({ environmentId, from: "requested", to: "provisioning" });
  const ready = await store.transition({
    environmentId,
    from: "provisioning",
    to: "ready",
    patch: {
      leaseId: `lease:${environmentId}`,
      nodeDeviceId: "prepared-node",
      sharedHost: false,
      ...support.readyPatch(environmentId, {
        ...support.BOOTSTRAP_RECEIPT,
        protocolFeatures,
      }),
    },
  });
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
  vi.mocked(harness.environments.startTunnel).mockImplementation(async (request) => {
    const tunnel = await ordinaryTunnel(request);
    if (options.recipe) {
      vi.spyOn(tunnel, "runWorkspaceCommand").mockImplementation(async (command) => {
        command.assertCurrent?.();
        const process = Object.assign(new EventEmitter(), {
          env: { PATH: "/worker/bin", HOME: "/worker/home" },
          cwd: () => "/worker/workspace",
          kill: vi.fn(),
          exitCode: 0,
        });
        let stderr = "";
        const spawn = (executable: string) => {
          harness.log.push(`lifecycle:${executable}`);
          const child = Object.assign(new EventEmitter(), {
            pid: 123,
            stderr: Object.assign(new EventEmitter(), { destroy: vi.fn() }),
          });
          queueMicrotask(() => {
            if (options.lifecycleFailure) {
              child.stderr.emit("data", Buffer.from("fixture failure"));
            }
            child.emit("exit", options.lifecycleFailure ? 1 : 0);
            child.emit("close", options.lifecycleFailure ? 1 : 0);
          });
          return child;
        };
        await vm.runInNewContext(command.argv[2]!, {
          Buffer,
          process,
          require: () => ({ spawn }),
          performance: { now: () => 0 },
          setTimeout: vi.fn(),
          clearTimeout: vi.fn(),
          console: {
            error: (message: string) => {
              stderr = message;
            },
          },
        });
        return createCommandResult({ stderr, code: process.exitCode });
      });
    }
    return { ...tunnel, environmentId: request.environmentId };
  });
  const bindPreparedWorkspace = vi.mocked(harness.environments.bindPreparedWorkspace);
  const ordinaryBind = bindPreparedWorkspace.getMockImplementation()!;
  bindPreparedWorkspace.mockImplementation(async (request) => {
    request.assertCurrent();
    harness.log.push("workspace:bind-prepared");
    return { ...(await ordinaryBind(request)), ...options.boundWorkspace };
  });
  if (!reserve) {
    vi.mocked(harness.environments.createWithRequest).mockResolvedValue(projected);
  }
  const node: NodeWorkerSupervisorNodeProof = createNodeWorkerBundleTestNode({
    nodeId: "prepared-node",
    connId: "prepared-connection",
    pairingIdentity: "prepared-identity",
    pairingGeneration: "prepared-generation",
    workerHost: {
      capacity: { total: 1, available: 1 },
      environmentSession: NODE_WORKER_ENVIRONMENT_SESSION_VERSION,
      preparedWorkspace: NODE_WORKER_PREPARED_WORKSPACE_VERSION,
      capturedExecPolicy: true,
      promptContext: 1,
    },
    commands: ["codex.exec-server.stdio.v1"],
  });
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

  const lifecycleRecipe: EnvironmentRecipe = {
    source: "devcontainer",
    identity: "8".repeat(40),
    inputs: { ".devcontainer/devcontainer.json": "8".repeat(40) },
    env: {},
    postCreate: ["post-create"],
    postStart: ["post-start"],
  };

  it.each([true, false])(
    "runs first-binding lifecycle after session sync and before activation (reserve=%s)",
    async (reserve) => {
      const { harness, request, ready } = await preparedHarness({
        reserve,
        recipe: lifecycleRecipe,
      });
      const previousDiagnostics = areDiagnosticsEnabledForProcess();
      setDiagnosticsEnabledForProcess(true);
      onTestFinished(() => {
        setDiagnosticsEnabledForProcess(previousDiagnostics);
        vi.restoreAllMocks();
      });
      vi.spyOn(sessionLog, "isEnabled").mockReturnValue(true);
      const warn = vi.spyOn(sessionLog, "warn").mockImplementation(() => {
        throw new Error("diagnostic sink unavailable");
      });
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      const attach = vi.mocked(harness.environments.attachSession);
      const ordinaryAttach = attach.getMockImplementation()!;
      attach.mockImplementation(async (params) => {
        const credential = await ordinaryAttach(params);
        now += 1_200;
        return credential;
      });
      if (!reserve) {
        const provision = vi.mocked(harness.environments.createWithRequest);
        const environment = harness.environments.get(ready.environmentId)!;
        provision.mockImplementation(async () => {
          now += 600;
          return environment;
        });
      }

      const active = await harness.service.dispatch(request);

      expect(active.state).toBe("active");
      expect(warn).toHaveBeenCalledExactlyOnceWith("slow placement dispatch", {
        operation: "sessions.dispatch",
        elapsedMs: reserve ? 1_200 : 1_800,
        phaseDurationsMs: {
          admission: 0,
          workspacePreparation: 0,
          reserveClaim: 0,
          ...(!reserve ? { provision: 600 } : {}),
          attach: 1_200,
          tunnel: 0,
          bind: 0,
          repositoryStartup: 0,
          lifecycleCommands: 0,
          activation: 0,
          cleanup: 0,
        },
      });
      expect(
        harness.log.filter((phase) =>
          [
            "workspace:bind-prepared",
            "sync",
            "lifecycle:post-create",
            "lifecycle:post-start",
            "placement:starting",
            "activation",
          ].includes(phase),
        ),
      ).toEqual([
        "workspace:bind-prepared",
        "sync",
        "lifecycle:post-create",
        "lifecycle:post-start",
        "placement:starting",
        "activation",
      ]);
      const tunnel = await vi.mocked(harness.environments.startTunnel).mock.results[0]!.value;
      expect(tunnel.launchTurn).not.toHaveBeenCalled();
    },
  );

  it("carries prepared repository authority into the provider lifecycle launch", async () => {
    const { harness, request } = await preparedHarness({ recipe: lifecycleRecipe });
    let repositoryCurrent = true;
    const bind = vi.mocked(harness.environments.bindPreparedWorkspace);
    const ordinaryBind = bind.getMockImplementation()!;
    bind.mockImplementation(async (input) => ({
      ...(await ordinaryBind(input)),
      assertCurrent: () => {
        input.assertCurrent();
        if (!repositoryCurrent) {
          throw new Error("Repository identity revoked");
        }
      },
    }));
    const runSetup = vi.fn<NonNullable<typeof harness.environments.runProjectLifecycleCommand>>(
      async (_environmentId, _ownerEpoch, command) => {
        expect(command.workspaceDir).toBe("/worker/workspace");
        expect(command.homeDir).toBe("/worker/home");
        command.assertCurrent();
        await Promise.resolve();
        repositoryCurrent = false;
        command.assertCurrent();
        throw new Error("Repository command must not launch");
      },
    );
    harness.environments.runProjectLifecycleCommand = runSetup;
    await expect(harness.service.dispatch(request)).rejects.toThrow("Repository identity revoked");
    expect(runSetup).toHaveBeenCalledOnce();
    expect(harness.log).not.toContain("lifecycle:post-create");
    expect(harness.log).not.toContain("activation");
  });

  it("fails dispatch before activation when a declared post-binding command fails", async () => {
    const { harness, placements, ready, request } = await preparedHarness({
      recipe: lifecycleRecipe,
      lifecycleFailure: true,
    });

    await expect(harness.service.dispatch(request)).rejects.toThrow("fixture failure");

    expect(harness.log).toContain("lifecycle:post-create");
    expect(harness.log).not.toContain("lifecycle:post-start");
    expect(harness.log).not.toContain("activation");
    expect(placements.get(request.sessionId)?.state).toBe("failed");
    expect(harness.environments.destroy).toHaveBeenCalledWith(ready.environmentId);
  });

  it.each(
    (["worker-turn", "remote-exec"] as const).flatMap((executionMode) =>
      [false, true].map((emptyWorkspace) => ({ executionMode, emptyWorkspace })),
    ),
  )(
    "consumes the existing environment for $executionMode (empty workspace: $emptyWorkspace)",
    async ({ executionMode, emptyWorkspace }) => {
      const { harness, placements, store, ready, request } = await preparedHarness({
        executionMode,
        emptyWorkspace,
      });
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
      expect(harness.environments.createWithRequest).not.toHaveBeenCalled();
      expect(store.get(ready.environmentId)?.preparation?.consumedAtMs).toBe(1_000);
      expect(store.get(ready.environmentId)?.lastActivatedAtMs).toBe(1_000);
      expect(store.getCredential(ready.environmentId)).toMatchObject({
        sessionId: request.sessionId,
        ownerEpoch: active.activeOwnerEpoch,
      });
      if (emptyWorkspace) {
        expect(harness.environments.bindPreparedWorkspace).not.toHaveBeenCalled();
      } else {
        expect(harness.log.indexOf("workspace:bind-prepared")).toBeLessThan(
          harness.log.indexOf("sync"),
        );
      }
      expect(harness.environments.schedulePreparedRefill).toHaveBeenCalledWith(ready.environmentId);
      const tunnel = await vi.mocked(harness.environments.startTunnel).mock.results[0]?.value;
      expect(tunnel?.syncWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: request.sessionKey,
          source: {
            kind: "local",
            path: "/gateway/workspace",
            ...(emptyWorkspace ? {} : { projectKey: "d".repeat(64) }),
          },
        }),
      );
    },
  );

  it("binds a freshly prepared cold workspace without turning its ordinary row into a reserve", async () => {
    const { harness, store, ready, intent, request } = await preparedHarness({ reserve: false });

    const active = await harness.service.dispatch(request);

    expect(active.environmentId).toBe(ready.environmentId);
    expect(harness.environments.createWithRequest).toHaveBeenCalledWith({
      profileId: request.profileId,
      idempotencyKey: expect.any(String),
      executionMode: request.executionMode,
      projectPath: "/gateway/workspace",
      admittedIntent: intent,
    });
    expect(store.get(ready.environmentId)?.preparation).toBeNull();
    expect(harness.environments.bindPreparedWorkspace).toHaveBeenCalledOnce();
    expect(harness.log.indexOf("workspace:bind-prepared")).toBeLessThan(
      harness.log.indexOf("sync"),
    );
  });

  it.each(["build", "node", "exec-authority"] as const)(
    "uses the cold path when a candidate's %s proof is stale",
    async (stale) => {
      const { harness, store, ready, request, revokeNode } = await preparedHarness({
        protocolFeatures:
          stale === "exec-authority" ? [WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE] : undefined,
      });
      if (stale === "build") {
        const environment = harness.environments.get(ready.environmentId)!;
        vi.mocked(harness.environments.getPreparedCandidates).mockReturnValue([
          {
            ...environment,
            bootstrapReceipt: { ...ready.bootstrapReceipt!, bundleHash: "9".repeat(64) },
          },
        ]);
      } else if (stale === "node") {
        revokeNode();
      }

      const active = await harness.service.dispatch(request);

      expect(active.environmentId).toBe(harness.ready.environmentId);
      expect(active.environmentId).not.toBe(ready.environmentId);
      expect(harness.environments.createWithRequest).toHaveBeenCalledOnce();
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
      const { harness, store, ready, request, setHostingAvailable } = await preparedHarness({
        executionMode,
      });
      setHostingAvailable(false, reconnect);

      const active = await harness.service.dispatch(request);

      expect(active.environmentId).toBe(harness.ready.environmentId);
      expect(harness.environments.createWithRequest).toHaveBeenCalledOnce();
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
      } = await preparedHarness({ executionMode });
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
        expect(harness.environments.createWithRequest).toHaveBeenCalledOnce();
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
    const { harness, store, ready, request } = await preparedHarness();
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

    expect(store.get(ready.environmentId)?.preparation?.consumedAtMs).toBe(1_000);
    expect(harness.environments.startTunnel).not.toHaveBeenCalled();
    expect(harness.environments.destroy).toHaveBeenCalledWith(ready.environmentId);
  });

  it("rejects direct attachment without the prepared placement reservation", async () => {
    const { store, workerService, ready, request } = await preparedHarness();

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
  });

  it("fences a profile change after node eligibility before consuming its reserve", async () => {
    const { harness, store, ready, request } = await preparedHarness();
    vi.mocked(harness.environments.assertPreparedIntentCurrent)
      .mockImplementationOnce(() => {})
      .mockImplementation(() => {
        throw new Error("profile changed");
      });

    await expect(harness.service.dispatch(request)).rejects.toThrow("profile changed");

    expect(store.get(ready.environmentId)?.preparation?.consumedAtMs).toBeNull();
    expect(harness.environments.attachSession).not.toHaveBeenCalled();
    expect(harness.environments.createWithRequest).not.toHaveBeenCalled();
  });

  it("fences workspace upload when node authority closes during prepared binding", async () => {
    const { harness, store, ready, request, revokeNode } = await preparedHarness();
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
      vi.mocked(prepareRepositoryGitHubIdentity).mockResolvedValue(
        createGitHubReadIdentity({
          token: undefined,
          selection: { source: "anonymous" },
          assertSelected: () => {},
          readToken: async () => undefined,
        }),
      );
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
      const base = await captureWorkspaceManifest({ root: stagingRoot, baseCommit });
      await fs.writeFile(path.join(stagingRoot, "session.txt"), "accepted session change\n");
      const current = await captureWorkspaceManifest({ root: stagingRoot, baseCommit });
      const repositoryStore = getSessionRepositoryWorkspaceStore();
      expect(repositoryStore.path).toBe(support.testState.stateDb.path);
      const created = await repositoryStore.create({
        agentId: REQUEST.agentId,
        sessionKey: REQUEST.sessionKey,
        url: "https://github.com/example/project.git",
        requestedRef: "refs/heads/main",
        runSetupScript: true,
        assertCurrent: () => {},
      });
      const pinned = await repositoryStore.bindBase({
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
      const accepted = (await repositoryStore.get(created.workspaceId))!;
      const boundWorkspace = {
        workspaceDir: "/worker/prepared/project",
        sourceManifestRef: base.manifestRef,
        preparedManifestRef: base.manifestRef,
      };
      const { harness, store, ready, request } = await preparedHarness({
        repository: { ...accepted, baseCommit },
        boundWorkspace,
        ...(runSetupScript ? { recipe: lifecycleRecipe } : {}),
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
      expect(harness.environments.createWithRequest).not.toHaveBeenCalled();
      expect(store.get(ready.environmentId)?.preparation?.consumedAtMs).toBe(1_000);
      expect(harness.log.indexOf("workspace:bind-prepared")).toBeLessThan(
        harness.log.indexOf("sync"),
      );
      expect(await repositoryStore.get(accepted.workspaceId)).toEqual(accepted);
      if (runSetupScript) {
        expect(harness.log.indexOf("sync")).toBeLessThan(
          harness.log.indexOf("lifecycle:post-create"),
        );
        expect(harness.log.indexOf("lifecycle:post-start")).toBeLessThan(
          harness.log.indexOf("placement:starting"),
        );
      }
      const checkpoint = await readSessionRepositoryArtifacts({
        workspaceId: accepted.workspaceId,
        assertCurrent: () => {},
      });
      expect(checkpoint.currentManifestRef).toBe(current.manifestRef);
      expect(harness.environments.schedulePreparedRefill).toHaveBeenCalledWith(ready.environmentId);
      const tunnel = await startTunnel.mock.results[0]!.value;
      expect(tunnel.quiesceWorkspace).not.toHaveBeenCalled();
      expect(tunnel.reconcileWorkspace).not.toHaveBeenCalled();
    },
  );
});
