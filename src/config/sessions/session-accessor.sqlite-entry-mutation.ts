import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import type {
  SessionEntryPatchOptions,
  SessionEntryTargetPatchScope,
} from "./session-accessor.sqlite-contract.js";
import {
  assertLifecycleTargetSnapshotUnchanged,
  type SqliteLifecycleTargetSnapshot,
} from "./session-accessor.sqlite-entry-equality.js";
import {
  collectSessionEntryLookupKeys,
  readLifecycleTargetSnapshot,
  readSessionEntrySelectionSnapshot,
  readSessionIdentitySnapshot,
  readUnchangedLifecycleTargetSnapshot,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { cloneSessionEntry } from "./session-accessor.sqlite-scope.js";
import { assertCanonicalSqliteSessionKeysCurrent } from "./session-canonical-key.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

type SessionEntryIdentityChange = {
  previous: Map<string, SessionEntry>;
  current: Map<string, SessionEntry>;
};

export type SessionEntryPatchSelection =
  | { sessionKey: string; replaceEntry: boolean }
  | { target: SessionEntryTargetPatchScope["target"] };

export type SessionEntryPatchCommit = {
  operationLabel: "session-entry.patch" | "session-entry-target.patch";
  validateCanonicalKeys: boolean;
  selection: SessionEntryPatchSelection;
  prepared: SqliteLifecycleTargetSnapshot;
  sessionKey: string;
  writeBase: SessionEntry;
  next: SessionEntry | undefined;
  options: Pick<SessionEntryPatchOptions, "consumePendingReset" | "providerReviewMutation">;
};

export function readSessionEntryPatchSnapshot(
  database: OpenClawAgentDatabase,
  selection: SessionEntryPatchSelection,
): SqliteLifecycleTargetSnapshot {
  return "target" in selection
    ? readLifecycleTargetSnapshot(database, selection.target)
    : readSessionEntrySelectionSnapshot(database, selection.sessionKey, selection.replaceEntry);
}

/** The caller owns transaction admission and publication after the durable commit. */
export function replaceSessionEntryInDatabase(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  entry: SessionEntry,
): SessionEntryIdentityChange {
  const identityKeys = collectSessionEntryLookupKeys(database, sessionKey);
  const previous = readSessionIdentitySnapshot(database, identityKeys);
  writeSessionEntry(database, sessionKey, entry);
  const current = readSessionIdentitySnapshot(database, identityKeys);
  return { previous, current };
}

/** Revalidate prepared rows and apply the patch on the already-admitted connection. */
export function applySessionEntryPatchInDatabase(
  database: OpenClawAgentDatabase,
  params: SessionEntryPatchCommit,
  assertCommitAllowed: () => void,
): { entry: SessionEntry; identity?: SessionEntryIdentityChange } {
  // Canonical validation belongs to the current connection, not the captured rows.
  if (params.validateCanonicalKeys) {
    assertCanonicalSqliteSessionKeysCurrent(database);
  }
  // Unchanged raw rows decode identically; only a changed row pays the hydrated
  // re-read and deep comparison that owns the conflict error.
  let fresh = readUnchangedLifecycleTargetSnapshot(database, params.prepared);
  if (!fresh) {
    fresh = readSessionEntryPatchSnapshot(database, params.selection);
    assertLifecycleTargetSnapshotUnchanged(params.prepared, fresh, params.operationLabel);
  }
  assertCommitAllowed();
  if (!params.next) {
    return { entry: cloneSessionEntry(params.writeBase) };
  }
  // Commit reads own these entries; update callbacks only receive detached copies.
  const previous = new Map(fresh.map((row) => [row.sessionKey, row.entry]));
  const selectedPreviousEntry = fresh[0]?.entry ?? params.writeBase;
  const persisted = writeSessionEntry(database, params.sessionKey, params.next, {
    ...(params.options.consumePendingReset ? { consumePendingReset: true } : {}),
    ...(params.options.providerReviewMutation ? { providerReviewMutation: true } : {}),
    previousEntry: selectedPreviousEntry,
    // The validated snapshot already owns this canonical row's decode.
    ...(fresh[0]?.sessionKey === params.sessionKey
      ? { canonicalPreviousEntry: fresh[0].entry }
      : {}),
  });
  // Identity publication borrows session and lifecycle facts owned by this canonical write.
  const current = new Map([[params.sessionKey, persisted]]);
  return { entry: cloneSessionEntry(persisted), identity: { previous, current } };
}
