import type { SessionEntry } from "./types.js";

export const ARCHIVE_UNDO_CHANGED =
  "This Archive Undo is no longer current. Refresh the thread before restoring it.";
export type SessionArchiveUndoIntent =
  | { kind: "invalidate" }
  | { kind: "archive" | "undo"; digest: string; expiresAt: number };

/** Fields an Archive or Undo receipt request may carry; identity stays exact and store-checked. */
const ARCHIVE_UNDO_REQUEST_FIELDS = new Set([
  "archived",
  "requestArchiveUndo",
  "archiveUndoToken",
  "key",
  "agentId",
  "expectedSessionId",
  "expectedLifecycleRevision",
]);

/** A receipt request names one exact session occurrence and carries no other fields. */
export function isArchiveUndoRequestShape(
  patch: object,
  targets: readonly { expectedSessionId?: string }[],
): boolean {
  const allowed = (value: object) =>
    Object.keys(value).every((key) => ARCHIVE_UNDO_REQUEST_FIELDS.has(key));
  return allowed(patch) && targets.every((target) => target.expectedSessionId && allowed(target));
}

/** Ordinary single Restore may compare the archived occurrence only with an exact identity. */
export function isArchivedOccurrenceRestore(patch: {
  archived?: boolean;
  expectedSessionId?: string;
}): boolean {
  return Boolean(patch.expectedSessionId) && patch.archived === false;
}

/** The committed row is still the occurrence this Archive projected. */
export function isSameSessionOccurrence(
  committed: Pick<SessionEntry, "sessionId" | "lifecycleRevision">,
  projected: Pick<SessionEntry, "sessionId" | "lifecycleRevision">,
): boolean {
  return (
    committed.sessionId === projected.sessionId &&
    committed.lifecycleRevision === projected.lifecycleRevision
  );
}
