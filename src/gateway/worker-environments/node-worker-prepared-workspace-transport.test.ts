import { expect, it, vi } from "vitest";
import { NODE_WORKER_WORKSPACE_PREPARE_COMMAND } from "../../infra/node-commands.js";
import { createNodeWorkerPreparedWorkspaceTransport } from "./node-worker-prepared-workspace-transport.js";
import { BUILD, environment, transport } from "./node-worker-tunnel.test-support.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { activePlacement } from "./placement-suite.test-support.js";
import type { WorkerProjectPreparationIdentity } from "./preparation-identity.schema.js";
import { setupWorkerEnvironmentServiceSuite, testState } from "./service.test-support.js";

setupWorkerEnvironmentServiceSuite();

it("gives first-bind content verification the full ten-minute budget", async () => {
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
  await expect(
    owner.bindPreparedWorkspace({
      environmentId: record.environmentId,
      preparationKey: preparation.key,
      cacheKey: preparation.cacheKey,
      sessionId: placement.sessionId,
      sessionKey: placement.sessionKey,
      ownerEpoch: record.ownerEpoch,
      assertCurrent: () => {},
      signal,
    }),
  ).resolves.toEqual(workspace);
  expect(invoke).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      command: NODE_WORKER_WORKSPACE_PREPARE_COMMAND,
      params: expect.objectContaining({ action: "bind" }),
      timeoutMs: 10 * 60_000 + 5_000,
      signal,
    }),
  );
});
