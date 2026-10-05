import { sha256StableValue } from "@openclaw/normalization-core/node-crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { WorkerCredentialRecord } from "./credential.js";
import type { WorkerEnvironmentRecord } from "./environment-record.js";
import type { WorkerEnvironmentAttachmentRecord } from "./session-attachment.js";
import type { WorkerEnvironmentCommitAdmission, WorkerEnvironmentFacts } from "./store.types.js";

export function digestWorkerEnvironmentAuthority(
  environment: WorkerEnvironmentRecord | undefined,
): string {
  // Diagnostics cannot revoke a live environment reader; every other field can.
  return sha256StableValue(
    environment ? { ...environment, updatedAtMs: undefined, lastError: undefined } : null,
  ).digest;
}

export function digestWorkerCredentialAuthority(
  credential: WorkerCredentialRecord | undefined,
): string {
  return sha256StableValue(credential ?? null).digest;
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
    environmentAuthority: digestWorkerEnvironmentAuthority(environments.get(environmentId)),
    credentialAuthority: digestWorkerCredentialAuthority(credentials.get(environmentId)),
    transferAuthority: encodeWorkerEnvironmentTransferAuthority(
      environments.get(environmentId),
      credentials.get(environmentId),
    ),
  }));
}

export function isWorkerEnvironmentCommitAdmission(
  value: unknown,
): value is WorkerEnvironmentCommitAdmission {
  return (
    Array.isArray(value) &&
    value.every(
      (fact) =>
        isRecord(fact) &&
        typeof fact.environmentId === "string" &&
        typeof fact.environmentAuthority === "string" &&
        typeof fact.credentialAuthority === "string" &&
        typeof fact.transferAuthority === "string" &&
        typeof fact.attachmentAuthority === "string",
    )
  );
}
