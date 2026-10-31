import type { AnyAgentTool } from "../../agents/tools/common.js";
import type { CloudWorkerSetupMutationAdmission } from "../../infra/device-bootstrap.worker-types.js";
import type { GatewayScheduler } from "../../infra/gateway-scheduler.js";
import type { WorkerExecutionMode, WorkerProfile } from "../../plugins/types.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import type { WorkerEnvironmentNodeTunnel } from "./environment-access.js";
import type { WorkerInferenceStore } from "./inference-store.js";
import type { WorkerLiveEventReceiver } from "./live-events.js";
import type { WorkerNodeDesktopCarrier } from "./node-desktop-carrier.js";
import type { WorkerNodePortalCarrier } from "./portal-node-carrier.js";
import type { WorkerProviderPreparedIntent } from "./preparation-identity.js";
import type { PreparedPoolPresenceOptions } from "./prepared-pool-presence.js";
import type { WorkerProviderLifecycleInputOptions } from "./provider-lifecycle.types.js";
import type { WorkerEnvironmentSessionAttachmentOptions } from "./session-attachment-service.js";
import type { WorkerTranscriptCommitApplication } from "./transcript-commit.js";
import type { WorkerTunnelManager } from "./tunnel.js";

export type WorkerEnvironmentCreateRequest = {
  profileId: string;
  idempotencyKey: string;
  /** Internal opt-in; profile defaults and prepared reserves remain fixed-lease. */
  retainedPolicy?: import("../../plugins/worker-retention.types.js").WorkerRetentionPolicy;
  machineClass?: string;
  executionMode?: WorkerExecutionMode;
  projectPath?: string;
  signal?: AbortSignal;
  os?: string;
  runSetupScript?: boolean;
  inheritedProfile?: { providerId: string; profileSnapshot: WorkerProfile };
  admittedIntent?: WorkerProviderPreparedIntent;
  /** Revalidate caller authority after preparation, immediately before provider effects. */
  beforeProvision?: () => void;
};

export type WorkerEnvironmentServiceOptions = WorkerProviderLifecycleInputOptions &
  Pick<PreparedPoolPresenceOptions, "resolveHumanPresenceDemand" | "presenceDemandStore"> &
  WorkerEnvironmentSessionAttachmentOptions & {
    resolveGatewayContext?: import("../server-methods/types.js").GatewayContextResolver;
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
    admitsNodeSetupCompletion?: (setup: CloudWorkerSetupMutationAdmission) => boolean;
    closeNodeBootstrapArtifacts?: () => Promise<void>;
    stopNodeWorkerBundleTransfers?: () => void | Promise<void>;
    maintainProviders?: (signal: AbortSignal) => Promise<void>;
    scheduler: GatewayScheduler;
    reconcileIntervalMs?: number;
    bootstrapCallTimeoutMs?: number;
    workerCredentialTtlMs?: number;
    generateWorkerCredential?: (bytes: number) => string;
    logger?: { warn: (message: string) => void };
    applyTranscriptCommit?: WorkerTranscriptCommitApplication;
    liveEvents?: Pick<
      WorkerLiveEventReceiver,
      "apply" | "clear" | "clearEnvironment" | "rotateCredential"
    >;
    inferenceStore?: WorkerInferenceStore;
    createGatewayTools?: (params: {
      identity: WorkerConnectionIdentity;
      inheritedToolPolicySource?: "sender";
      inheritedToolDenylist?: string[];
      delegatedToolPolicyActive?: boolean;
      skillWorkshop?: AnyAgentTool;
      portalAvailable?: boolean;
      prepareTools?: (adapters: AnyAgentTool[]) => AnyAgentTool[] | Promise<AnyAgentTool[]>;
    }) => Promise<AnyAgentTool[]>;
  };
