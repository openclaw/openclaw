import { stableStringify } from "@openclaw/normalization-core";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";

export const CREATION_OPERATION_VALIDITY_MS = 30 * 24 * 60 * 60 * 1000;
export const CREATION_OPERATION_FUTURE_SKEW_MS = 60_000;
export type SessionCreationOperation = {
  digest: string;
  requestFingerprint: string;
  sessionId: string;
  issuedAt: number;
  expiresAt: number;
};

export class SessionCreationOperationError extends Error {
  readonly code: string;
  constructor(
    public readonly reason:
      | "creation-operation-invalid"
      | "creation-operation-expired"
      | "creation-operation-conflict"
      | "creation-session-unavailable",
    message: string,
  ) {
    super(message);
    this.code = reason;
    this.name = "SessionCreationOperationError";
  }
}

export function assertSessionCreationOperationTime(
  operation: Pick<SessionCreationOperation, "issuedAt" | "expiresAt" | "sessionId">,
  now: number,
): void {
  const uuid = operation.sessionId;
  const uuidTimestamp =
    /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(uuid)
      ? Number.parseInt(uuid.replaceAll("-", "").slice(0, 12), 16)
      : Number.NaN;
  if (uuidTimestamp !== operation.issuedAt) {
    throw new SessionCreationOperationError(
      "creation-operation-invalid",
      "Creation requires a canonical UUIDv7 with the operation's exact issuance timestamp.",
    );
  }
  if (
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(operation.issuedAt) ||
    operation.issuedAt <= 0 ||
    !Number.isSafeInteger(operation.expiresAt) ||
    operation.expiresAt !== operation.issuedAt + CREATION_OPERATION_VALIDITY_MS ||
    operation.issuedAt > now + CREATION_OPERATION_FUTURE_SKEW_MS
  ) {
    throw new SessionCreationOperationError(
      "creation-operation-invalid",
      "Creation operation time is invalid.",
    );
  }
  // Admission precedes lookup, including after physical receipt pruning.
  if (now >= operation.expiresAt) {
    throw new SessionCreationOperationError(
      "creation-operation-expired",
      "Creation operation expired; a new explicit creation intent is required.",
    );
  }
}

export function prepareSessionCreationOperation(
  principal: string,
  operationId: string,
  sessionId: string,
  params: Record<string, unknown>,
  now: number,
): SessionCreationOperation {
  const match = /^v1([:-])([1-9][0-9]{0,15})\1([a-f0-9]{32})$/.exec(operationId);
  if (
    !principal ||
    !match ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(sessionId)
  ) {
    throw new SessionCreationOperationError(
      "creation-operation-invalid",
      "Creation requires a canonical operation identity and physical UUID.",
    );
  }
  const issuedAt = Number(match[2]);
  const operation = {
    digest: sha256Hex(JSON.stringify(["openclaw.session.creation.v1", principal, operationId])),
    requestFingerprint: sha256Hex(stableStringify(params)),
    sessionId,
    issuedAt,
    expiresAt: issuedAt + CREATION_OPERATION_VALIDITY_MS,
  };
  assertSessionCreationOperationTime(operation, now);
  return operation;
}

/** The existing SQLite worker error envelope retains name/code, not prototypes. */
export function readSessionCreationOperationError(
  error: unknown,
): { reason: string; message: string } | undefined {
  if (error instanceof SessionCreationOperationError) {
    return error;
  }
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const candidate = error as { name?: unknown; code?: unknown; message?: unknown };
  if (
    candidate.name !== "SessionCreationOperationError" ||
    typeof candidate.message !== "string" ||
    ![
      "creation-operation-invalid",
      "creation-operation-expired",
      "creation-operation-conflict",
      "creation-session-unavailable",
    ].includes(String(candidate.code))
  ) {
    return undefined;
  }
  return { reason: String(candidate.code), message: candidate.message };
}
