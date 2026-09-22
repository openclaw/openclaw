import type {
  WorkerDesktopEndpoint,
  WorkerSshEndpoint,
} from "../../plugins/capability-provider.types.js";
import type {
  PreparedEnvironmentPlacementBinding,
  WorkerEnvironmentBootstrapReceipt,
  WorkerEnvironmentRecord,
} from "./environment-record.js";
import type { WorkerEnvironmentState } from "./state.js";

export type WorkerEnvironmentTransitionPatch = {
  leaseId?: string | null;
  nodeDeviceId?: string | null;
  sshEndpoint?: WorkerSshEndpoint | null;
  sharedHost?: boolean;
  desktop?: WorkerDesktopEndpoint | null;
  bootstrapReceipt?: WorkerEnvironmentBootstrapReceipt;
  attachedSessionIds?: readonly string[];
  lastError?: string | null;
  credential?: CredentialInput;
};
export type CredentialInput = {
  credentialHash: string;
  sessionId: string | null;
  rpcSetVersion: number;
  expiresAtMs: number;
};
export type CredentialRevocationInput = {
  environmentId: string;
  expectedOwnerEpoch?: number;
};
export type TransitionInput = {
  assertCurrent?: () => void;
  environmentId: string;
  from: WorkerEnvironmentState;
  to: WorkerEnvironmentState;
  expectedOwnerEpoch?: number;
  placementBinding?: PreparedEnvironmentPlacementBinding;
  patch?: WorkerEnvironmentTransitionPatch;
};
export type BootstrapRefreshInput = {
  environmentId: string;
  expectedOwnerEpoch: number;
  expectedNodeDeviceId: string | null;
  expectedBootstrapReceipt: WorkerEnvironmentBootstrapReceipt;
  bootstrapReceipt: WorkerEnvironmentBootstrapReceipt;
  assertCurrent: () => void;
} & (
  | { expectedState: "attached"; expectedPlacementGeneration: number }
  | { expectedState: "ready" | "idle"; expectedPlacementGeneration?: never }
);
export type WorkerEnvironmentPruneInput = {
  nowMs?: number;
  limit?: number;
  canPruneDemand?: (record: WorkerEnvironmentRecord, nowMs: number) => boolean;
};
