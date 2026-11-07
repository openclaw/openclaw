import type { WorkerAdmissionHandshake } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { Deferred } from "../../shared/deferred.js";
import type { NodeWorkerSupervisorTransport } from "../node-registry-private.js";
import type { createNodeWorkerLaunchAdapter } from "./node-launch-adapter.js";
import type { NodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";
import type { WorkerSessionTurnClaim } from "./placement-record.js";
import type { WorkerEnvironmentRecord } from "./store.js";
import type { WorkerTunnelStopReason, WorkerTurnTunnelHandle } from "./tunnel-contract.js";

export type NodeWorkerTunnelManagerOptions = {
  gatewayDeviceId: string;
  getEnvironment: (environmentId: string) => WorkerEnvironmentRecord | undefined;
  listEnvironments: () => readonly WorkerEnvironmentRecord[];
  getTransport: () => NodeWorkerSupervisorTransport | undefined;
  launchNodeWorker: ReturnType<typeof createNodeWorkerLaunchAdapter>["launch"];
  validateWorkerTurn: (claim: WorkerSessionTurnClaim) => boolean;
  workspaceTransfer: NodeWorkspaceTransferService;
};

export type NodeWorkerTunnelStartRequest = {
  executionMode: "worker-turn" | "remote-exec";
  environmentId: string;
  ownerEpoch: number;
  deviceId: string;
  sessionId: string;
  expectedBuild: WorkerAdmissionHandshake;
  authorize?: () => void;
};

export type NodeEnvironmentOwner = Omit<
  NodeWorkerTunnelStartRequest,
  "expectedBuild" | "authorize"
> & {
  stopPromise?: Promise<void>;
  stopReason?: WorkerTunnelStopReason;
  drainLocalWork?: () => Promise<void>;
  deviceFolder?: string;
};

export type NodeTunnelEntry = NodeEnvironmentOwner & {
  expectedBuild: WorkerAdmissionHandshake;
  abortController: AbortController;
  handle?: WorkerTurnTunnelHandle;
  initialization?: Promise<void>;
  launchTasks: Set<Promise<unknown>>;
  workspaceTasks: Set<Promise<unknown>>;
  nativeWorkspaceLeases: Set<string>;
  readiness: Deferred<WorkerTurnTunnelHandle>;
};

export type NodeWorkerWorkspaceBinding = {
  source:
    | { kind: "local"; path: string }
    | { kind: "device-folder"; deviceId: string; path: string }
    | { kind: "repository"; baseCommit: string; baseManifestRef: string };
  manifestRef: string;
  remoteWorkspaceDir: string;
  sessionKey?: string;
};
