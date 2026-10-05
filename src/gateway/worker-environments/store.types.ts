import type { Selectable } from "kysely";
import type { WorkerEnvironments } from "../../state/openclaw-state-db.generated.js";
import type { RepositoryWorkspaceMutationResult } from "../../state/session-repository-workspaces.types.js";
import type { WorkerCredentialRecord } from "./credential.js";
import type {
  WorkerEnvironmentIntentInput,
  WorkerEnvironmentPreparationIntent,
  WorkerEnvironmentRecord,
  WorkerEnvironmentRecoveryHold,
  WorkerEnvironmentPreparedRecoveryHold,
  WorkerEnvironmentTeardownTerminalState,
} from "./environment-record.js";
import type { WorkerSessionPlacementRecord } from "./placement-record.js";
import type { RetainedWorkerRecoveryAcceptance } from "./recovery-hold-store.js";
import type {
  WorkerEnvironmentAttachmentRecord,
  WorkerEnvironmentSessionIdentity,
} from "./session-attachment.js";
import type { WorkerEnvironmentState } from "./state.js";
import type {
  BootstrapRefreshInput,
  CredentialInput,
  CredentialRevocationInput,
  TransitionInput,
} from "./store-write-types.js";

export type WorkerRecoveryPublication = {
  workspace: RepositoryWorkspaceMutationResult;
  placement: Extract<WorkerSessionPlacementRecord, { state: "reclaimed" }>;
};
export type WorkerEnvironmentFacts = {
  ids: string[];
  environments: WorkerEnvironmentRecord[];
  credentials: WorkerCredentialRecord[];
  attachments: WorkerEnvironmentAttachmentRecord[];
};
export type WorkerEnvironmentCommitAdmission = Array<{
  environmentId: string;
  environmentAuthority: string;
  credentialAuthority: string;
  transferAuthority: string;
  attachmentAuthority: string;
}>;
export type WorkerEnvironmentPruneCursor = { changedAtMs: number; environmentId: string };
export type WorkerEnvironmentPruneObservation = Selectable<WorkerEnvironments>;
export type WorkerEnvironmentPruneReadInput = {
  nowMs: number;
  limit?: number;
  cursor?: WorkerEnvironmentPruneCursor;
};
export type WorkerEnvironmentPrunePage = {
  candidates: Array<{
    observed: WorkerEnvironmentPruneObservation;
    record: WorkerEnvironmentRecord;
  }>;
  nextCursor?: WorkerEnvironmentPruneCursor;
  limit: number;
};

/** Native mutation signatures own the host callbacks and the worker's serializable contract. */
export type WorkerEnvironmentMutationMethods = {
  retainPreparedEnvironment(
    input: WorkerEnvironmentPreparedRecoveryHold & { capacity: number; assertCurrent?: () => void },
  ): WorkerEnvironmentRecord;
  retainFailedEnvironment(
    input: WorkerEnvironmentRecoveryHold & { capacity: number; assertCurrent?: () => void },
  ): WorkerEnvironmentRecord;
  acceptRetainedRecovery(
    input: RetainedWorkerRecoveryAcceptance & { assertCurrent?: () => void },
  ): Extract<WorkerSessionPlacementRecord, { state: "failed" | "reclaimed" }>;
  createIntent(input: WorkerEnvironmentIntentInput): WorkerEnvironmentRecord;
  ensureNodeEnrollment(environmentId: string): WorkerEnvironmentRecord;
  revokeEnvironmentCredential(input: CredentialRevocationInput): void;
  reconcileSharedHost(input: {
    environmentId: string;
    state: WorkerEnvironmentState;
    leaseId: string;
    sharedHost: boolean;
  }): WorkerEnvironmentRecord;
  adoptProvisionCleanupFailure(input: {
    environmentId: string;
    leaseId: string;
    lastError: string;
    terminalState?: WorkerEnvironmentTeardownTerminalState;
    assertCurrent?: () => void;
  }): WorkerEnvironmentRecord;
  requestDestroy(input: {
    environmentId: string;
    state: WorkerEnvironmentState;
    terminalState?: WorkerEnvironmentTeardownTerminalState;
    assertCurrent?: () => void;
    lastError?: string;
    /** Facts captured only after the exact provider destroy call settles. */
    providerRelease?: { leaseId: string; ownerEpoch: number };
  }): WorkerEnvironmentRecord;
  refreshBootstrapReceipt(input: BootstrapRefreshInput): WorkerEnvironmentRecord;
  transition(input: TransitionInput): WorkerEnvironmentRecord;
  renewCredential(
    input: CredentialInput & {
      environmentId: string;
      expectedOwnerEpoch: number;
      assertCurrent?: () => void;
    },
  ): WorkerCredentialRecord;
  markCredentialDelivered(input: {
    environmentId: string;
    credentialHash: string;
    ownerEpoch: number;
    sessionId: string | null;
    deliveredAtMs: number;
    assertCurrent?: () => void;
  }): void;
  recordError(input: {
    environmentId: string;
    state: WorkerEnvironmentState;
    error: string;
    assertCurrent?: () => void;
  }): WorkerEnvironmentRecord;
  ensurePreparedIntent(input: {
    intent: WorkerEnvironmentIntentInput & { preparation: WorkerEnvironmentPreparationIntent };
    projectKey: string;
    target: number;
    maxTotal: number;
    assertCurrent: () => void;
  }): WorkerEnvironmentRecord | undefined;
  requestPreparedDestroy(input: {
    environmentId: string;
    ownerEpoch: number;
    preparationKey: string;
    reason: "expired" | "invalidated";
    assertCurrent: () => void;
  }): WorkerEnvironmentRecord | undefined;
  createSessionAttachmentIntent(
    input: WorkerEnvironmentIntentInput & WorkerEnvironmentSessionIdentity,
    assertCurrent: () => void,
  ): { attachment: WorkerEnvironmentAttachmentRecord; environment: WorkerEnvironmentRecord };
  closeSessionAttachment(
    sessionId: string,
    assertCurrent?: () => void,
  ): WorkerEnvironmentAttachmentRecord | undefined;
  cancelSessionAttachmentReservation(record: WorkerEnvironmentAttachmentRecord): void;
  touchSessionAttachment(
    record: WorkerEnvironmentAttachmentRecord,
    assertCurrent: () => void,
  ): void;
  pruneTerminalEnvironments(input: { approved: WorkerEnvironmentPruneObservation[] }): number;
};
type WorkerEnvironmentMutationMethod = keyof WorkerEnvironmentMutationMethods;

// Runtime closures stay with the host's transaction and commit admission owner.
type WithoutAdmission<T> = T extends object
  ? Omit<T, "assertCurrent" | "placementBinding"> &
      (T extends { placementBinding?: infer Binding }
        ? { placementBinding?: Omit<NonNullable<Binding>, "assertCurrent"> }
        : unknown)
  : T;
export type WorkerEnvironmentMutationInput<Method extends WorkerEnvironmentMutationMethod> =
  WithoutAdmission<Parameters<WorkerEnvironmentMutationMethods[Method]>[0]>;
