import type { SessionEntryLifecycleRemoval } from "./session-accessor.lifecycle-types.js";
import { sqliteSessionEntriesEqual } from "./session-accessor.sqlite-entry-equality.js";
import type { SessionEntry } from "./types.js";

type SessionEntryRemovalExpectation = Pick<
  SessionEntryLifecycleRemoval,
  "expectedEntry" | "expectedLifecycleRevision" | "expectedUpdatedAt"
> & {
  expectedSessionId?: string | null;
};

export function shouldRemoveSessionEntry(
  entry: SessionEntry | undefined,
  removal: SessionEntryRemovalExpectation,
): entry is SessionEntry {
  if (!entry) {
    return false;
  }
  if (
    removal.expectedEntry !== undefined &&
    !sqliteSessionEntriesEqual(entry, removal.expectedEntry)
  ) {
    return false;
  }
  // Null requires an entry without a physical ID; undefined leaves the ID unconstrained.
  if (
    removal.expectedSessionId !== undefined &&
    (removal.expectedSessionId === null
      ? entry.sessionId !== undefined
      : entry.sessionId !== removal.expectedSessionId)
  ) {
    return false;
  }
  if (
    removal.expectedLifecycleRevision !== undefined &&
    entry.lifecycleRevision !== removal.expectedLifecycleRevision
  ) {
    return false;
  }
  return removal.expectedUpdatedAt === undefined || entry.updatedAt === removal.expectedUpdatedAt;
}
