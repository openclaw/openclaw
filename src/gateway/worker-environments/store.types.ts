import type { WorkerResourceReceipt } from "../../plugins/capability-provider.types.js";
import type { WorkerCredentialRecord } from "./credential.js";
import type {
  WorkerEnvironmentIntentInput,
  WorkerEnvironmentPreparationIntent,
  WorkerEnvironmentRecord,
  WorkerEnvironmentTeardownTerminalState,
} from "./environment-record.js";
import type { WorkerSessionPlacementRecord } from "./placement-record.js";
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

export type WorkerEnvironmentFacts = {
  ids: string[];
  environments: WorkerEnvironmentRecord[];
  credentials: WorkerCredentialRecord[];
  attachments: WorkerEnvironmentAttachmentRecord[];
  placements?: WorkerSessionPlacementRecord[];
};
export type WorkerEnvironmentCommitAdmission = Array<{
  environmentId: string;
  environmentAuthority: string;
  credentialAuthority: string;
  transferAuthority: string;
  attachmentAuthority: string;
}>;

/** Native mutation signatures own the host callbacks and the worker's serializable contract. */
export type WorkerEnvironmentMutationMethods = {
  createIntent(input: WorkerEnvironmentIntentInput): WorkerEnvironmentRecord;
  recordResourceReceipt(input: {
    environmentId: string;
    provisionOperationId: string;
    receipt: WorkerResourceReceipt;
    assertCurrent: () => void;
  }): WorkerEnvironmentRecord;
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
  }): WorkerEnvironmentRecord;
  requestDestroy(input: {
    environmentId: string;
    state: WorkerEnvironmentState;
    terminalState?: WorkerEnvironmentTeardownTerminalState;
    assertCurrent?: () => void;
    lastError?: string;
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
  pruneTerminalEnvironments(input: {
    environmentIds: string[];
    cutoffMs: number;
    limit: number;
  }): number;
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
