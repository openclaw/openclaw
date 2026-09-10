import type { WorkerAdmissionHandshake } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import type {
  WorkerDesktopEndpoint,
  WorkerProfile,
  WorkerSshEndpoint,
} from "../../plugins/capability-provider.types.js";
import type { WorkerSessionPlacementDispatchIdentity } from "./placement-record.js";
import type { WorkerEnvironmentLeasedState, WorkerEnvironmentUnleasedState } from "./state.js";

type WorkerEnvironmentProfileSnapshot = WorkerProfile;
type WorkerEnvironmentSshEndpoint = WorkerSshEndpoint;
type WorkerBootstrapInstallKind = "bundle" | "local";
export type WorkerEnvironmentBootstrapReceipt = WorkerAdmissionHandshake & {
  /** Provenance only; admission authority remains the exact stored build identity. */
  installKind?: WorkerBootstrapInstallKind;
};
export type WorkerEnvironmentTeardownTerminalState = "destroyed" | "failed";
export type WorkerEnvironmentPreparation = {
  key: string;
  demandAtMs: number;
  expiresAtMs: number;
  consumedAtMs: number | null;
};
export type WorkerEnvironmentPreparationIntent = Omit<WorkerEnvironmentPreparation, "consumedAtMs">;
export type PreparedEnvironmentPlacementBinding = WorkerSessionPlacementDispatchIdentity & {
  generation: number;
  preparationKey: string;
  assertCurrent: () => void;
};
export type PreparedEnvironmentSelection = WorkerSessionPlacementDispatchIdentity & {
  expectedGeneration: number;
  environmentId: string;
  ownerEpoch: number;
  providerId: string;
  profileId: string;
  preparationKey: string;
  nodeDeviceId: string;
  leaseId: string;
  bundleHash: string;
  assertCurrent: () => void;
};
type RecordIdentity = { environmentId: string; providerId: string; profileId: string };
type RecordBase = RecordIdentity & {
  profileSnapshot: WorkerEnvironmentProfileSnapshot;
  preparation: WorkerEnvironmentPreparation | null;
  provisionOperationId: string;
  nodeSetupId: string | null;
  nodeDeviceId: string | null;
  sharedHost: boolean | null;
  desktop: WorkerDesktopEndpoint | null;
  bootstrapReceipt: WorkerEnvironmentBootstrapReceipt | null;
  ownerEpoch: number;
  teardownTerminalState: WorkerEnvironmentTeardownTerminalState | null;
  attachedSessionIds: string[];
  lastError: string | null;
} & { createdAtMs: number; updatedAtMs: number; stateChangedAtMs: number } & {
  lastActivatedAtMs: number | null;
  idleSinceAtMs: number | null;
  destroyRequestedAtMs: number | null;
};
type Ssh = WorkerEnvironmentSshEndpoint;
type UnleasedRecord = {
  state: WorkerEnvironmentUnleasedState;
  leaseId: null;
  sshEndpoint: null;
};
type LeasedRecord = {
  state: WorkerEnvironmentLeasedState;
  leaseId: string;
  sshEndpoint: Ssh | null;
};
export type WorkerEnvironmentRecord = RecordBase & (UnleasedRecord | LeasedRecord);
export type WorkerEnvironmentIntentInput = RecordIdentity & {
  preparation?: WorkerEnvironmentPreparationIntent;
  profileSnapshot: WorkerEnvironmentProfileSnapshot;
  provisionOperationId: string;
};
