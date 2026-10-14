import { isSameOpenClawAgentDatabasePath } from "../../state/openclaw-agent-db.paths.js";

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

/** Exact accepted transcript range, inclusive of admission and terminal. */
export type TranscriptTurnBoundary = Readonly<{
  admission: TranscriptTurnAdmission;
  terminal: TranscriptEntryAnchor;
}>;
