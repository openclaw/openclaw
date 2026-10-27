import { vi } from "vitest";
import { bindDeviceWorkerAvailability } from "./device-provider.js";
import type { WorkerEnvironmentNodeTunnel } from "./environment-access.js";
import { createNodeWorkerBundleTestNode } from "./node-worker-bundle.test-support.js";
import { createWorkerPlacementDispatchService } from "./placement-dispatch.js";
import type { WorkerTurnTunnelHandle } from "./tunnel-contract.js";
import { measureLaunchTurn, readLaunchToolNames } from "./worker-turn-launcher.test-support.js";
import { createWorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";
import { createWorkerWorkspaceRecoveryFixture } from "./workspace-recovery.test-support.js";

export function createProviderReplayNodeTunnel() {
  const syncWorkspace = vi.fn(async () => ({
    mode: "git" as const,
    remoteWorkspaceDir: "/worker/workspace",
    manifestRef: `sha256:${"b".repeat(64)}`,
  }));
  const nodeTunnelManager = {
    status: () => "stopped" as const,
    observeProcesses: vi.fn<WorkerEnvironmentNodeTunnel["observeProcesses"]>(),
    start: vi.fn<WorkerEnvironmentNodeTunnel["start"]>(async ({ environmentId, ownerEpoch }) => ({
      environmentId,
      ownerEpoch,
      measureLaunchTurn,
      readLaunchToolNames,
      launchTurn: vi.fn<WorkerTurnTunnelHandle["launchTurn"]>(),
      runWorkspaceCommand: vi.fn<WorkerTurnTunnelHandle["runWorkspaceCommand"]>(),
      quiesceWorkspace: vi.fn<WorkerTurnTunnelHandle["quiesceWorkspace"]>(),
      syncWorkspace,
      reconcileWorkspace: vi.fn<WorkerTurnTunnelHandle["reconcileWorkspace"]>(),
      stop: vi.fn<WorkerTurnTunnelHandle["stop"]>(),
    })),
    stop: vi.fn(async () => {}),
    stopAll: vi.fn(async () => {}),
    beginClose: vi.fn(),
  } satisfies WorkerEnvironmentNodeTunnel;
  return { nodeTunnelManager, syncWorkspace };
}

export function bindProviderReplayNodeAvailability(
  service: Parameters<typeof bindDeviceWorkerAvailability>[0],
) {
  bindDeviceWorkerAvailability(service, async (nodeId) => ({
    available: true,
    node: createNodeWorkerBundleTestNode({
      nodeId,
      connId: `conn-${nodeId}`,
      pairingIdentity: `identity-${nodeId}`,
      pairingGeneration: `generation-${nodeId}`,
      workerHost: {
        capacity: { total: 1, available: 1 },
        capturedExecPolicy: true,
        promptContext: 1,
      },
    }),
  }));
}

type DispatchOptions = Parameters<typeof createWorkerPlacementDispatchService>[0];

export function createProviderReplayDispatch(
  options: Pick<DispatchOptions, "placements" | "environments" | "initialPlacements"> &
    Partial<DispatchOptions>,
) {
  return createWorkerPlacementDispatchService({
    runnerAvailability: { read: () => undefined, version: () => 0 },
    workspaceOperations: createWorkerWorkspaceOperationCoordinator(),
    runLocalBarrier: async ({ startDispatch }) => startDispatch(),
    runRecoveryBarrier: async ({ run }) => await run({ kind: "local", path: "/gateway/workspace" }),
    runActivationBarrier: async ({ activate }) => activate(),
    runMoveBarrier: async ({ begin }) => begin(),
    resolveMoveDestination: async () => undefined,
    runReclaimPreparation: async ({ run, authorize }) => await run(authorize),
    runReclaimBarrier: async ({ begin, reclaim }) =>
      await reclaim({ kind: "local", path: "/gateway/workspace" }, await begin()),
    runFailedReclaimBarrier: async ({ reclaim }) => await reclaim(),
    ...createWorkerWorkspaceRecoveryFixture({
      resolveWorkspace: async () => ({ kind: "local", path: "/gateway/workspace" }),
    }),
    ...options,
  });
}
