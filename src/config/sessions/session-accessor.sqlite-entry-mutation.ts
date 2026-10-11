import { readSqliteNativeMutationRevision } from "../../infra/sqlite-schema-facts.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import { assertConversationAuthority } from "./conversation-authority.js";
import type { SessionEntryPatchOptions } from "./session-accessor.sqlite-contract.js";
import { resolveConversationInDatabase } from "./session-accessor.sqlite-conversation-read.js";
import {
  assertLifecycleTargetSnapshotUnchanged,
  type SqliteLifecycleTargetSnapshot,
} from "./session-accessor.sqlite-entry-equality.js";
import {
  readSessionIdentitySnapshot,
  readUnchangedLifecycleTargetSnapshot,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import type { SessionEntryReplacementPostimages } from "./session-accessor.sqlite-replacement-state.js";
import { assertCanonicalSqliteSessionKeysCurrent } from "./session-canonical-key.js";
import { parseSqliteSessionEntryRecord } from "./session-entry-json.js";
import { assertSessionEntryPatchCliHistory } from "./session-entry-patch-guard.js";
import type { SessionEntryPatchGuard } from "./session-entry-patch.types.js";
import {
  projectCanonicalSessionEntryShape,
  stripRuntimeOnlySessionSkillsFields,
} from "./store-entry-shape.js";
import { collectSessionEntryLookupKeys } from "./store-entry.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

type SessionEntryIdentityChange = {
  previous: Map<string, SessionEntry>;
  current: Map<string, SessionEntry>;
};

type SessionEntryPatchMutation = {
  applied: boolean;
  entry: SessionEntry;
  identity?: SessionEntryIdentityChange;
  postimages?: SessionEntryReplacementPostimages;
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
    > & { workerGuard?: Pick<SessionEntryPatchGuard, "cliHistory" | "conversation"> };
  },
): SessionEntryPatchMutation {
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
  return writeSessionEntryPatchInDatabase(database, { ...params, fresh });
}

/** Apply a patch evaluated against rows read in this same synchronous transaction. */
export function writeSessionEntryPatchInDatabase(
  database: OpenClawAgentDatabase,
  params: Pick<
    Parameters<typeof applySessionEntryPatchInDatabase>[1],
    "sessionKey" | "writeBase" | "next" | "options"
  > & { fresh: SqliteLifecycleTargetSnapshot; reusePostimage?: true },
): SessionEntryPatchMutation {
  const { fresh } = params;
  const acquiredRevision = readSqliteNativeMutationRevision(database.db);
  params.options.assertCommitAllowed?.();
  const conversation = params.options.workerGuard?.conversation;
  if (conversation) {
    assertConversationAuthority(
      resolveConversationInDatabase(database, conversation.conversationRef),
      conversation,
    );
  }
  assertSessionEntryPatchCliHistory(
    database,
    params.sessionKey,
    params.options.workerGuard?.cliHistory,
  );
  if (!params.next) {
    return { applied: false, entry: structuredClone(params.writeBase) };
  }
  const canReuseSnapshot =
    acquiredRevision !== undefined &&
    acquiredRevision === readSqliteNativeMutationRevision(database.db) &&
    (!fresh[0]?.window ||
      (fresh[0].window.database === database.db && fresh[0].window.revision === acquiredRevision));
  // Commit reads own these entries; update callbacks only receive detached copies.
  const previous = new Map(fresh.map((row) => [row.sessionKey, row.entry]));
  const selectedPreviousEntry = fresh[0]?.entry ?? params.writeBase;
  const revision = readSqliteNativeMutationRevision(database.db);
  const persisted = writeSessionEntry(database, params.sessionKey, params.next, {
    ...(params.options.consumePendingReset ? { consumePendingReset: true } : {}),
    ...(params.options.providerReviewMutation ? { providerReviewMutation: true } : {}),
    previousEntry: selectedPreviousEntry,
    forceSnapshotWrite: !canReuseSnapshot,
    // The validated snapshot already owns this canonical row's decode.
    ...(fresh[0]?.sessionKey === params.sessionKey
      ? {
          canonicalPreviousEntry: fresh[0].entry,
          canonicalPreviousRow: canReuseSnapshot
            ? fresh[0].persistedRows?.rows.find((row) => row.session_key === params.sessionKey)
            : undefined,
          canonicalPreviousWindow:
            params.reusePostimage && canReuseSnapshot ? fresh[0].window : undefined,
        }
      : {}),
  });
  const committedRevision = readSqliteNativeMutationRevision(database.db);
  if (revision !== undefined && committedRevision === revision) {
    return { applied: true, entry: structuredClone(persisted) };
  }
  // Identity publication borrows session and lifecycle facts owned by this canonical write.
  const current = new Map([[params.sessionKey, persisted]]);
  let postimages: SessionEntryReplacementPostimages | undefined;
  if (params.reusePostimage && canReuseSnapshot && committedRevision !== undefined) {
    const canonical = stripRuntimeOnlySessionSkillsFields(
      projectCanonicalSessionEntryShape({ ...persisted }),
    );
    const metadata = parseSqliteSessionEntryRecord({ entry_json: JSON.stringify(canonical) });
    if (!metadata) {
      throw new Error("Session patch lost its persisted identity");
    }
    const canonicalPrevious = previous.get(params.sessionKey);
    const sideTables =
      canonicalPrevious?.sessionId === persisted.sessionId ? fresh[0]?.sideTables : undefined;
    postimages = {
      database: database.db,
      revision: committedRevision,
      ...(sideTables ? { sideTables: new Map([[params.sessionKey, sideTables]]) } : {}),
      entries: new Map([
        [
          params.sessionKey,
          {
            ...metadata,
            ...(canonicalPrevious?.owner ? { owner: canonicalPrevious.owner } : {}),
            ...(canonicalPrevious?.participants
              ? { participants: canonicalPrevious.participants }
              : {}),
            ...(canonicalPrevious?.participantCount === undefined
              ? {}
              : { participantCount: canonicalPrevious.participantCount }),
          },
        ],
      ]),
    };
  }
  return {
    applied: true,
    entry: structuredClone(persisted),
    identity: { previous, current },
    ...(postimages ? { postimages } : {}),
  };
}
