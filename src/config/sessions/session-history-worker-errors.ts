import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import {
  encodeOpenClawStateWorkerError,
  hydrateOpenClawStateWorkerError,
  retainOpenClawStateWorkerErrorPayload,
} from "../../state/openclaw-state-worker-error.js";
import { SessionTranscriptColdError } from "./session-cold-storage-state.js";
import type { SessionHistoryDelta } from "./session-history-types.js";
import {
  SessionTranscriptProjectionUnavailableError,
  SessionTranscriptStorageUnavailableError,
} from "./session-transcript-projection-error.js";
import { SessionTranscriptReadFenceError } from "./session-transcript-read-fence.js";
import type { SessionTranscriptWorkerReadError } from "./session-transcript-worker-error.types.js";
import type {
  SessionTranscriptWorkerReply,
  SessionTranscriptWorkerValues,
} from "./session-transcript-worker.types.js";

/** A later display reset may leave this failed visibility lookup unconsumed. */
export class SessionHistoryDeltaPreparationError extends Error {
  constructor(
    readonly partial: SessionHistoryDelta,
    cause?: unknown,
  ) {
    super("Session history visibility preparation failed", { cause });
  }
}

export function encodeSessionTranscriptWorkerError(
  error: unknown,
): SessionTranscriptWorkerReadError | undefined {
  if (error instanceof SessionTranscriptStorageUnavailableError) {
    return { kind: "storage", reason: error.reason };
  }
  if (error instanceof SessionTranscriptColdError) {
    return { kind: "cold", sessionId: error.sessionId };
  }
  if (error instanceof SessionTranscriptProjectionUnavailableError) {
    return { kind: "projection", sessionId: error.sessionId };
  }
  if (error instanceof SessionTranscriptReadFenceError) {
    return { kind: "fence", message: error.message };
  }
  const payload = encodeOpenClawStateWorkerError(error, { includeOrdinary: true });
  return payload ? { kind: "read-error", message: coerceErrorMessage(error), payload } : undefined;
}

export function unwrapSessionTranscriptWorkerReply<
  Kind extends keyof SessionTranscriptWorkerValues,
>(reply: SessionTranscriptWorkerReply<Kind>) {
  if (reply.ok) {
    return reply.value;
  }
  if (reply.error.kind === "delta-visibility") {
    throw new SessionHistoryDeltaPreparationError(reply.error.partial);
  }
  if (reply.error.kind === "read-error") {
    const error = new Error(reply.error.message);
    retainOpenClawStateWorkerErrorPayload(error, reply.error.payload);
    throw hydrateOpenClawStateWorkerError(error, { includeOrdinary: true });
  }
  if (reply.error.kind === "storage") {
    throw new SessionTranscriptStorageUnavailableError(reply.error.reason);
  }
  if (reply.error.kind === "cold") {
    throw new SessionTranscriptColdError(reply.error.sessionId);
  }
  if (reply.error.kind === "projection") {
    throw new SessionTranscriptProjectionUnavailableError(reply.error.sessionId);
  }
  if (reply.error.kind === "syntax") {
    throw new SyntaxError(reply.error.message);
  }
  throw new SessionTranscriptReadFenceError(reply.error.message);
}

/** Keep read and cleanup failures together through the worker error graph. */
export function sessionHistoryCleanupError(
  error: unknown,
  cleanupError: unknown,
  stage: "database close" | "worker retirement",
): AggregateError {
  return new AggregateError(
    [error, cleanupError],
    `${coerceErrorMessage(error)}; ${stage} failed: ${coerceErrorMessage(cleanupError)}`,
    { cause: cleanupError },
  );
}
