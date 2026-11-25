import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { NodeWorkerWorkspaceRuntime } from "../../node-host/node-worker-workspace.js";
import type { WorkerRetentionObservation } from "../../plugins/worker-retention.types.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { createWorkerPlacementNodeWorkspaceBindingResolver } from "../server-worker-placement-session-target.js";
import { hashWorkerCredential } from "./credential.js";
import { createNodeWorkerLaunchAdapter } from "./node-launch-adapter.js";
import { createNodeWorkerTunnelManager } from "./node-worker-tunnel.js";
import { createNodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";
import { startNodeWorkspaceTransferTestServer } from "./node-workspace-transfer.test-support.js";
import type { openDiskCleanupTransport } from "./placement-disk-cleanup.test-support.js";
import { advancePlacementFixtureToActive } from "./placement-test-fixtures.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import { syncSessionRepositoryWorkspace } from "./repository-workspace-startup.js";
import { createWorkerEnvironmentService } from "./service.js";
import { createProvider } from "./service.test-support.js";
import { createWorkerEnvironmentStore } from "./store.js";
import {
  attachedEnvironment,
  database,
  ENVIRONMENT_ID,
  placements,
  root,
  sessionTarget,
} from "./worker-turn-launcher.test-support.js";
import { requireWorkspaceResultGit } from "./workspace-result-git.js";

// Configured pairing/build metadata and a local origin are synthetic. Environment
// admission, native dispatch, HTTP uploads and durable artifact owners are real.
export async function openRepositoryCaptureTransport(
  wire: Awaited<ReturnType<typeof openDiskCleanupTransport>>,
  retained = false,
  executionMode: "worker-turn" | "remote-exec" = "worker-turn",
) {
  const assertCurrent = () => {};
  const records = await createWorkerEnvironmentStore({ database });
  const build = attachedEnvironment().bootstrapReceipt!;
  const credential = {
    credentialHash: hashWorkerCredential("synthetic-capture-credential"),
    sessionId: null,
    rpcSetVersion: 1,
    expiresAtMs: Date.now() + 60_000,
  };
  await records.createIntent({
    environmentId: ENVIRONMENT_ID,
    providerId: "fixture",
    profileId: "fixture",
    profileSnapshot: { settings: {}, install: "bundle" },
    provisionOperationId: "capture-provision",
    ...(retained
      ? {
          retention: {
            version: 1 as const,
            ownerBinding: "a".repeat(64),
            computeWindowSeconds: 600,
          },
        }
      : {}),
  });
  await records.transition({
    environmentId: ENVIRONMENT_ID,
    from: "requested",
    to: "provisioning",
  });
  await records.transition({
    environmentId: ENVIRONMENT_ID,
    from: "provisioning",
    to: "ready",
    patch: {
      leaseId: "capture-lease",
      nodeDeviceId: wire.nodeId,
      sharedHost: false,
      bootstrapReceipt: build,
      credential,
    },
  });
  const attached = await records.transition({
    environmentId: ENVIRONMENT_ID,
    from: "ready",
    to: "attached",
    patch: {
      attachedSessionIds: [sessionTarget.sessionId],
      credential: { ...credential, sessionId: sessionTarget.sessionId },
    },
  });
  const resourceReceipt = {
    version: 1 as const,
    leaseId: attached.leaseId!,
    identity: { diskId: "capture-original-disk" },
  };
  await records.recordResourceReceipt({
    environmentId: ENVIRONMENT_ID,
    provisionOperationId: attached.provisionOperationId,
    receipt: resourceReceipt,
    assertCurrent,
  });
  let observation: WorkerRetentionObservation = {
    claimRevision: "capture-initial",
    state: "running",
    computeExpiresAtMs: Date.now() + 600_000,
  };
  if (retained) {
    await records.recordRetentionObservation({
      environmentId: ENVIRONMENT_ID,
      expectedOwnerEpoch: attached.ownerEpoch,
      observation,
      assertCurrent,
    });
    await records.setRetentionRuntimeAdmission({
      environmentId: ENVIRONMENT_ID,
      expectedOwnerEpoch: attached.ownerEpoch,
      expectedClaimRevision: observation.claimRevision,
      ready: true,
      assertCurrent,
    });
  }
  const original = records.get(ENVIRONMENT_ID)!;
  const events: string[] = [];
  const transfer = createNodeWorkspaceTransferService({
    temporaryRoot: path.join(root, "capture-transfers"),
    getOwner: (id) => {
      const environment = records.get(id);
      return environment ? { environment, credential: records.getCredential(id) } : undefined;
    },
  });
  const http = await startNodeWorkspaceTransferTestServer(transfer);
  const workspace = new NodeWorkerWorkspaceRuntime({
    root: path.join(root, "capture-node"),
    env: { PATH: process.env.PATH, HOME: path.join(root, "capture-home") },
  });
  wire.bind({
    workspace,
    events,
    gateway: { url: http.gatewayUrl },
    beforeStop: async () => {},
    observeWorkspace: (input) => {
      expect(input).toMatchObject({
        environmentId: ENVIRONMENT_ID,
        sessionId: sessionTarget.sessionId,
        generation: attached.ownerEpoch,
      });
    },
  });
  const tunnels = createNodeWorkerTunnelManager({
    gatewayDeviceId: "capture-gateway",
    getEnvironment: records.get,
    listEnvironments: records.list,
    getTransport: () => wire.transport,
    workspaceTransfer: transfer,
    launchNodeWorker: createNodeWorkerLaunchAdapter({ getTransport: () => wire.transport }).launch,
    validateWorkerTurn: (claim) => placements.validateTurnClaim(claim),
  });
  const preparation = {
    beforeBuild: async () => {},
    beforeNode: async () => {},
    beforeBundle: async () => {},
    build,
  };
  // Provider observation and runtime installation are explicit synthetic boundaries.
  // ensureRetainedRunning, its writer/replay owner and the native file transport are real.
  let revision = 0;
  const provider = createProvider({
    id: "fixture",
    supportsResourceReceipts: true,
    inspect: async () => ({
      status: observation.state === "running" ? "active" : "dormant",
      resourceReceipt,
      retention: observation,
    }),
    setRetainedState: vi.fn(async (lease) => {
      lease.assertCurrent();
      expect(lease.resourceReceipt).toEqual(resourceReceipt);
      observation = {
        claimRevision: "capture-" + ++revision,
        state: lease.operation.action === "pause" ? "suspended" : "running",
        computeExpiresAtMs: Date.now() + 600_000,
        operation: { ...lease.operation, phase: "observed" },
      };
      return observation;
    }),
  });
  const environments = createWorkerEnvironmentService({
    scheduler: createTestGatewayScheduler(),
    store: records,
    getConfig: () => ({}),
    resolveProvider: () => provider,
    placementStore: createWorkerSessionPlacementGate(placements),
    waitForRetainedNode: async (node, request) => {
      expect(node).toBe(wire.nodeId);
      await preparation.beforeNode();
      request.assertCurrent();
    },
    ensureNodeWorkerBundle: async (request) => {
      expect(request.deviceId).toBe(wire.nodeId);
      await preparation.beforeBundle();
      request.assertCurrent?.();
      return preparation.build;
    },
    prepareInstallation: async () => {
      await preparation.beforeBuild();
      return {
        ...preparation.build,
        install: "bundle",
        tarballBytes: 1,
        tarballSha256: "b".repeat(64),
        tarballPath: path.join(root, "unused-bundle"),
      };
    },
    bootstrapWorker: async () => {
      throw new Error("Capture must not provision a worker");
    },
    nodeTunnelManager: tunnels,
  });
  const close = async () => {
    try {
      await environments.stop();
    } finally {
      await workspace.quiescence.close();
      await workspace.processes.close();
      await http.close();
      await transfer.closeAll();
      await records.close();
    }
  };
  try {
    const origin = path.join(root, "capture-origin");
    await fs.mkdir(origin);
    const git = (args: string[]) =>
      requireWorkspaceResultGit(origin, args, {
        baseEnv: {
          ...process.env,
          HOME: origin,
          GIT_CONFIG_GLOBAL: os.devNull,
          GIT_CONFIG_NOSYSTEM: "1",
        },
      });
    await git(["init", "--quiet"]);
    await git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "base",
    ]);
    const store = getSessionRepositoryWorkspaceStore();
    const created = await store.create({
      ...sessionTarget,
      url: pathToFileURL(origin).href,
      runSetupScript: false,
      assertCurrent,
    });
    await upsertSessionEntryCore(sessionTarget, { repositoryWorkspaceId: created.workspaceId });
    const tunnel = await environments.startTunnel({
      environmentId: ENVIRONMENT_ID,
      ownerEpoch: attached.ownerEpoch,
      authorize: assertCurrent,
    });
    const synced = await syncSessionRepositoryWorkspace({
      ...sessionTarget,
      repository: created,
      tunnel,
      generation: 1,
      assertCurrent,
    });
    await advancePlacementFixtureToActive(
      placements,
      database,
      { ...sessionTarget, executionMode },
      {
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: attached.ownerEpoch,
        remoteWorkspaceDir: synced.remoteWorkspaceDir,
        workspaceBaseManifestRef: synced.manifestRef,
        seedEnvironment: false,
      },
    );
    const current = await store.get(created.workspaceId);
    assert(current);
    const repository = await store.bindDisk({
      workspaceId: current.workspaceId,
      expectedRevision: current.revision,
      diskAuthority: { environmentId: ENVIRONMENT_ID, resourceReceipt },
      assertCurrent,
    });
    tunnels.bindWorkspaceBindingResolver(
      createWorkerPlacementNodeWorkspaceBindingResolver({
        placements,
        resolveWorkspace: async () => ({
          kind: "repository",
          repository: (await store.get(repository.workspaceId))!,
        }),
      }),
    );
    events.length = 0;
    wire.commands.length = 0;
    return {
      repository,
      original,
      records,
      environments,
      transfer,
      events,
      workspace,
      remote: synced.remoteWorkspaceDir,
      store,
      preparation,
      provider,
      pause: () =>
        environments.suspendRetained({
          environmentId: ENVIRONMENT_ID,
          expectedOwnerEpoch: attached.ownerEpoch,
          assertCurrent,
        }),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
