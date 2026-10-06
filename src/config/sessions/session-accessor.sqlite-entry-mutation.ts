import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import type { SessionEntryPatchOptions } from "./session-accessor.sqlite-contract.js";
import {
  assertLifecycleTargetSnapshotUnchanged,
  type SqliteLifecycleTargetSnapshot,
} from "./session-accessor.sqlite-entry-equality.js";
import {
  readSessionIdentitySnapshot,
  readUnchangedLifecycleTargetSnapshot,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { assertCanonicalSqliteSessionKeysCurrent } from "./session-canonical-key.js";
import { assertSessionEntryPatchCliHistory } from "./session-entry-patch-guard.js";
import type { SessionEntryPatchGuard } from "./session-entry-patch.types.js";
import { collectSessionEntryLookupKeys } from "./store-entry.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

type SessionEntryIdentityChange = {
  previous: Map<string, SessionEntry>;
  current: Map<string, SessionEntry>;
};

/** The caller owns transaction admission and publication after the durable commit. */
export function replaceSessionEntryInDatabase(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  entry: SessionEntry,
): SessionEntryIdentityChange {
  const identityKeys = collectSessionEntryLookupKeys(sessionKey);
  const previous = readSessionIdentitySnapshot(database, identityKeys);
  writeSessionEntry(database, sessionKey, entry);
  const current = readSessionIdentitySnapshot(database, identityKeys);
  return { previous, current };
}

/** Revalidate prepared rows and apply the patch on the already-admitted connection. */
export function applySessionEntryPatchInDatabase(
  database: OpenClawAgentDatabase,
  params: {
    operationLabel: "session-entry.patch" | "session-entry-target.patch";
    validateCanonicalKeys: boolean;
    readSnapshot: (database: OpenClawAgentDatabase) => SqliteLifecycleTargetSnapshot;
    prepared: SqliteLifecycleTargetSnapshot;
    sessionKey: string;
    writeBase: SessionEntry;
    next: SessionEntry | undefined;
    options: Pick<
      SessionEntryPatchOptions,
      "consumePendingReset" | "assertCommitAllowed" | "providerReviewMutation"
    > & { workerGuard?: Pick<SessionEntryPatchGuard, "cliHistory"> };
  },
): { entry: SessionEntry; identity?: SessionEntryIdentityChange } {
  // Canonical validation belongs to the current connection, not the captured rows.
  if (params.validateCanonicalKeys) {
    assertCanonicalSqliteSessionKeysCurrent(database);
  }
  // Unchanged raw rows decode identically; only a changed row pays the hydrated
  // re-read and deep comparison that owns the conflict error.
  let fresh = readUnchangedLifecycleTargetSnapshot(database, params.prepared);
  if (!fresh) {
    fresh = params.readSnapshot(database);
    assertLifecycleTargetSnapshotUnchanged(params.prepared, fresh, params.operationLabel);
  }
  params.options.assertCommitAllowed?.();
  assertSessionEntryPatchCliHistory(
    database,
    params.sessionKey,
    params.options.workerGuard?.cliHistory,
  );
  if (!params.next) {
    return { entry: structuredClone(params.writeBase) };
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
  return { entry: structuredClone(persisted), identity: { previous, current } };
}
