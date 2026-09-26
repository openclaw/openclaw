import type { Selectable } from "kysely";
import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import type { WorkerEnvironments } from "../../state/openclaw-state-db.generated.js";
import type { WorkerCredentialRecord } from "./credential.js";
import type {
  WorkerEnvironmentIntentInput,
  WorkerEnvironmentPreparationIntent,
  WorkerEnvironmentRecord,
  WorkerEnvironmentTeardownTerminalState,
} from "./environment-record.js";
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
};
export type WorkerEnvironmentCommitAdmission = Array<{
  environmentId: string;
  recordAuthority: string;
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
type WorkerEnvironmentMutationInput<Method extends WorkerEnvironmentMutationMethod> =
  WithoutAdmission<Parameters<WorkerEnvironmentMutationMethods[Method]>[0]>;

type WorkerEnvironmentMutationReceipt<Result> = {
  result: Result;
  changed: boolean;
  facts: WorkerEnvironmentFacts;
};
export type WorkerEnvironmentWorkerOperations = {
  [Method in WorkerEnvironmentMutationMethod as `workerEnvironments.${Method}`]: {
    input: { input: WorkerEnvironmentMutationInput<Method>; nowMs?: number };
    output: WorkerEnvironmentMutationReceipt<ReturnType<WorkerEnvironmentMutationMethods[Method]>>;
  };
} & {
  "workerEnvironments.initialize": {
    input: { nowMs?: number };
    output: WorkerEnvironmentMutationReceipt<undefined>;
  };
};

export function isWorkerEnvironmentCommand(command: {
  type: string;
  input: unknown;
}): command is SqliteWorkerCommand<WorkerEnvironmentWorkerOperations> {
  return command.type.startsWith("workerEnvironments.");
}
