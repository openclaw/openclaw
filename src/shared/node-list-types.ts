import type {
  RuntimeTargetIssue,
  WorkerSlotSummary,
} from "../../packages/gateway-protocol/src/schema/environments.js";
import type { NodePluginToolDescriptor } from "../../packages/gateway-protocol/src/schema/nodes.js";
import type { ComputerUseCapabilityDescriptor } from "../plugins/computer-use-contract.js";
import type { NodeHostStats } from "./node-host-stats.js";

export type NodeWorkerBundleStatus =
  | { status: "installed"; version: string }
  | { status: "missing" };

type NodeIdentityMetadata = {
  nodeId: string;
  displayName?: string;
  platform?: string;
  version?: string;
  coreVersion?: string;
  uiVersion?: string;
  remoteIp?: string;
};

/** Node record returned by gateway node-list endpoints. */
export type NodeListNode = NodeIdentityMetadata & {
  clientId?: string;
  clientMode?: string;
  /** This node host runs from the Gateway's own canonical node-host installation. */
  gatewayLocal?: boolean;
  deviceFamily?: string;
  modelIdentifier?: string;
  pathEnv?: string;
  caps?: string[];
  commands?: string[];
  computerUse?: ComputerUseCapabilityDescriptor;
  /** Node has explicitly enabled session hosting; live slots own current capacity. */
  sessionHost?: boolean;
  workerHost?: { deviceFolders?: true };
  workerSlots?: WorkerSlotSummary;
  hostStats?: NodeHostStats;
  workerBundle?: NodeWorkerBundleStatus;
  issues?: readonly RuntimeTargetIssue[];
  nodePluginTools?: NodePluginToolDescriptor[];
  permissions?: Record<string, boolean>;
  approvalState?: "approved" | "pending-approval" | "pending-reapproval" | "unapproved";
  pendingRequestId?: string;
  pendingDeclaredCaps?: string[];
  pendingDeclaredCommands?: string[];
  pendingDeclaredPermissions?: Record<string, boolean>;
  paired?: boolean;
  connected?: boolean;
  connectedAtMs?: number;
  lastConnectedAtMs?: number;
  lastDisconnectedAtMs?: number;
  lastActiveAtMs?: number;
  presenceUpdatedAtMs?: number;
  active?: boolean;
  lastSeenAtMs?: number;
  lastSeenReason?: string;
  approvedAtMs?: number;
};

/** Pending pairing/access request shown to operators. */
export type PendingRequest = NodeIdentityMetadata & {
  requestId: string;
  ts: number;
  commands?: string[];
  requiredApproveScopes?: Array<"operator.pairing" | "operator.write" | "operator.admin">;
};

/** Persisted paired node entry with permission metadata. */
export type PairedNode = NodeIdentityMetadata & {
  permissions?: Record<string, boolean>;
  createdAtMs?: number;
  approvedAtMs?: number;
  lastConnectedAtMs?: number;
  lastSeenAtMs?: number;
  lastSeenReason?: string;
};

/** Combined pairing list result used by CLI/UI node approval surfaces. */
export type PairingList = {
  pending: PendingRequest[];
  paired: PairedNode[];
};
