import fs from "node:fs/promises";
import path from "node:path";
import { onTestFinished, vi } from "vitest";
import { getRuntimeConfig } from "../../config/config.js";
import {
  NODE_WORKER_ENVIRONMENT_SESSION_VERSION,
  NODE_WORKER_PREPARED_WORKSPACE_VERSION,
} from "../../infra/node-runner-inventory.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import type { SessionRepositoryWorkspaceRecord } from "../../state/session-repository-workspaces.types.js";
import type { NodeWorkerPreparedWorkspaceResult } from "../../worker/node-workspace-prepared-protocol.js";
import {
  createNodeRegistryRuntime,
  updateNodeRunnerInventory,
  type NodeWorkerSupervisorNodeProof,
} from "../node-registry-private.js";
import { NodeRegistry } from "../node-registry.js";
import { makeClient } from "../node-registry.test-helpers.js";
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
import * as support from "./service.test-support.js";
import type { WorkerProjectSnapshot } from "./workspace-git-base.js";

const PREPARATION_KEY = "c".repeat(64);
export const FEATURES = [...WORKER_PROTOCOL_FEATURES];

export async function preparedHarness(
  options: {
    reserve?: boolean;
    protocolFeatures?: string[];
    executionMode?: WorkerPlacementExecutionMode;
    emptyWorkspace?: boolean;
    runSetupScript?: boolean;
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
  const settings = {
    region: "test",
    ...(options.runSetupScript === undefined ? {} : { runSetupScript: options.runSetupScript }),
  };
  const profile = { settings, executionMode };
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
      const workspace = path.join(support.testState.root, "lifecycle-workspace");
      const bin = path.join(support.testState.root, "lifecycle-bin");
      await fs.mkdir(workspace, { recursive: true });
      await fs.mkdir(bin, { recursive: true });
      for (const phase of ["post-create", "post-start"]) {
        await fs.writeFile(
          path.join(bin, phase),
          `#!/bin/sh
printf "${phase}\n" >> "$PWD/lifecycle-effects.txt"
${options.lifecycleFailure ? "echo fixture failure >&2; exit 1" : ""}
`,
          { mode: 0o755 },
        );
      }
      vi.spyOn(tunnel, "runWorkspaceCommand").mockImplementation(async (command) => {
        command.assertCurrent?.();
        const result = await runCommandWithTimeout([...command.argv], {
          cwd: workspace,
          timeoutMs: command.timeoutMs,
          signal: command.signal,
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: support.testState.root },
        });
        const effects = await fs.readFile(path.join(workspace, "lifecycle-effects.txt"), "utf8");
        harness.log.push(
          ...effects
            .trim()
            .split("\n")
            .map((phase) => `lifecycle:${phase}`),
        );
        return result;
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
      makeClient(node.connId, node.nodeId, [], {
        clientId: node.clientId,
        version: "test",
        platform: "linux",
        commands: [...node.commands],
      }),
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
    request,
    transport,
    resolveAvailability,
    setHostingAvailable,
    revokeNode: () => {
      nodeCurrent = false;
    },
  };
}
