import { vi, expect } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../../infra/node-runner-inventory.js";
import { bindDeviceWorkerAvailability } from "./device-provider.js";
import type { WorkerEnvironmentNodeTunnel } from "./environment-access.js";
import { createWorkerPlacementDispatchService } from "./placement-dispatch.js";
import type { createNodeCarrier } from "./skill-resource-transfer.test-support.js";
import type { WorkerTurnTunnelHandle } from "./tunnel-contract.js";
import {
  measureLaunchTurn,
  readLaunchToolNames,
  createWorkerTurnTunnel,
  reconcileUnchangedLocalWorkspace,
} from "./worker-turn-launcher.test-support.js";
import { createWorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";
import { createWorkerWorkspaceRecoveryFixture } from "./workspace-recovery.test-support.js";

export function createProviderReplayNodeTunnel() {
  const syncWorkspace = vi.fn(async () => ({
    mode: "git" as const,
    remoteWorkspaceDir: "/worker/workspace",
    manifestRef: `sha256:${"b".repeat(64)}`,
  }));
  const nodeTunnelManager = {
    isNodeConnected: async () => true,
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
  } satisfies WorkerEnvironmentNodeTunnel;
  return { nodeTunnelManager, syncWorkspace };
}

export function bindProviderReplayNodeAvailability(
  service: Parameters<typeof bindDeviceWorkerAvailability>[0],
  commands: string[] = [],
) {
  bindDeviceWorkerAvailability(service, async (nodeId) => ({
    available: true,
    node: {
      nodeId,
      connId: `conn-${nodeId}`,
      pairingIdentity: `identity-${nodeId}`,
      pairingGeneration: `generation-${nodeId}`,
      clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
      clientMode: GATEWAY_CLIENT_MODES.NODE,
      protocolFeature: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
      workerHost: {
        enabled: true,
        capacity: { total: 1, available: 1 },
        capturedExecPolicy: true,
        promptContext: 1,
      },
      commands,
    },
  }));
}

type DispatchOptions = Parameters<typeof createWorkerPlacementDispatchService>[0];

export function createProviderReplayDispatch(
  options: Pick<DispatchOptions, "placements" | "environments"> & Partial<DispatchOptions>,
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

export function createProviderReplayNodeCarrierTunnel(
  carrier: Awaited<ReturnType<typeof createNodeCarrier>>,
  sessionId: string,
) {
  const { nodeTunnelManager } = createProviderReplayNodeTunnel();
  nodeTunnelManager.start.mockImplementation(async ({ environmentId, ownerEpoch }) => {
    const remoteWorkspaceDir = await carrier.bindWorkspace({
      gatewayNamespace: "gateway",
      environmentId,
      sessionId,
      generation: ownerEpoch,
    });
    return {
      ...createWorkerTurnTunnel({
        launchTurn: async () => {
          throw new Error("Remote exec must not launch a worker-turn child");
        },
        reconcileWorkspace: reconcileUnchangedLocalWorkspace,
      }),
      environmentId,
      ownerEpoch,
      syncWorkspace: async () => ({
        mode: "git",
        remoteWorkspaceDir,
        manifestRef: `sha256:${"b".repeat(64)}`,
      }),
      reconcileWorkspace: reconcileUnchangedLocalWorkspace,
      quiesceWorkspace: async () => ({ assertActive: async () => {}, resume: async () => {} }),
      stop: async () => {},
      runWorkspaceCommand: (command) => carrier.runWorkspaceCommand(command),
    };
  });
  return { nodeTunnelManager };
}

export async function executeProviderReplayNativeEffect(
  carrier: Awaited<ReturnType<typeof createNodeCarrier>>,
  assertCurrent: () => void,
) {
  const outcome = await carrier.runWorkspaceCommand({
    argv: ["node", "-e", "process.stdout.write('native-effect')"],
    transportRetry: "never",
    assertCurrent,
  });
  expect(outcome).toMatchObject({ code: 0, stdout: "native-effect" });
}
