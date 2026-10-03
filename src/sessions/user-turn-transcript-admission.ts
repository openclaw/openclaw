import type { TranscriptEntryAnchor } from "../config/sessions/transcript-entry-anchor.js";
import { copyTranscriptEntryProvenance } from "../config/sessions/transcript-entry-provenance.js";
import type { DatabaseFileIdentity } from "../infra/sqlite-worker-identity.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type {
  PersistedUserTurnMessage,
  UserTurnTranscriptAdmissionReceipt,
  UserTurnTranscriptRecorder,
} from "./user-turn-transcript.types.js";

type AdmissionOwner = {
  receipt: () => UserTurnTranscriptAdmissionReceipt | undefined;
  message: () => PersistedUserTurnMessage | undefined;
  blocked: () => boolean;
  sentToProvider: () => boolean;
  restrictSourceDatabase: (identity: DatabaseFileIdentity) => void;
  refresh: (
    admission: UserTurnTranscriptAdmissionReceipt,
    message: PersistedUserTurnMessage,
  ) => void;
};

// Only the recorder factory registers an owner; copied SDK values cannot bind one.
const admissionOwners = resolveGlobalSingleton(
  Symbol.for("openclaw.userTurnTranscriptAdmissionOwners"),
  () => new WeakMap<UserTurnTranscriptRecorder, AdmissionOwner>(),
);

export function restrictUserTurnTranscriptSourceDatabase(
  recorder: UserTurnTranscriptRecorder,
  identity: DatabaseFileIdentity,
): void {
  const owner = admissionOwners.get(recorder);
  if (!owner) {
    throw new Error("ACP source input requires its original transcript persistence owner.");
  }
  owner.restrictSourceDatabase(identity);
}

export function registerUserTurnTranscriptAdmissionOwner(
  recorder: UserTurnTranscriptRecorder,
  owner: AdmissionOwner,
): void {
  admissionOwners.set(recorder, owner);
}

export function getUserTurnTranscriptAdmissionOwner(
  recorder: UserTurnTranscriptRecorder,
): AdmissionOwner | undefined {
  return admissionOwners.get(recorder);
}

/** Snapshot only the factory-owned input that has not crossed its foreground model boundary. */
export function readPendingUserTurnTranscriptAdmission(
  recorder: UserTurnTranscriptRecorder | undefined,
): UserTurnTranscriptAdmissionReceipt | undefined {
  const owner = recorder ? admissionOwners.get(recorder) : undefined;
  if (!owner || owner.blocked() || owner.sentToProvider()) {
    return undefined;
  }
  const receipt = owner.receipt();
  if (!receipt) {
    return undefined;
  }
  const snapshot = { ...receipt };
  copyTranscriptEntryProvenance(receipt, snapshot);
  return snapshot;
}

export function resolveUserTurnTranscriptAdmission(params: {
  logicalTurnId: string;
  receipt: TranscriptEntryAnchor | UserTurnTranscriptAdmissionReceipt;
}): UserTurnTranscriptAdmissionReceipt {
  const admission: UserTurnTranscriptAdmissionReceipt =
    "logicalTurnId" in params.receipt
      ? params.receipt
      : {
          ...params.receipt,
          logicalTurnId: params.logicalTurnId,
          role: "user",
        };
  copyTranscriptEntryProvenance(params.receipt, admission);
  return admission;
}
