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

/** Reports the first failed identity predicate without disclosing transcript values. */
export function transcriptEntryAnchorMismatch(
  left: TranscriptEntryAnchor,
  right: TranscriptEntryAnchor | undefined,
): keyof TranscriptEntryAnchor | "unavailable" | undefined {
  if (!right) {
    return "unavailable";
  }
  const changedField = (
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
  ).find((field) => left[field] !== right[field]);
  return (
    changedField ??
    (left.storePath === right.storePath ||
    isSameOpenClawAgentDatabasePath(left.storePath, right.storePath)
      ? undefined
      : "storePath")
  );
}

export function sameTranscriptEntryAnchor(
  left: TranscriptEntryAnchor,
  right: TranscriptEntryAnchor | undefined,
): boolean {
  return transcriptEntryAnchorMismatch(left, right) === undefined;
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
