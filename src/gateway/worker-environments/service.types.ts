import type { GatewayScheduler } from "../../infra/gateway-scheduler.js";
import type { WorkerExecutionMode, WorkerProfile } from "../../plugins/types.js";
import type { WorkerEnvironmentNodeTunnel } from "./environment-access.js";
import type { WorkerInferenceStore } from "./inference-store.js";
import type { WorkerInferenceExecutor } from "./inference.js";
import type { WorkerLiveEventReceiver } from "./live-events.js";
import type { WorkerNodeDesktopCarrier } from "./node-desktop-carrier.js";
import type { WorkerSessionPlacementGate } from "./placement-worker-gate.js";
import type { WorkerNodePortalCarrier } from "./portal-node-carrier.js";
import type { WorkerProviderPreparedIntent } from "./preparation-identity.js";
import type { WorkerProviderLifecycleInputOptions } from "./provider-lifecycle.types.js";
import type { WorkerEnvironmentSessionAttachmentOptions } from "./session-attachment-service.js";
import type { WorkerTranscriptCommitApplication } from "./transcript-commit.js";
import type { WorkerTunnelManager } from "./tunnel.js";
import type { createWorkerTurnRpc } from "./worker-turn-rpc.js";

export type WorkerEnvironmentCreateRequest = {
  profileId: string;
  idempotencyKey: string;
  machineClass?: string;
  executionMode?: WorkerExecutionMode;
  projectPath?: string;
  signal?: AbortSignal;
  os?: string;
  runSetupScript?: boolean;
  inheritedProfile?: { providerId: string; profileSnapshot: WorkerProfile };
  admittedIntent?: WorkerProviderPreparedIntent;
};

export type WorkerEnvironmentServiceErrorCode =
  | "profile_not_found"
  | "provider_not_found"
  | "environment_not_found"
  | "invalid_profile"
  | "invalid_project"
  | "capacity"
  | "invalid_state"
  | "desktop_app_not_found"
  | "unsupported_platform"
  | "launcher_failure"
  | "provider_failure"
  | "bootstrap_failure";

export type WorkerEnvironmentServiceOptions = WorkerProviderLifecycleInputOptions &
  WorkerEnvironmentSessionAttachmentOptions & {
    prepareComputer?: (
      claim: import("./placement-store.js").WorkerSessionTurnClaim,
    ) => Promise<import("./computer-transport.js").PreparedWorkerComputer | undefined>;
    executeComputer?: import("./worker-turn-computer-rpc.js").WorkerComputerExecutor;
    closeComputers?: () => Promise<void>;
    tunnelManager?: WorkerTunnelManager;
    nodeTunnelManager?: WorkerEnvironmentNodeTunnel;
    nodeDesktopCarrier?: WorkerNodeDesktopCarrier;
    nodePortalCarrier?: WorkerNodePortalCarrier;
    closeWorkerPortals?: (environmentId: string, ownerEpoch?: number) => Promise<void>;
    stopNodeEnrollmentWaits?: () => void;
    closeNodeBootstrapArtifacts?: () => Promise<void>;
    stopNodeWorkerBundleTransfers?: () => void;
    maintainProviders?: (signal: AbortSignal) => Promise<void>;
    scheduler: GatewayScheduler;
    reconcileIntervalMs?: number;
    bootstrapCallTimeoutMs?: number;
    workerCredentialTtlMs?: number;
    generateWorkerCredential?: (bytes: number) => string;
    now?: () => number;
    logger?: { warn: (message: string) => void };
    applyTranscriptCommit?: WorkerTranscriptCommitApplication;
    liveEvents?: Pick<
      WorkerLiveEventReceiver,
      "apply" | "clear" | "clearEnvironment" | "rotateCredential"
    >;
    executeInference: WorkerInferenceExecutor;
    inferenceStore?: WorkerInferenceStore;
    placementStore?: WorkerSessionPlacementGate;
    executeSessionTool?: Parameters<typeof createWorkerTurnRpc>[0]["executeSessionTool"];
  };

export type WorkerEnvironmentReconcileCore = (
  signal?: AbortSignal,
  retainProviderSettlement?: (settled: Promise<void>) => void,
) => Promise<void>;
export type WorkerEnvironmentReconcileGuard = (
  environmentId: string,
  reconcileCore: WorkerEnvironmentReconcileCore,
) => Promise<void>;
