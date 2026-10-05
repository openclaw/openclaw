import type { WorkerAdmissionHandshake } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import type {
  WorkerDesktopEndpoint,
  WorkerProfile,
  WorkerLeaseRecoveryHold,
  WorkerSshEndpoint,
} from "../../plugins/capability-provider.types.js";
import type { WorkerSessionPlacementDispatchIdentity } from "./placement-record.js";
import type { WorkerEnvironmentLeasedState, WorkerEnvironmentUnleasedState } from "./state.js";

export type WorkerEnvironmentBootstrapReceipt = WorkerAdmissionHandshake & {
  /** Provenance only; admission authority remains the exact stored build identity. */
  installKind?: "bundle" | "local";
};
export type WorkerEnvironmentTeardownTerminalState = "destroyed" | "failed";
export type WorkerEnvironmentPreparation = {
  purpose: "reserve" | "build";
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
  recoveryHold?: WorkerEnvironmentCustodyHold;
  profileSnapshot: WorkerProfile;
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
  createdAtMs: number;
  updatedAtMs: number;
  stateChangedAtMs: number;
  lastActivatedAtMs: number | null;
  idleSinceAtMs: number | null;
  destroyRequestedAtMs: number | null;
};
type UnleasedRecord = {
  state: WorkerEnvironmentUnleasedState;
  leaseId: null;
  sshEndpoint: null;
};
type LeasedRecord = {
  state: WorkerEnvironmentLeasedState;
  leaseId: string;
  sshEndpoint: WorkerSshEndpoint | null;
};
export type WorkerEnvironmentRecord = RecordBase & (UnleasedRecord | LeasedRecord);
export type WorkerEnvironmentIntentInput = RecordIdentity & {
  preparation?: WorkerEnvironmentPreparationIntent;
  profileSnapshot: WorkerProfile;
  provisionOperationId: string;
};

export type WorkerEnvironmentRecoveryHold = WorkerSessionPlacementDispatchIdentity & {
  environmentId: string;
  ownerEpoch: number;
  placementGeneration: number;
  leaseId: string;
  phase: "requested" | "held" | "disposal-pending" | "reconciled";
  receipt?: WorkerLeaseRecoveryHold;
  createdAtMs: number;
  checkpointRef?: string;
  previousCheckpointRef?: string;
  remoteHeadCommit?: string;
  reconciledAtMs?: number;
  workspaceId?: string;
  acceptedWorkspaceRevision?: number;
  manifestHash?: string;
  diagnostic?: WorkerRecoveryDiagnostic;
  cleanup?: { requestedAtMs: number; providerReleasedAtMs?: number; settledAtMs?: number };
  disposalCheckpoint?: WorkerRecoveryCheckpoint;
};

export type WorkerRecoveryCheckpoint = Readonly<{
  workspaceId: string;
  expectedWorkspaceRevision: number;
  previousCheckpointRef: string;
  checkpointRef: string;
  manifestHash: string;
  /** Absent only for custody of an unchanged accepted checkpoint pending disposal. */
  remoteHeadCommit?: string;
}>;

/** Available failure facts only; collection never asserts an unobserved root cause. */
type WorkerRecoveryDiagnostic = {
  collectedAtMs: number;
  origin: "failed-placement" | "unused-prepared-worker";
  cause: "unverified";
  failureHash: string | null;
};

/** Unused preparation has no session or accepted checkpoint to impersonate. */
export type WorkerEnvironmentPreparedRecoveryHold = Pick<
  WorkerEnvironmentRecoveryHold,
  "environmentId" | "ownerEpoch" | "leaseId" | "receipt" | "createdAtMs" | "diagnostic" | "cleanup"
> & {
  kind: "prepared";
  preparationKey: string;
  phase: "requested" | "held";
  sessionId?: never;
  placementGeneration?: never;
};
export type WorkerEnvironmentCustodyHold =
  | (WorkerEnvironmentRecoveryHold & { kind?: "session" })
  | WorkerEnvironmentPreparedRecoveryHold;

/** Selection only. requestDestroy still validates exact custody and accepted state. */
export function isWorkerRecoveryDisposalCandidate(record: WorkerEnvironmentRecord): boolean {
  return (
    record.state === "orphaned" &&
    record.recoveryHold?.diagnostic !== undefined &&
    record.recoveryHold.phase !== "requested"
  );
}

export function isWorkerRecoveryDisposalSettled(
  record: Pick<WorkerEnvironmentRecord, "state" | "recoveryHold">,
): boolean {
  const cleanup = record.recoveryHold?.cleanup;
  return Boolean(
    record.state === "destroyed" &&
    cleanup &&
    Number.isSafeInteger(cleanup.requestedAtMs) &&
    cleanup.requestedAtMs >= 0 &&
    cleanup.providerReleasedAtMs !== undefined &&
    Number.isSafeInteger(cleanup.providerReleasedAtMs) &&
    cleanup.providerReleasedAtMs >= cleanup.requestedAtMs &&
    cleanup.settledAtMs !== undefined &&
    Number.isSafeInteger(cleanup.settledAtMs) &&
    cleanup.settledAtMs >= cleanup.providerReleasedAtMs,
  );
}

export function findActiveWorkerRecoveryHold(
  records: readonly WorkerEnvironmentRecord[],
  sessionId: string,
): WorkerEnvironmentRecoveryHold | undefined {
  const hold = records.find(
    (record) =>
      record.recoveryHold?.sessionId === sessionId && !isWorkerRecoveryDisposalSettled(record),
  )?.recoveryHold;
  return hold?.kind === "prepared" ? undefined : hold;
}

/** A checkpoint intent is not physical retirement of the previous executor. */
export function assertWorkerRecoveryExecutorReleased(
  record: Pick<WorkerEnvironmentRecord, "recoveryHold" | "ownerEpoch" | "leaseId" | "state"> & {
    sharedHost?: boolean | null;
  },
): void {
  const hold = record.recoveryHold;
  if (!hold) {
    return;
  }
  const compute = hold.receipt?.resources.filter((resource) => resource.kind === "vm") ?? [];
  if (
    hold.kind === "prepared" ||
    record.sharedHost !== false ||
    record.ownerEpoch !== hold.ownerEpoch ||
    record.leaseId !== hold.leaseId ||
    !(
      isWorkerRecoveryDisposalSettled(record) ||
      (hold.receipt?.status === "held" &&
        hold.receipt.leaseId === record.leaseId &&
        compute.length > 0 &&
        compute.every((resource) => resource.state === "absent"))
    )
  ) {
    throw new Error(
      "Previous worker physical cleanup is still pending; replacement allocation is fenced",
    );
  }
}
