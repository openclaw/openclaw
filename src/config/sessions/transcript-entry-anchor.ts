import { isSameOpenClawAgentDatabasePath } from "../../state/openclaw-agent-db.paths.js";
import type { SessionTranscriptContextVersion } from "./session-transcript-context-version.types.js";

/** Immutable transcript identity issued by the SQLite append transaction. */
export type TranscriptEntryAnchor = Readonly<{
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
  generation: string;
  entryId: string;
  rawSeq: number;
  effectiveParentId: string | null;
  activeMessagePosition: number;
  idempotencyKey?: string;
}>;

/**
 * Order an admitted source against a bounded context read of the same chat.
 * An earlier transcript precedes the current one. Within a transcript, only
 * the same generation's sequence numbers identify the read's captured prefix.
 * This describes ordering; it grants no read or write authority.
 */
export function transcriptEntryPrecedesContextTail(
  entry: TranscriptEntryAnchor,
  context: { sessionId: string; version?: SessionTranscriptContextVersion },
): boolean {
  return (
    entry.sessionId !== context.sessionId ||
    (entry.generation === context.version?.generation &&
      entry.rawSeq <= (context.version.rawSeq ?? 0))
  );
}

export function sameTranscriptEntryAnchor(
  left: TranscriptEntryAnchor,
  right: TranscriptEntryAnchor | undefined,
): boolean {
  return (
    right !== undefined &&
    (
      [
        "agentId",
        "sessionId",
        "sessionKey",
        "generation",
        "entryId",
        "rawSeq",
        "effectiveParentId",
        "activeMessagePosition",
      ] as const
    ).every((field) => left[field] === right[field]) &&
    (left.storePath === right.storePath ||
      isSameOpenClawAgentDatabasePath(left.storePath, right.storePath))
  );
}

/** Current user row bound to one recorder-owned logical turn. */
export type TranscriptTurnAdmission = TranscriptEntryAnchor &
  Readonly<{
    logicalTurnId: string;
    role: "user";
  }>;

/** Capture only the scalar identity; message payloads have separate deep-copy ownership. */
export function snapshotTranscriptEntryAnchor(
  anchor: TranscriptEntryAnchor,
): TranscriptEntryAnchor {
  return {
    agentId: anchor.agentId,
    sessionId: anchor.sessionId,
    sessionKey: anchor.sessionKey,
    storePath: anchor.storePath,
    generation: anchor.generation,
    entryId: anchor.entryId,
    rawSeq: anchor.rawSeq,
    effectiveParentId: anchor.effectiveParentId,
    activeMessagePosition: anchor.activeMessagePosition,
    ...(Object.hasOwn(anchor, "idempotencyKey") ? { idempotencyKey: anchor.idempotencyKey } : {}),
  };
}

export function snapshotTranscriptTurnAdmission(
  admission: TranscriptTurnAdmission,
): TranscriptTurnAdmission {
  return {
    ...snapshotTranscriptEntryAnchor(admission),
    logicalTurnId: admission.logicalTurnId,
    role: admission.role,
  };
}

/** Exact accepted transcript range, inclusive of admission and terminal. */
export type TranscriptTurnBoundary = Readonly<{
  admission: TranscriptTurnAdmission;
  terminal: TranscriptEntryAnchor;
}>;
