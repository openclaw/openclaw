import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { onTestFinished, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { CloudWorkersConfigSchema } from "../../config/zod-schema.cloud-workers.js";
import type { WorkerProvider, WorkerResourceReceipt } from "../../plugins/types.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { bindDeviceWorkerAvailability } from "./device-provider.js";
import type { WorkerEnvironmentNodeTunnel } from "./environment-access.js";
import { createNodeWorkerBundleTestNode } from "./node-worker-bundle.test-support.js";
import { createNodeWorkerWorkspaceActions } from "./node-worker-workspace-actions.js";
import { REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { WORKER_PROTOCOL_FEATURES } from "./placement-lifecycle.test-support.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import {
  createRepositoryNodeFixture,
  createRepositoryPolicySource,
} from "./repository-policy-node.test-support.js";
import * as support from "./service.test-support.js";
import { stageSessionRepositoryCheckpoint } from "./session-repository-checkpoints.js";
import type { WorkerTurnTunnelHandle } from "./tunnel-contract.js";
import { captureWorkspaceManifest } from "./workspace-manifest-worker.js";
import { serializeWorkerWorkspaceManifest } from "./workspace-manifest.js";

export const ORIGINAL_RESOURCE: WorkerResourceReceipt = {
  version: 1,
  leaseId: "activation-lease",
  identity: { diskId: "activation-original-disk" },
};
export const RETAINED_SELECTOR = { mode: "retained-disk", computeWindowSeconds: 600 } as const;
type Durability = typeof RETAINED_SELECTOR | { mode: "mirrored" };

/** Parse the actual profile boundary: never inject retainedPolicy or bindDisk in this fixture. */
export function configureRepositoryDurability(workspaceDurability?: Durability) {
  const state = support.testState;
  state.config.cloudWorkers = CloudWorkersConfigSchema.parse({
    profiles: {
      development: {
        provider: "fake",
        settings: { region: "test" },
        ...(workspaceDurability ? { workspaceDurability } : {}),
      },
    },
  });
  setRuntimeConfigSnapshot(state.config);
}

/**
 * Real dispatch, environment/placement/repository writers, Git and node workspace HTTP transfer.
 * Only allocation, enrollment/build and node connection transport are synthetic. No cloud or model.
 */
export async function repositoryActivationFixture(
  options: {
    workspaceDurability?: Durability;
    acceptedCheckpoint?: boolean;
    receipt?: "missing" | "replaced";
    unsupported?: boolean;
  } = {},
) {
  configureRepositoryDurability(options.workspaceDurability);
  const state = support.testState;
  state.nowMs = Date.now();
  vi.stubEnv("OPENCLAW_STATE_DIR", state.root);
  vi.stubEnv("GIT_CONFIG_GLOBAL", os.devNull);
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  onTestFinished(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  const origin = path.join(state.root, "origin");
  const { baseCommit, base } = await createRepositoryPolicySource(origin);
  const repositories = getSessionRepositoryWorkspaceStore();
  let repository = await repositories.create({
    ...REQUEST,
    url: pathToFileURL(origin).href,
    assertCurrent() {},
  });
  if (options.acceptedCheckpoint) {
    repository = await repositories.bindBase({
      workspaceId: repository.workspaceId,
      expectedRevision: repository.revision,
      baseCommit,
      baseManifestHash: base.manifestRef,
      assertCurrent() {},
    });
    await fs.writeFile(path.join(origin, "session.txt"), "accepted before disk activation\n");
    const current = await captureWorkspaceManifest({ root: origin, baseCommit });
    const checkpoint = await stageSessionRepositoryCheckpoint({
      workspaceId: repository.workspaceId,
      expectedRevision: repository.revision,
      stagingRoot: origin,
      baseManifestRaw: serializeWorkerWorkspaceManifest(base.manifest),
      currentManifestRaw: serializeWorkerWorkspaceManifest(current.manifest),
      baseManifestRef: base.manifestRef,
      currentManifestRef: current.manifestRef,
      assertCurrent() {},
    });
    try {
      await checkpoint.publish();
    } finally {
      await checkpoint.discard();
    }
    await fs.rm(path.join(origin, "session.txt"));
    repository = (await repositories.get(repository.workspaceId))!;
  }
  const placements = createWorkerSessionPlacementStore({
    database: state.stateDb,
    now: () => state.nowMs,
  });
  const node = createNodeWorkerBundleTestNode({
    nodeId: "activation-node",
    workerHost: { capturedExecPolicy: true, promptContext: 1 },
  });
  const native = await createRepositoryNodeFixture({
    nodeHome: path.join(state.root, "node-home"),
    store: state.store,
  });
  const build = { ...support.BOOTSTRAP_RECEIPT, protocolFeatures: [...WORKER_PROTOCOL_FEATURES] };
  vi.mocked(state.prepareInstallation).mockResolvedValue({ ...support.BUNDLE_ARTIFACT, ...build });
  const acquisition: Array<{
    requested: Parameters<WorkerProvider["provision"]>[2];
    persisted: ReturnType<typeof state.store.get>;
  }> = [];
  const provision = vi.fn<WorkerProvider["provision"]>(async (_profile, operationId, request) => {
    request?.assertCurrent?.();
    // Observe committed policy at the external allocation boundary, not a mocked create result.
    acquisition.push({
      requested: request,
      persisted: structuredClone(
        state.store.list().find((row) => row.provisionOperationId === operationId),
      ),
    });
    if (options.receipt !== "missing") {
      await request?.recordResourceReceipt?.(ORIGINAL_RESOURCE);
    }
    return {
      leaseId: ORIGINAL_RESOURCE.leaseId,
      sharedHost: false,
      node: { deviceId: node.nodeId },
      ...(options.receipt === "missing"
        ? {}
        : {
            resourceReceipt:
              options.receipt === "replaced"
                ? { ...ORIGINAL_RESOURCE, identity: { diskId: "replacement-disk" } }
                : ORIGINAL_RESOURCE,
          }),
    };
  });
  let destroyed = false;
  const provider = support.createProvider({
    requiresNodeEnrollment: true,
    supportedExecutionModes: ["worker-turn"],
    supportsResourceReceipts: true,
    resolveAllocation: async () => ({ leaseId: ORIGINAL_RESOURCE.leaseId, sharedHost: false }),
    provision,
    inspect: async () => ({
      status: destroyed ? "destroyed" : "active",
      sharedHost: false,
      resourceReceipt: ORIGINAL_RESOURCE,
      retention: {
        claimRevision: "initial",
        state: "running",
        computeExpiresAtMs: state.nowMs + 600_000,
      },
    }),
    destroy: async () => {
      destroyed = true;
    },
    setRetainedState: async () => {
      throw new Error("Activation must not pause or resume compute");
    },
  });
  if (options.unsupported) {
    delete provider.setRetainedState;
  }
  let handle: WorkerTurnTunnelHandle | undefined;
  const nodeTunnelManager: WorkerEnvironmentNodeTunnel = {
    status: () => (handle ? "connected" : "stopped"),
    beginClose() {},
    stop: async () => {},
    stopAll: async () => {},
    observeProcesses: async () => {
      throw new Error("No process observation in activation proof");
    },
    start: async ({ environmentId, ownerEpoch, sessionId, authorize }) => {
      authorize?.();
      const isOwnerCurrent = () => {
        const current = state.store.get(environmentId);
        return (
          current?.state === "attached" &&
          current.ownerEpoch === ownerEpoch &&
          current.destroyRequestedAtMs === null
        );
      };
      const actions = createNodeWorkerWorkspaceActions({
        environmentId,
        ownerEpoch,
        sessionId,
        ownerSignal: new AbortController().signal,
        isOwnerCurrent,
        supportsGitResults: async () => true,
        workspaceTransfer: native.workspaceTransfer,
        runWorkspaceCommand: async (command) => {
          command.assertCurrent?.();
          return await native.runtime.exec(
            {
              gatewayNamespace: "activation-gateway",
              environmentId,
              sessionId,
              generation: ownerEpoch,
              ...command,
              argv: [...command.argv],
            },
            undefined,
            { url: native.gatewayUrl },
          );
        },
      });
      handle = {
        environmentId,
        ownerEpoch,
        ...actions,
        syncWorkspace: vi.fn(actions.syncWorkspace),
        reconcileWorkspace: vi.fn(actions.reconcileWorkspace),
        measureLaunchTurn: vi.fn(),
        readLaunchToolNames: async () => [],
        launchTurn: vi.fn(),
        stop: async () => {},
      };
      return handle;
    },
  };
  const service = support.createService(provider, {
    projectNamespace: "activation-gateway",
    placementStore: createWorkerSessionPlacementGate(placements),
    nodeTunnelManager,
    prepareNodeEnrollment: async () => ({
      mode: "resume",
      deviceId: node.nodeId,
      displayName: "Synthetic activation node",
      openclawVersion: build.openclawVersion,
      nodeBootstrap: support.NODE_BOOTSTRAP,
      waitForDeviceId: async () => node.nodeId,
    }),
    ensureNodeWorkerBundle: async ({ assertCurrent }) => {
      assertCurrent?.();
      return build;
    },
    waitForRetainedNode: async (_id, { assertCurrent }) => {
      assertCurrent();
    },
  });
  const harness = await createHarness(state.stateDb, placements, {
    environmentService: service,
    resolveWorkspace: async () => ({
      kind: "repository",
      repository: (await repositories.get(repository.workspaceId))!,
    }),
    isCurrentNodePlacement: (current) => current === node,
  });
  bindDeviceWorkerAvailability(harness.environments, async () => ({ available: true, node }));
  return {
    harness,
    placements,
    repositories,
    repository,
    provision,
    acquisition,
    baseCommit,
    dispatch: () =>
      harness.service.dispatch({
        ...REQUEST,
        devicePlacement: { requiredNodeCommands: [], consumesWorkerSlot: true },
      }),
    get tunnel() {
      if (!handle) {
        throw new Error("Dispatch did not start the node transport");
      }
      return handle;
    },
  };
}
