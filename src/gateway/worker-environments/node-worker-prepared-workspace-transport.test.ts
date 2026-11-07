import { expect, it, vi } from "vitest";
import { NODE_WORKER_WORKSPACE_PREPARE_COMMAND } from "../../infra/node-commands.js";
import { createNodeWorkerPreparedWorkspaceTransport } from "./node-worker-prepared-workspace-transport.js";
import { BUILD, environment, transport } from "./node-worker-tunnel.test-support.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { activePlacement } from "./placement-suite.test-support.js";
import type { WorkerProjectPreparationIdentity } from "./preparation-identity.schema.js";
import { setupWorkerEnvironmentServiceSuite, testState } from "./service.test-support.js";

setupWorkerEnvironmentServiceSuite();

it("retains cold verification budgets for first binding and legacy node registration", async () => {
  const preparation: WorkerProjectPreparationIdentity = {
    key: "b".repeat(64),
    cacheKey: "c".repeat(64),
    contractVersion: 2,
    target: { machineClass: "test", platform: "linux" },
    artifacts: {
      nodeBootstrapSha256: BUILD.bundleHash,
      enabledPluginIds: [],
      workerBundleHash: BUILD.bundleHash,
      workerArchiveSha256: BUILD.bundleHash,
      openclawVersion: BUILD.openclawVersion,
      protocolFeatures: BUILD.protocolFeatures,
    },
  };
  const record = {
    ...environment(),
    sharedHost: false,
    ownerEpoch: 3,
    profileSnapshot: { project: { preparation } },
  };
  const placement = activePlacement("session-1", { environmentId: record.environmentId });
  const placements = createWorkerSessionPlacementStore({ database: testState.stateDb });
  vi.spyOn(placements, "getAsync").mockResolvedValue(placement);
  vi.spyOn(placements, "get").mockReturnValue(placement);
  vi.spyOn(testState.store, "get").mockReturnValue(record);
  vi.spyOn(testState.store, "getCredential").mockReturnValue({
    environmentId: record.environmentId,
    credentialHash: "d".repeat(64),
    bundleHash: BUILD.bundleHash,
    sessionId: placement.sessionId,
    rpcSetVersion: 1,
    ownerEpoch: record.ownerEpoch,
    expiresAtMs: 1_000_000,
    deliveredAtMs: 1,
  });
  const nodeTransport = transport();
  const fixtureNode = await nodeTransport.getCurrentNode(record.nodeDeviceId!);
  if (!fixtureNode) {
    throw new Error("missing fixture node");
  }
  const node = {
    ...fixtureNode,
    workerHost: { ...fixtureNode.workerHost, preparedWorkspace: 1 as const },
  };
  const deferredNode = {
    ...node,
    workerHost: { ...node.workerHost, preparedWorkspaceDeferredVerification: true as const },
  };
  const lookup = vi.spyOn(nodeTransport, "getCurrentNode").mockResolvedValue(deferredNode);
  const workspace = {
    gatewayNamespace: "gateway",
    environmentId: record.environmentId,
    preparationKey: preparation.key,
    cacheKey: preparation.cacheKey,
    workspaceDir: "/workspace",
    homeDir: "/home/worker",
    sourceManifestRef: `sha256:${"e".repeat(64)}`,
    preparedManifestRef: `sha256:${"f".repeat(64)}`,
  };
  const invoke = vi.spyOn(nodeTransport, "invoke").mockResolvedValue({
    ok: true,
    payloadJSON: JSON.stringify(workspace),
  });
  const owner = createNodeWorkerPreparedWorkspaceTransport({
    store: testState.store,
    placementStore: placements,
    getNodeTransport: () => nodeTransport,
    gatewayNamespace: workspace.gatewayNamespace,
  });
  const signal = new AbortController().signal;
  const bind = () =>
    owner.bindPreparedWorkspace({
      environmentId: record.environmentId,
      preparationKey: preparation.key,
      cacheKey: preparation.cacheKey,
      sessionId: placement.sessionId,
      sessionKey: placement.sessionKey,
      ownerEpoch: record.ownerEpoch,
      assertCurrent: () => {},
      signal,
    });
  await expect(bind()).resolves.toEqual(workspace);
  expect(invoke).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      command: NODE_WORKER_WORKSPACE_PREPARE_COMMAND,
      params: expect.objectContaining({ action: "bind" }),
      timeoutMs: 10 * 60_000 + 5_000,
      signal,
    }),
  );
  lookup.mockResolvedValue(node);
  invoke.mockClear();
  await expect(bind()).resolves.toEqual(workspace);
  expect(invoke).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ timeoutMs: 30_000 }));
  record.state = "provisioning";
  record.nodeSetupId = "setup-1";
  record.attachedSessionIds = [];
  invoke.mockClear();
  await owner.registerPreparedWorkspace({
    record,
    deviceId: record.nodeDeviceId!,
    workspace: { ...workspace, baseCommit: "a".repeat(40) },
    assertCurrent() {},
    signal,
  });
  expect(invoke).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      params: expect.objectContaining({ action: "register" }),
      timeoutMs: 605_000,
    }),
  );
  lookup.mockResolvedValue(deferredNode);
  invoke.mockClear();
  await owner.registerPreparedWorkspace({
    record,
    deviceId: record.nodeDeviceId!,
    workspace: { ...workspace, baseCommit: "a".repeat(40) },
    assertCurrent() {},
    signal,
  });
  expect(invoke).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      timeoutMs: 30_000,
      params: { action: "register", ...workspace },
    }),
  );
});
