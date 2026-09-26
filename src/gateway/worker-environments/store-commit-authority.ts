import { sha256StableValue } from "@openclaw/normalization-core/node-crypto";
import type { WorkerCredentialRecord } from "./credential.js";
import type { WorkerEnvironmentRecord } from "./environment-record.js";
import type { WorkerEnvironmentAttachmentRecord } from "./session-attachment.js";
import type {
  WorkerEnvironmentCommitAdmission,
  WorkerEnvironmentFacts,
} from "./store-worker-contract.js";

export function digestWorkerEnvironmentRecordAuthority(
  environment: WorkerEnvironmentRecord | undefined,
  credential: WorkerCredentialRecord | undefined,
): string {
  // Diagnostics cannot revoke a live reader; every other environment and credential field can.
  return sha256StableValue([
    environment ? { ...environment, updatedAtMs: undefined, lastError: undefined } : null,
    credential ?? null,
  ]).digest;
}

/** Equality facts only; transfer admission still checks the current owner and capability. */
export function encodeWorkerEnvironmentTransferAuthority(
  environment:
    | Pick<
        WorkerEnvironmentRecord,
        "state" | "ownerEpoch" | "destroyRequestedAtMs" | "attachedSessionIds"
      >
    | undefined,
  credential: Pick<WorkerCredentialRecord, "ownerEpoch" | "sessionId"> | undefined,
): string {
  // Workspace capabilities retain their own TTL across RPC credential rotation and expiry.
  return JSON.stringify([
    environment
      ? [
          environment.state,
          environment.ownerEpoch,
          environment.destroyRequestedAtMs,
          environment.attachedSessionIds,
        ]
      : null,
    credential ? [credential.ownerEpoch, credential.sessionId] : null,
  ]);
}

export function digestWorkerEnvironmentAttachmentAuthority(
  attachment: WorkerEnvironmentAttachmentRecord | undefined,
): string {
  // Activity timestamps also participate in idle-cleanup guards.
  return sha256StableValue(attachment ?? null).digest;
}

export function createWorkerEnvironmentCommitAdmission(
  facts: WorkerEnvironmentFacts,
): WorkerEnvironmentCommitAdmission {
  const environments = new Map(facts.environments.map((row) => [row.environmentId, row]));
  const credentials = new Map(facts.credentials.map((row) => [row.environmentId, row]));
  const attachments = new Map(facts.attachments.map((row) => [row.environmentId, row]));
  return facts.ids.map((environmentId) => ({
    environmentId,
    attachmentAuthority: digestWorkerEnvironmentAttachmentAuthority(attachments.get(environmentId)),
    recordAuthority: digestWorkerEnvironmentRecordAuthority(
      environments.get(environmentId),
      credentials.get(environmentId),
    ),
    transferAuthority: encodeWorkerEnvironmentTransferAuthority(
      environments.get(environmentId),
      credentials.get(environmentId),
    ),
  }));
}
