import { isDeepStrictEqual } from "node:util";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import {
  sqliteSessionIdWriteScope,
  withoutSqliteDatabaseWriteScope,
  withSqliteDatabaseWriteScope,
} from "../../infra/sqlite-database-admission.js";
import { getChildLogger } from "../../logging/logger.js";
import { communicationEntryBinding } from "../../sessions/communication-admission.js";
import { isIncognitoSessionKey } from "../../shared/incognito-session-key.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { ConversationRouteContext } from "./conversation-route-context.js";
import { retainLegacyAcpMigrationSourcesForEntry } from "./session-accessor.sqlite-acp-provenance.js";
import {
  linkSessionConversation,
  prepareConversationIdentities,
  prepareSessionConversationForWrite,
  upsertConversationIdentities,
} from "./session-accessor.sqlite-conversation.js";
import { commitSqliteSessionDeletion } from "./session-accessor.sqlite-deletion.js";
import { projectSessionEntryCacheUpdate } from "./session-accessor.sqlite-entry-cache-projection.js";
import {
  publishSessionEntryCacheInvalidation,
  trackSessionEntryCacheWrite,
} from "./session-accessor.sqlite-entry-cache.js";
import { sessionSharingEntriesEqual } from "./session-accessor.sqlite-entry-cache.types.js";
import type { SqliteLifecycleTargetSnapshot } from "./session-accessor.sqlite-entry-equality.js";
import {
  readExactSessionEntryRow,
  readSessionEntryTargetRow,
  type ResolvedSessionEntryRow,
} from "./session-accessor.sqlite-entry-read.js";
import { captureSessionEntrySnapshot } from "./session-accessor.sqlite-entry-snapshot.js";
import { getSessionEntryWriteQueries } from "./session-accessor.sqlite-entry-write-queries.js";
import { advanceSessionEntryMaintenanceAgeFact } from "./session-accessor.sqlite-maintenance-age.js";
import {
  clearSessionCollaborationForKey,
  copySessionNodeArtifactsForRepair,
  deleteSessionDeliveryArtifacts,
  deleteSessionNodeArtifacts,
} from "./session-accessor.sqlite-node-artifacts.js";
import { hasSqliteSessionOwnerColumns } from "./session-accessor.sqlite-owner-projection.js";
import { prepareSessionEntryWindowRow } from "./session-accessor.sqlite-provenance.js";
import { collectSessionStateIdsForEntry } from "./session-accessor.sqlite-references.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import {
  bindSessionNode,
  bindSessionRoot,
  normalizeSessionEntryTimestamp,
} from "./session-accessor.sqlite-session-row.js";
import {
  hasValidSessionEntryIdentity,
  parseSessionEntryJson as parseSessionEntryRow,
} from "./session-accessor.sqlite-status.js";
import { readSessionActorTransactionState } from "./session-actor-transaction.js";
import {
  assertCanonicalSessionEntryLineageWrite,
  assertCanonicalSessionKeyWrite,
  canonicalSessionKeyMigrationRequiredError,
  markCanonicalSessionValidationPending,
} from "./session-canonical-key.js";
import { validateCanonicalSessionRow } from "./session-canonical-row.js";
import { preserveCreationStamp } from "./session-entry-provenance.js";
import {
  splitSessionEntrySnapshots,
  writeSessionEntrySnapshots,
} from "./session-entry-snapshots.js";
import type { SessionEntryWindowFacts } from "./session-entry-window.types.js";
import type {
  SessionEntryWritePostimage,
  SessionEntryWritePostimages,
} from "./session-entry-write-postimage.js";
import { resolveSessionPublicShare } from "./session-public-share.js";
import { readStagedSessionTranscriptUpdatedAt } from "./session-transcript-authority.js";
import {
  projectCanonicalSessionEntryShape,
  stripRuntimeOnlySessionSkillsFields,
} from "./store-entry-shape.js";
import {
  normalizeStoreSessionKey,
  resolveDeliveryProvenCanonicalSessionKey,
} from "./store-entry.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";
export {
  parseReadableSqliteSessionEntryRow,
  readExactSessionEntryRow,
  readExactSessionEntryRowValidated,
  readSessionEntryRow,
  type ResolvedSessionEntryRow,
} from "./session-accessor.sqlite-entry-read.js";
export {
  readSessionEntryCount,
  readSessionEntryStore,
} from "./session-accessor.sqlite-entry-inventory.js";
export {
  readSessionIdentitySnapshot,
  readSessionEntrySelectionSnapshot,
} from "./session-accessor.sqlite-entry-snapshot.js";

export function resolveLifecyclePrimaryEntry(
  database: Pick<OpenClawAgentDatabase, "agentId" | "db">,
  target: { canonicalKey: string; storeKeys: string[] },
  options: { allowCanonicalMove?: boolean; includeWindowFacts?: true } = {},
): SqliteLifecycleTargetSnapshot[number] | undefined {
  const row = readSessionEntryTargetRow(database, target, options);
  return row?.entry ? captureSessionEntrySnapshot({ entry: row.entry, row: row.row }) : undefined;
}

export function readLifecycleTargetSnapshot(
  database: Pick<OpenClawAgentDatabase, "agentId" | "db">,
  target: { canonicalKey: string; storeKeys: string[] },
  options: { allowCanonicalMove?: boolean; includeWindowFacts?: true } = {},
): SqliteLifecycleTargetSnapshot {
  const normalized = normalizeLifecycleTarget(target);
  const row = resolveLifecyclePrimaryEntry(database, normalized, options);
  return row ? [row] : [];
}

export function normalizeLifecycleTarget(target: {
  canonicalKey: string;
  storeKeys: readonly string[];
}): {
  canonicalKey: string;
  storeKeys: string[];
} {
  const canonicalKey = normalizeStoreSessionKey(target.canonicalKey);
  return {
    canonicalKey,
    storeKeys: uniqueStrings([canonicalKey, ...target.storeKeys.map(normalizeStoreSessionKey)]),
  };
}

export function deleteSessionEntryRows(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  options: {
    deleteOwnedWindows?: boolean;
    deliveryCleanupKeys?: readonly string[];
    validatedEntry?: SessionEntry;
    postimages?: SessionEntryWritePostimages;
  } = {},
): void {
  // Doctor supplies the exact row it validated; the runtime parser deliberately rejects that shape.
  const previousEntry =
    options.validatedEntry ?? readExactSessionEntryRow(database, sessionKey)?.entry;
  if (previousEntry) {
    commitSqliteSessionDeletion(sessionKey, previousEntry);
  }
  const db = getSessionKysely(database.db);
  const windows = executeSqliteQuerySync(
    database.db,
    db.selectFrom("session_windows").select("session_id").where("session_key", "=", sessionKey),
  ).rows;
  // Skip the survivor scan when maintenance reclaimed every window. Otherwise, project
  // reference metadata before acquiring rows to avoid loading unrelated saved prompts.
  const survivingNodes =
    windows.length > 0
      ? executeSqliteQuerySync(
          database.db,
          db
            .selectFrom("session_nodes")
            .select(["current_session_id", "entry_json", "session_key"])
            .where("session_key", "!=", sessionKey)
            .orderBy("session_key", "asc"),
        ).rows
      : [];
  for (const window of windows) {
    const survivingNode = survivingNodes.find((node) => {
      if (node.current_session_id === window.session_id) {
        return true;
      }
      const entry = parseSessionEntryRow(node);
      return entry ? collectSessionStateIdsForEntry(entry).includes(window.session_id) : false;
    });
    if (survivingNode) {
      withSqliteDatabaseWriteScope(
        database.db,
        [sessionKey, survivingNode.session_key, sqliteSessionIdWriteScope(window.session_id)],
        () =>
          executeSqliteQuerySync(
            database.db,
            db
              .updateTable("session_windows")
              .set({ session_key: survivingNode.session_key })
              .where("session_id", "=", window.session_id),
          ),
      );
      for (const postimage of options.postimages?.values() ?? []) {
        if (postimage.window.session_id === window.session_id) {
          postimage.window = { ...postimage.window, session_key: survivingNode.session_key };
        }
      }
    }
  }
  const remainingWindow = options.deleteOwnedWindows
    ? undefined
    : executeSqliteQueryTakeFirstSync(
        database.db,
        db
          .selectFrom("session_windows")
          .select(["session_id", "updated_at"])
          .where("session_key", "=", sessionKey)
          .orderBy("updated_at", "desc")
          .orderBy("session_id", "asc")
          .limit(1),
      );
  withSqliteDatabaseWriteScope(
    database.db,
    [sessionKey, ...windows.map((window) => sqliteSessionIdWriteScope(window.session_id))],
    () => {
      if (options.deleteOwnedWindows) {
        deleteSessionDeliveryArtifacts(database, sessionKey, options.deliveryCleanupKeys);
      }
      if (options.deleteOwnedWindows || remainingWindow) {
        deleteSessionNodeArtifacts(database, sessionKey);
      }
      if (remainingWindow) {
        clearSqliteSessionEntryPreservingWindows(database, {
          sessionId: remainingWindow.session_id,
          sessionKey,
          updatedAt: remainingWindow.updated_at,
        });
      } else {
        executeSqliteQuerySync(
          database.db,
          db.deleteFrom("session_nodes").where("session_key", "=", sessionKey),
        );
      }
    },
  );
  options.postimages?.delete(sessionKey);
  publishSessionEntryCacheInvalidation(database, { sessionKey, facts: { kind: "removed" } });
}

/** Remove the logical entry while retaining its node-owned transcript windows. */
function clearSqliteSessionEntryPreservingWindows(
  database: OpenClawAgentDatabase,
  params: { sessionId: string; sessionKey: string; updatedAt: number },
): void {
  writeSessionEntrySnapshots(database, params.sessionKey, []);
  retainLegacyAcpMigrationSourcesForEntry(database.db, params.sessionKey, undefined);
  const db = getSessionKysely(database.db);
  const cleared = {
    current_session_id: params.sessionId,
    entry_json: "{}",
    entry_valid: -1,
    updated_at: params.updatedAt,
    status: null,
    created_at: null,
    created_via: null,
    created_actor_type: null,
    created_actor_id: null,
    project_id: null,
    parent_session_key: null,
    spawned_by: null,
    fork_source_session_key: null,
    fork_source_session_id: null,
    fork_source_entry_id: null,
    label: null,
    display_name: null,
    category: null,
    icon: null,
    pinned_at: null,
    archived_at: null,
    last_read_at: null,
    last_interaction_at: null,
    last_activity_at: null,
    ...(hasSqliteSessionOwnerColumns(database.db)
      ? {
          owner_actor_type: null,
          owner_actor_id: null,
          owner_assigned_by_type: null,
          owner_assigned_by_id: null,
          owner_assigned_at: null,
        }
      : {}),
  } as const;
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("session_nodes")
      .values({ session_key: params.sessionKey, ...cleared })
      .onConflict((conflict) => conflict.column("session_key").doUpdateSet(cleared)),
  );
}

export function deleteLifecycleTargetRows(
  database: OpenClawAgentDatabase,
  target: { canonicalKey: string; storeKeys: string[] },
): void {
  for (const sessionKey of uniqueStrings([target.canonicalKey, ...target.storeKeys])) {
    const trimmed = sessionKey.trim();
    if (trimmed) {
      deleteSessionEntryRows(database, trimmed);
    }
  }
}

export function deleteLegacySessionEntryRows(
  database: OpenClawAgentDatabase,
  legacyKeys: string[],
  sessionKey: string,
  options: {
    rehomeMembers?: boolean;
    validatedEntries?: ReadonlyMap<string, SessionEntry>;
    postimages?: SessionEntryWritePostimages;
  } = {},
): void {
  if (legacyKeys.length === 0) {
    return;
  }
  const db = getSessionKysely(database.db);
  for (const legacyKey of legacyKeys) {
    if (legacyKey === sessionKey) {
      continue;
    }
    const previousEntry =
      options.validatedEntries?.get(legacyKey) ??
      readExactSessionEntryRow(database, legacyKey)?.entry;
    if (previousEntry) {
      commitSqliteSessionDeletion(legacyKey, previousEntry);
    }
    rehomeSessionWindows(database, sessionKey, [legacyKey], options.postimages);
    copySessionNodeArtifactsForRepair(database, database, [legacyKey], sessionKey, {
      includeMembers: options.rehomeMembers,
      postimages: options.postimages,
    });
    withSqliteDatabaseWriteScope(database.db, [legacyKey], () =>
      executeSqliteQuerySync(
        database.db,
        db.deleteFrom("session_nodes").where("session_key", "=", legacyKey),
      ),
    );
    options.postimages?.delete(legacyKey);
    const canonicalPostimage = options.postimages?.get(sessionKey);
    if (canonicalPostimage) {
      canonicalPostimage.changed = true;
    }
    publishSessionEntryCacheInvalidation(database, { sessionKey: legacyKey });
  }
  publishSessionEntryCacheInvalidation(database, { sessionKey });
}

/** Move retained generations to the canonical node before removing key aliases. */
export function rehomeSessionWindows(
  database: OpenClawAgentDatabase,
  canonicalKey: string,
  previousKeys: Iterable<string>,
  postimages?: SessionEntryWritePostimages,
): void {
  const legacyKeys = uniqueStrings([...previousKeys].map((key) => key.trim())).filter(
    (key) => key && key !== canonicalKey,
  );
  if (legacyKeys.length === 0) {
    return;
  }
  const db = getSessionKysely(database.db);
  // Offline repair can move shared windows whose other logical readers are not in this key set.
  withoutSqliteDatabaseWriteScope(database.db, () =>
    executeSqliteQuerySync(
      database.db,
      db
        .updateTable("session_windows")
        .set({ session_key: canonicalKey })
        .where("session_key", "in", legacyKeys),
    ),
  );
  for (const postimage of postimages?.values() ?? []) {
    if (legacyKeys.includes(postimage.window.session_key)) {
      postimage.window = { ...postimage.window, session_key: canonicalKey };
    }
  }
}

export function writeSessionEntry(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  entry: SessionEntry,
  options: {
    allowStoredAliases?: boolean;
    /** Only the personal involvement owner may replace this logical-node state. */
    profileInvolvement?: SessionEntry["profileInvolvement"];
    /** Only the provider review owner may replace a generation-bound pause. */
    providerReviewMutation?: boolean;
    /** Canonical row revalidated in this write transaction; null proves absence. */
    canonicalPreviousEntry?: SessionEntry | null;
    /** Raw canonical columns from the same transaction, for exact no-op comparison. */
    canonicalPreviousRow?: ResolvedSessionEntryRow["row"];
    canonicalPreviousWindow?: SessionEntryWindowFacts;
    canonicalPreviousSideTables?: SessionEntryWritePostimage["sideTables"];
    postimages?: SessionEntryWritePostimages;
    consumePendingReset?: boolean;
    preserveNodeSuggestions?: boolean;
    previousEntry?: SessionEntry | null;
    routeContext?: ConversationRouteContext | null;
  } = {},
): SessionEntry {
  const actor = readSessionActorTransactionState(database, { sessionKey });
  if (actor && sessionKey !== actor.hot.target.sessionKey) {
    throw new Error("Session actor cannot write a lookup sibling");
  }
  if (!options.allowStoredAliases) {
    assertCanonicalSessionKeyWrite(sessionKey);
    assertCanonicalSessionEntryLineageWrite(entry);
    if (resolveDeliveryProvenCanonicalSessionKey(sessionKey, entry) !== sessionKey) {
      throw canonicalSessionKeyMigrationRequiredError(
        `refusing non-canonical session key write ${sessionKey}`,
      );
    }
  }
  let normalizedEntry: SessionEntry = normalizeSessionEntryTimestamp(entry);
  if (!hasValidSessionEntryIdentity(normalizedEntry)) {
    throw new Error("Refusing invalid SQLite session entry identity");
  }
  // Doctor validated the raw rejected row before entering the transaction and passes its
  // hydrated snapshot explicitly; re-reading it through the runtime parser must stay fail-closed.
  // The commit owner can supply its revalidated canonical row instead of decoding it again.
  const canonicalRead =
    options.canonicalPreviousEntry !== undefined ||
    (options.allowStoredAliases && options.previousEntry !== undefined)
      ? undefined
      : readExactSessionEntryRow(
          database,
          sessionKey,
          "full",
          undefined,
          options.postimages ? true : undefined,
        );
  const canonicalPreviousEntry =
    options.canonicalPreviousEntry !== undefined
      ? (options.canonicalPreviousEntry ?? undefined)
      : options.allowStoredAliases && options.previousEntry !== undefined
        ? (options.previousEntry ?? undefined)
        : canonicalRead?.entry;
  const canonicalPreviousRow =
    options.canonicalPreviousRow ?? actor?.entryRows.get(sessionKey)?.row ?? canonicalRead?.row;
  const canonicalFacts = canonicalRead && captureSessionEntrySnapshot(canonicalRead);
  const canonicalPreviousSideTables =
    options.canonicalPreviousSideTables ??
    canonicalFacts?.sideTables ??
    (actor
      ? {
          memberIdsJson: JSON.stringify(actor.hot.members.map((member) => member.identityId)),
          hasBoard: actor.hasBoard,
        }
      : canonicalPreviousEntry === undefined
        ? { memberIdsJson: "[]", hasBoard: false }
        : undefined);
  if (options.postimages && !canonicalPreviousSideTables) {
    throw new Error("Session entry postimage requires prepared side-table facts");
  }
  if (
    canonicalPreviousEntry?.sessionId === normalizedEntry.sessionId &&
    canonicalPreviousEntry.lifecycleRevision === normalizedEntry.lifecycleRevision &&
    canonicalPreviousEntry.compactionQualityDegraded
  ) {
    normalizedEntry = { ...normalizedEntry, compactionQualityDegraded: true };
  }
  if (!options.providerReviewMutation && !options.allowStoredAliases) {
    // Bookkeeping can carry a stale snapshot; only the review owner may clear its pause.
    normalizedEntry = {
      ...normalizedEntry,
      providerReview:
        canonicalPreviousEntry?.sessionId === normalizedEntry.sessionId &&
        canonicalPreviousEntry.lifecycleRevision === normalizedEntry.lifecycleRevision
          ? canonicalPreviousEntry.providerReview
          : undefined,
    };
  }
  if (normalizedEntry.providerReview?.sessionId !== normalizedEntry.sessionId) {
    delete normalizedEntry.providerReview;
  }
  if (canonicalPreviousEntry?.sandbox === "required") {
    if (
      normalizedEntry.sandbox !== "required" ||
      normalizedEntry.createdVia !== canonicalPreviousEntry.createdVia ||
      normalizedEntry.createdAt !== canonicalPreviousEntry.createdAt ||
      !isDeepStrictEqual(normalizedEntry.createdActor, canonicalPreviousEntry.createdActor)
    ) {
      getChildLogger({ subsystem: "session-sqlite" }).warn(
        "blocked role-required session creation provenance downgrade",
        { agentId: database.agentId, sessionKey },
      );
    }
  }
  // Doctor/import owners validate and select a whole creator stamp across aliases.
  // Preserve their selection unless this canonical node already owns required isolation;
  // ordinary writes cannot restamp a logical node's creator.
  if (!options.allowStoredAliases || canonicalPreviousEntry?.sandbox === "required") {
    normalizedEntry = preserveCreationStamp(normalizedEntry, canonicalPreviousEntry);
  }
  if (isIncognitoSessionKey(sessionKey) && normalizedEntry.createdAt === undefined) {
    // Pin timestamp-less creation once at the writer, never independently in
    // each Gateway observer. Existing legacy rows retain their known age.
    normalizedEntry = {
      ...normalizedEntry,
      createdAt: canonicalPreviousEntry?.updatedAt ?? Date.now(),
    };
  }
  // Personal choices follow the logical node through reset and relocation. A
  // fork has a different key; stale entry writers cannot replace committed choices.
  const involvement =
    options.profileInvolvement ??
    canonicalPreviousEntry?.profileInvolvement ??
    (entry.profileInvolvement?.key === sessionKey || options.allowStoredAliases
      ? entry.profileInvolvement
      : undefined);
  if (involvement) {
    normalizedEntry = {
      ...normalizedEntry,
      profileInvolvement: { ...involvement, key: sessionKey },
    };
  } else if (normalizedEntry.profileInvolvement) {
    const { profileInvolvement: _sourceInvolvement, ...forkEntry } = normalizedEntry;
    normalizedEntry = forkEntry;
  }
  const previousEntry =
    options.previousEntry === undefined
      ? canonicalPreviousEntry
      : (options.previousEntry ?? undefined);
  if (
    options.consumePendingReset !== true &&
    previousEntry?.updatedAt === 0 &&
    previousEntry.sessionId === normalizedEntry.sessionId &&
    previousEntry.lifecycleRevision === normalizedEntry.lifecycleRevision
  ) {
    // Same-lifecycle bookkeeping cannot cancel the one-time reset owed by legacy state.
    normalizedEntry.updatedAt = 0;
  }
  const updatedAt = normalizedEntry.updatedAt;
  // Public/plugin projections omit this server-owned field. Same-session replacements
  // retain publication; only an explicit field clear or a new session id revokes it.
  if (
    !Object.hasOwn(normalizedEntry, "publicShare") &&
    canonicalPreviousEntry?.sessionId === normalizedEntry.sessionId
  ) {
    normalizedEntry.publicShare = resolveSessionPublicShare(canonicalPreviousEntry);
  }
  // A copied or reset entry must never publish its replacement generation.
  // Checking the embedded binding also covers forks into previously absent nodes.
  if (
    normalizedEntry.incognito === true ||
    normalizedEntry.publicShare?.sessionId !== normalizedEntry.sessionId
  ) {
    delete normalizedEntry.publicShare;
  }
  // The lifecycle-selected entry owns visibility copy-forward semantics.
  if (previousEntry && previousEntry.sessionId !== normalizedEntry.sessionId) {
    delete normalizedEntry.visibility;
  }
  const canonicalEntry = stripRuntimeOnlySessionSkillsFields(
    projectCanonicalSessionEntryShape({ ...normalizedEntry }),
  );
  const persisted = splitSessionEntrySnapshots(canonicalEntry, {
    previousEntry: canonicalPreviousEntry,
  });
  const sessionNode = bindSessionNode({
    entry: canonicalEntry,
    entryJson: persisted.entryJson,
    sessionKey,
    updatedAt,
  });
  const previousColumns = new Map(Object.entries(canonicalPreviousRow ?? {}));
  const nodeChanged =
    options.allowStoredAliases === true ||
    canonicalPreviousRow === undefined ||
    Object.entries(sessionNode).some(([key, value]) => previousColumns.get(key) !== value);
  if (!options.allowStoredAliases) {
    // SQLite binds TEXT as UTF-8. Validate that exact projection before any write,
    // including serialization hooks and replacement of unpaired UTF-16 surrogates.
    validateCanonicalSessionRow({
      ...sessionNode,
      session_key: sessionNode.session_key.toWellFormed(),
      current_session_id: sessionNode.current_session_id.toWellFormed(),
      entry_json: sessionNode.entry_json.toWellFormed(),
      parent_session_key: sessionNode.parent_session_key?.toWellFormed() ?? null,
      spawned_by: sessionNode.spawned_by?.toWellFormed() ?? null,
      fork_source_session_key: sessionNode.fork_source_session_key?.toWellFormed() ?? null,
      retained_window_id: null,
    });
  } else {
    // Offline import/repair can stage aliases; readiness must validate them before use.
    markCanonicalSessionValidationPending(database, [sessionKey]);
  }
  const written = withSqliteDatabaseWriteScope(
    database.db,
    [sessionKey, sqliteSessionIdWriteScope(normalizedEntry.sessionId)],
    () => {
      // Collaboration rows belong to the exact canonical node being overwritten,
      // which can differ from the selected alias during canonicalization.
      if (
        canonicalPreviousEntry &&
        canonicalPreviousEntry.sessionId !== normalizedEntry.sessionId
      ) {
        // Doctor merges duplicate logical nodes; suggestions are owned by session_key,
        // not by the transcript generation being replaced. Membership remains winner-only.
        clearSessionCollaborationForKey(database, sessionKey, {
          clearSuggestions: options.preserveNodeSuggestions !== true,
        });
      }
      const boundSessionRoot = bindSessionRoot({ entry: normalizedEntry, sessionKey, updatedAt });
      const conversation = prepareSessionConversationForWrite({
        database,
        entry: normalizedEntry,
        previousEntry,
        ...(options.routeContext !== undefined ? { routeContext: options.routeContext } : {}),
        sessionScope: boundSessionRoot.session_scope,
      });
      if (conversation) {
        upsertConversationIdentities(
          database,
          prepareConversationIdentities([conversation.identity]),
          updatedAt,
        );
      }
      const boundSessionRow = {
        ...boundSessionRoot,
        primary_conversation_id:
          conversation?.role === "primary" ? conversation.identity.conversationRef : null,
      };
      const retainWindowOwner = canonicalPreviousEntry?.sessionId === normalizedEntry.sessionId;
      const window = prepareSessionEntryWindowRow({
        boundSessionRow,
        database,
        entry: normalizedEntry,
        previousEntry,
        retainOwner: retainWindowOwner,
        prepared: options.canonicalPreviousWindow ?? canonicalFacts?.window,
        stagedTranscriptUpdatedAt: actor
          ? undefined
          : readStagedSessionTranscriptUpdatedAt(database, normalizedEntry.sessionId),
      });
      const queries = getSessionEntryWriteQueries(database.db);
      const writeGeneration =
        nodeChanged || persisted.snapshotsChanged
          ? trackSessionEntryCacheWrite(database, () => {
              if (nodeChanged) {
                queries.node(sessionNode);
              }
              if (persisted.snapshotsChanged) {
                writeSessionEntrySnapshots(database, sessionKey, persisted.snapshots);
              }
            })
          : undefined;
      if (nodeChanged) {
        advanceSessionEntryMaintenanceAgeFact(database.db, {
          sessionKey,
          entry: normalizedEntry,
          previousEntry: canonicalPreviousEntry,
        });
      }
      if (
        canonicalPreviousEntry &&
        (canonicalPreviousEntry.sessionId !== normalizedEntry.sessionId ||
          canonicalPreviousEntry.lifecycleRevision !== normalizedEntry.lifecycleRevision)
      ) {
        retainLegacyAcpMigrationSourcesForEntry(database.db, sessionKey, normalizedEntry);
      }
      if (window.changed) {
        const writeWindow = retainWindowOwner ? queries.retainWindow : queries.claimWindow;
        writeWindow(window.row);
      }
      if (conversation) {
        linkSessionConversation({
          database,
          ...(previousEntry?.sessionId ? { previousSessionId: previousEntry.sessionId } : {}),
          sessionId: window.row.session_id,
          conversation,
          updatedAt,
        });
      }
      return { writeGeneration, window, conversationWritten: conversation !== null };
    },
  );
  const changed =
    nodeChanged ||
    persisted.snapshotsChanged ||
    written.window.changed ||
    written.conversationWritten;
  if (changed) {
    publishSessionEntryCacheInvalidation(
      database,
      {
        sessionKey,
        entry: normalizedEntry,
        sharingUnchanged:
          !options.allowStoredAliases &&
          sessionSharingEntriesEqual(canonicalPreviousEntry, {
            ...normalizedEntry,
            owner: canonicalPreviousEntry?.owner,
          }),
        entryJson: persisted.entryJson,
        snapshotEntry: canonicalEntry,
        snapshots: persisted.snapshotsChanged ? persisted.snapshots : undefined,
        sideMetadata: structuredClone({
          owner: canonicalPreviousEntry?.owner,
          participants: canonicalPreviousEntry?.participants,
          participantCount: canonicalPreviousEntry?.participantCount,
        }),
        previousEntry: canonicalPreviousEntry,
        ...(!options.allowStoredAliases
          ? {
              facts: {
                kind: "entry" as const,
                previousSessionId: canonicalPreviousEntry?.sessionId,
                sessionId: normalizedEntry.sessionId,
                category: normalizedEntry.category?.trim() || null,
                communicationBinding: communicationEntryBinding(normalizedEntry),
                clearMembers:
                  canonicalPreviousEntry !== undefined &&
                  canonicalPreviousEntry.sessionId !== normalizedEntry.sessionId,
                lifecycleChanged:
                  canonicalPreviousEntry?.sessionId !== normalizedEntry.sessionId ||
                  canonicalPreviousEntry?.lifecycleRevision !== normalizedEntry.lifecycleRevision,
              },
            }
          : {}),
      },
      written.writeGeneration,
    );
  }
  const persistedEntry =
    actor || options.postimages
      ? projectSessionEntryCacheUpdate(
          persisted.entryJson,
          structuredClone({
            ...(canonicalPreviousEntry?.owner ? { owner: canonicalPreviousEntry.owner } : {}),
            ...(canonicalPreviousEntry?.participants
              ? { participants: canonicalPreviousEntry.participants }
              : {}),
            ...(canonicalPreviousEntry?.participantCount !== undefined
              ? { participantCount: canonicalPreviousEntry.participantCount }
              : {}),
          }),
          canonicalEntry,
          persisted.snapshotsChanged ? persisted.snapshots : undefined,
        )
      : undefined;
  if (actor && persistedEntry) {
    const previousRow = actor.entryRows.get(sessionKey)?.row;
    const row = {
      ...previousRow,
      ...sessionNode,
      session_diff_baseline_json: JSON.stringify(canonicalEntry.sessionDiffBaseline) ?? null,
      skills_snapshot_json: JSON.stringify(canonicalEntry.skillsSnapshot) ?? null,
      system_prompt_report_json: JSON.stringify(canonicalEntry.systemPromptReport) ?? null,
    };
    actor.entryRows.set(sessionKey, {
      entry: structuredClone(persistedEntry),
      row,
    });
    actor.hot.entry = structuredClone(persistedEntry);
    actor.window = written.window.postimage;
  }
  if (options.postimages && persistedEntry && canonicalPreviousSideTables) {
    options.postimages.set(sessionKey, {
      changed,
      entry: persistedEntry,
      window: written.window.postimage,
      sideTables: {
        ...canonicalPreviousSideTables,
        ...(canonicalPreviousEntry && canonicalPreviousEntry.sessionId !== normalizedEntry.sessionId
          ? { memberIdsJson: "[]" }
          : {}),
      },
    });
  }
  return persistedEntry ? structuredClone(persistedEntry) : normalizedEntry;
}
