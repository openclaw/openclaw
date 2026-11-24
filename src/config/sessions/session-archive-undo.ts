export const ARCHIVE_UNDO_CHANGED =
  "This Archive Undo is no longer current. Refresh the thread before restoring it.";
export type SessionArchiveUndoIntent =
  | { kind: "invalidate" }
  | { kind: "archive" | "undo"; digest: string; expiresAt: number };
