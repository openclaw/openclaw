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
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { assertCanonicalSqliteSessionKeysCurrent } from "./session-canonical-key.js";
import { assertSessionEntryPatchCliHistory } from "./session-entry-patch-guard.js";
import type { SessionEntryPatchGuard } from "./session-entry-patch.types.js";
import type { SessionEntryWritePostimages } from "./session-entry-write-postimage.js";
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
  postimages?: SessionEntryWritePostimages;
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
  const fresh = params.readSnapshot(database);
  assertLifecycleTargetSnapshotUnchanged(params.prepared, fresh, params.operationLabel);
  return writeSessionEntryPatchInDatabase(database, { ...params, fresh });
}

/** Apply a patch evaluated against rows read in this same synchronous transaction. */
export function writeSessionEntryPatchInDatabase(
  database: OpenClawAgentDatabase,
  params: Pick<
    Parameters<typeof applySessionEntryPatchInDatabase>[1],
    "sessionKey" | "writeBase" | "next" | "options"
  > & { fresh: SqliteLifecycleTargetSnapshot },
): SessionEntryPatchMutation {
  const { fresh } = params;
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
  // Commit reads own these entries; update callbacks only receive detached copies.
  const previous = new Map(fresh.map((row) => [row.sessionKey, row.entry]));
  const selectedPreviousEntry = fresh[0]?.entry ?? params.writeBase;
  const postimages: SessionEntryWritePostimages = new Map();
  const persisted = writeSessionEntry(database, params.sessionKey, params.next, {
    ...(params.options.consumePendingReset ? { consumePendingReset: true } : {}),
    ...(params.options.providerReviewMutation ? { providerReviewMutation: true } : {}),
    previousEntry: selectedPreviousEntry,
    postimages,
    canonicalPreviousEntry: fresh[0]?.sessionKey === params.sessionKey ? fresh[0].entry : null,
    // The validated snapshot already owns this canonical row's decode.
    ...(fresh[0]?.sessionKey === params.sessionKey
      ? {
          canonicalPreviousRow: fresh[0].row,
          canonicalPreviousWindow: fresh[0].window,
          canonicalPreviousSideTables: fresh[0].sideTables,
        }
      : {}),
  });
  if (postimages.get(params.sessionKey)?.changed === false) {
    return { applied: true, entry: structuredClone(persisted) };
  }
  const current = new Map([[params.sessionKey, persisted]]);
  return {
    applied: true,
    entry: structuredClone(persisted),
    identity: { previous, current },
    postimages,
  };
}
