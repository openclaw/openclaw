import { sql } from "kysely";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import {
  sqliteSessionIdWriteScope,
  withSqliteDatabaseWriteScope,
} from "../../infra/sqlite-database-admission.js";
import { communicationEntryBinding } from "../../sessions/communication-admission.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { readSessionActivitySummary } from "./activity-summary.js";
import type { ConversationRouteContext } from "./conversation-route-context.js";
import { prepareLegacyAcpMigrationSourcesForEntryWrite } from "./session-accessor.sqlite-acp-provenance.js";
import { conversationPublication } from "./session-accessor.sqlite-conversation-publication.js";
import {
  linkSessionConversation,
  prepareConversationIdentities,
  prepareRetainedSessionConversationForWrite,
  prepareSessionConversationForWrite,
  upsertConversationIdentities,
} from "./session-accessor.sqlite-conversation.js";
import { projectSessionEntryCacheUpdate } from "./session-accessor.sqlite-entry-cache-projection.js";
import {
  publishSessionEntryCacheInvalidation,
  trackSessionEntryCacheWrite,
} from "./session-accessor.sqlite-entry-cache.js";
import { sessionSharingEntriesEqual } from "./session-accessor.sqlite-entry-cache.types.js";
import {
  readExactSessionEntryRow,
  type ResolvedSessionEntryRow,
} from "./session-accessor.sqlite-entry-read.js";
import { captureSessionEntrySnapshot } from "./session-accessor.sqlite-entry-snapshot.js";
import {
  buildSessionEntryNodeUpsert,
  buildSessionEntryWindowUpsert,
  getSessionEntryWriteQueries,
} from "./session-accessor.sqlite-entry-write-queries.js";
import { advanceSessionEntryMaintenanceAgeFact } from "./session-accessor.sqlite-maintenance-age.js";
import { clearSessionCollaborationForKey } from "./session-accessor.sqlite-node-artifacts.js";
import { prepareSessionEntryWindowRow } from "./session-accessor.sqlite-provenance.js";
import { bindSessionNode, bindSessionRoot } from "./session-accessor.sqlite-session-row.js";
import { hasValidSessionEntryIdentity } from "./session-accessor.sqlite-status.js";
import { readSessionTranscriptWatermarkInDatabase } from "./session-accessor.sqlite-transcript-watermark.js";
import type { SessionActorStoredState } from "./session-actor-hydration.types.js";
import {
  readSessionActorTransactionState,
  replaceSessionActorStoredEntry,
} from "./session-actor-transaction.js";
import {
  assertCanonicalSessionEntryLineageWrite,
  assertCanonicalSessionKeyWrite,
  canonicalSessionKeyMigrationRequiredError,
  markCanonicalSessionValidationPending,
} from "./session-canonical-key.js";
import { validateCanonicalSessionRow } from "./session-canonical-row.js";
import { normalizeSessionEntryTimestamp } from "./session-entry-json.js";
import {
  splitSessionEntrySnapshots,
  writeSessionEntrySnapshots,
} from "./session-entry-snapshots.js";
import type {
  SessionEntryWindowFacts,
  SessionEntryWindowRow,
} from "./session-entry-window.types.js";
import { applySessionEntryWritePolicy } from "./session-entry-write-policy.js";
import {
  createSessionEntryWriteRow,
  type SessionEntryWritePostimage,
  type SessionEntryWritePostimages,
} from "./session-entry-write-postimage.js";
import { resolveSessionPublicShare } from "./session-public-share.js";
import {
  readStagedSessionTranscriptUpdatedAt,
  readStagedSessionTranscriptAuthority,
} from "./session-transcript-authority.js";
import {
  projectCanonicalSessionEntryShape,
  stripRuntimeOnlySessionSkillsFields,
} from "./store-entry-shape.js";
import { resolveDeliveryProvenCanonicalSessionKey } from "./store-entry.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

type SessionEntryWriteOptions = {
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
  /** Initial child fork keeps this logical node's current audience across transcript installation. */
  preserveVisibility?: boolean;
  /** A rehome can bind historical windows to an otherwise unchanged target. */
  publishConversationBinding?: boolean;
  preserveNodeSuggestions?: boolean;
  previousEntry?: SessionEntry | null;
  observeConversation?: boolean;
  routeContext?: ConversationRouteContext | null;
};

type PreparedSessionEntryWrite = {
  sessionKey: string;
  node:
    | (ReturnType<typeof bindSessionNode> & { legacy_acp_migration_json?: string | null })
    | undefined;
  window:
    | (Omit<ReturnType<typeof bindSessionRoot>, "primary_conversation_id"> & {
        primary_conversation_id: string | null;
        transcript_observed_at: number;
      })
    | undefined;
  windowPostimage: SessionEntryWindowRow;
  setWindowPostimage(postimage: SessionEntryWindowRow): void;
  batchable: boolean;
  write(): ReturnType<typeof trackSessionEntryCacheWrite>;
  publish(writeGeneration: ReturnType<typeof trackSessionEntryCacheWrite>): SessionEntry;
};

function prepareSessionEntryWrite(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  entry: SessionEntry,
  options?: SessionEntryWriteOptions,
): PreparedSessionEntryWrite;
function prepareSessionEntryWrite(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  entry: SessionEntry,
  options: SessionEntryWriteOptions,
  actorPreparation: SessionActorStoredState,
): PreparedSessionEntryWrite | undefined;
function prepareSessionEntryWrite(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  entry: SessionEntry,
  options: SessionEntryWriteOptions = {},
  actorPreparation?: SessionActorStoredState,
): PreparedSessionEntryWrite | undefined {
  const actor = actorPreparation ?? readSessionActorTransactionState(database, { sessionKey });
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
  const normalized = applySessionEntryWritePolicy(
    database.agentId,
    sessionKey,
    entry,
    normalizedEntry,
    canonicalPreviousEntry,
    options,
  );
  normalizedEntry = normalized.entry;
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
  const previousEntry = normalized.previousEntry;
  const updatedAt = normalizedEntry.updatedAt;
  const canonicalEntry = stripRuntimeOnlySessionSkillsFields(
    projectCanonicalSessionEntryShape({ ...normalizedEntry }),
  );
  const persisted = splitSessionEntrySnapshots(canonicalEntry, {
    previousEntry: canonicalPreviousEntry,
  });
  if (
    actorPreparation &&
    (canonicalPreviousEntry?.sessionId !== normalizedEntry.sessionId ||
      canonicalPreviousEntry.lifecycleRevision !== normalizedEntry.lifecycleRevision ||
      persisted.snapshotsChanged)
  ) {
    return undefined;
  }
  const legacySources = prepareLegacyAcpMigrationSourcesForEntryWrite(
    database,
    sessionKey,
    normalizedEntry,
    canonicalPreviousEntry,
    canonicalPreviousRow,
  );
  if (actorPreparation && "legacy_acp_migration_json" in legacySources) {
    return undefined;
  }
  const sessionNode = {
    ...bindSessionNode({
      entry: canonicalEntry,
      entryJson: persisted.entryJson,
      sessionKey,
      updatedAt,
    }),
    ...legacySources,
  };
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
  return withSqliteDatabaseWriteScope(
    database.db,
    [sessionKey, sqliteSessionIdWriteScope(normalizedEntry.sessionId)],
    () => {
      const boundSessionRoot = bindSessionRoot({ entry: normalizedEntry, sessionKey, updatedAt });
      const preparedWindow = options.canonicalPreviousWindow ?? canonicalFacts?.window;
      const conversationInput = {
        database,
        entry: normalizedEntry,
        previousEntry,
        canonicalPreviousEntry,
        previousWindow: actor?.window ?? preparedWindow?.row,
        observeConversation: options.observeConversation || options.allowStoredAliases,
        ...(options.routeContext !== undefined ? { routeContext: options.routeContext } : {}),
        sessionScope: boundSessionRoot.session_scope,
      };
      const retainedConversation = actorPreparation
        ? prepareRetainedSessionConversationForWrite(conversationInput)
        : undefined;
      if (actorPreparation && !retainedConversation) {
        return undefined;
      }
      const { conversation, primaryConversationId } =
        retainedConversation ?? prepareSessionConversationForWrite(conversationInput);
      const retainWindowOwner = canonicalPreviousEntry?.sessionId === normalizedEntry.sessionId;
      const window = prepareSessionEntryWindowRow({
        boundSessionRow: { ...boundSessionRoot, primary_conversation_id: primaryConversationId },
        database,
        entry: normalizedEntry,
        previousEntry,
        retainOwner: retainWindowOwner,
        prepared: preparedWindow,
        stagedTranscriptUpdatedAt: actor
          ? undefined
          : readStagedSessionTranscriptUpdatedAt(database, normalizedEntry.sessionId),
      });
      if (actorPreparation && window.changed) {
        return undefined;
      }
      const queries = getSessionEntryWriteQueries(database.db);
      const withLegacySources = "legacy_acp_migration_json" in legacySources;
      // The child key consumes the node's RETURNING row, including on first creation.
      // Snapshot removals retain the ordered delete/upsert path.
      const writeNodeWithSnapshots =
        nodeChanged &&
        persisted.snapshotsChanged &&
        !persisted.snapshotsRemoved &&
        persisted.snapshots.length > 0
          ? queries.postgres?.nodeWithSnapshots
          : undefined;
      const writeNodeWithWindow =
        nodeChanged && !persisted.snapshotsChanged && window.changed
          ? queries.postgres?.nodeWithWindow
          : undefined;
      const changed =
        nodeChanged || persisted.snapshotsChanged || window.changed || conversation !== null;
      const write = () =>
        withSqliteDatabaseWriteScope(
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
            const writeGeneration = changed
              ? trackSessionEntryCacheWrite(database, () => {
                  if (conversation) {
                    upsertConversationIdentities(
                      database,
                      prepareConversationIdentities([conversation.identity]),
                      updatedAt,
                    );
                  }
                  if (writeNodeWithSnapshots) {
                    writeNodeWithSnapshots(
                      { node: sessionNode, snapshots: persisted.snapshots },
                      withLegacySources,
                    );
                  } else if (writeNodeWithWindow) {
                    writeNodeWithWindow(
                      { node: sessionNode, window: window.row },
                      withLegacySources,
                      retainWindowOwner,
                    );
                  } else if (nodeChanged) {
                    const writeNode = withLegacySources
                      ? queries.nodeWithLegacySources
                      : queries.node;
                    writeNode(sessionNode);
                  }
                  if (persisted.snapshotsChanged && !writeNodeWithSnapshots) {
                    writeSessionEntrySnapshots(
                      database,
                      sessionKey,
                      persisted.snapshots,
                      persisted,
                    );
                  }
                  if (window.changed && !writeNodeWithWindow) {
                    const writeWindow = retainWindowOwner
                      ? queries.retainWindow
                      : queries.claimWindow;
                    writeWindow(window.row);
                  }
                  if (conversation) {
                    linkSessionConversation({
                      database,
                      ...(previousEntry?.sessionId
                        ? { previousSessionId: previousEntry.sessionId }
                        : {}),
                      sessionId: window.row.session_id,
                      conversation,
                      updatedAt,
                    });
                  }
                })
              : undefined;
            return writeGeneration;
          },
        );
      const publish = (writeGeneration: ReturnType<typeof trackSessionEntryCacheWrite>) => {
        if (changed || options.publishConversationBinding) {
          conversationPublication.stageRows(database, {
            nodes: [
              {
                session_key: sessionNode.session_key,
                current_session_id: sessionNode.current_session_id,
                entry_valid: sessionNode.entry_valid,
                updated_at: sessionNode.updated_at,
                entry_session_id: canonicalEntry.sessionId,
              },
            ],
            windows: [
              {
                session_id: window.postimage.session_id,
                session_key: window.postimage.session_key,
                primary_conversation_id: window.postimage.primary_conversation_id,
              },
            ],
          });
        }
        if (nodeChanged) {
          advanceSessionEntryMaintenanceAgeFact(database.db, {
            sessionKey,
            entry: normalizedEntry,
            previousEntry: canonicalPreviousEntry,
          });
        }
        const sideMetadata =
          changed || actor || options.postimages
            ? structuredClone({
                owner: canonicalPreviousEntry?.owner,
                participants: canonicalPreviousEntry?.participants,
                participantCount: canonicalPreviousEntry?.participantCount,
              })
            : {};
        const snapshots = persisted.snapshotsChanged ? persisted.snapshots : undefined;
        let publishedEntry: SessionEntry | undefined;
        if (changed) {
          publishedEntry = publishSessionEntryCacheInvalidation(
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
              snapshots,
              sideMetadata,
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
                        canonicalPreviousEntry?.lifecycleRevision !==
                          normalizedEntry.lifecycleRevision,
                    },
                  }
                : {}),
            },
            writeGeneration,
          );
        }
        const persistedEntry =
          !changed && (actor || options.postimages)
            ? projectSessionEntryCacheUpdate(
                persisted.entryJson,
                sideMetadata,
                canonicalEntry,
                snapshots,
              )
            : (actor || options.postimages) && publishedEntry;
        const row = persistedEntry
          ? createSessionEntryWriteRow({
              previous: canonicalPreviousRow,
              node: sessionNode,
              snapshots: persisted.snapshots,
              snapshotsChanged: persisted.snapshotsChanged,
              window: window.postimage,
            })
          : undefined;
        if (actor && persistedEntry && row) {
          replaceSessionActorStoredEntry(actor, sessionKey, {
            entry: persistedEntry,
            row,
            window: window.postimage,
          });
        }
        if (options.postimages && persistedEntry && row && canonicalPreviousSideTables) {
          const stagedTranscript = readStagedSessionTranscriptAuthority(database)
            ?.flatMap((receipt) => Array.from(receipt.facts.values()))
            .find(
              (fact) =>
                fact.kind === "postimage" && fact.value.sessionId === persistedEntry.sessionId,
            );
          const preparedWatermark = canonicalPreviousRow?.transcriptWatermark;
          const transcriptWatermark = !readSessionActivitySummary(persistedEntry)
            ? undefined
            : stagedTranscript?.kind === "postimage"
              ? {
                  generation: stagedTranscript.value.generation,
                  maxSeq: stagedTranscript.value.rawSeq,
                }
              : preparedWatermark?.sessionId === persistedEntry.sessionId
                ? { generation: preparedWatermark.generation, maxSeq: preparedWatermark.maxSeq }
                : readSessionTranscriptWatermarkInDatabase(database, persistedEntry.sessionId);
          options.postimages.set(sessionKey, {
            changed,
            entry: persistedEntry,
            row,
            window: window.postimage,
            transcriptWatermark,
            sideTables: {
              ...canonicalPreviousSideTables,
              ...(canonicalPreviousEntry &&
              canonicalPreviousEntry.sessionId !== normalizedEntry.sessionId
                ? { memberIdsJson: "[]" }
                : {}),
            },
          });
        }
        return persistedEntry ? structuredClone(persistedEntry) : normalizedEntry;
      };
      return {
        sessionKey,
        node: nodeChanged ? sessionNode : undefined,
        window: window.changed ? window.row : undefined,
        windowPostimage: window.postimage,
        setWindowPostimage: (postimage: typeof window.postimage) => {
          window.postimage = postimage;
        },
        batchable:
          !actor &&
          !options.allowStoredAliases &&
          canonicalPreviousEntry?.sessionId === normalizedEntry.sessionId &&
          canonicalPreviousEntry.lifecycleRevision === normalizedEntry.lifecycleRevision &&
          preparedWindow !== undefined &&
          !persisted.snapshotsChanged &&
          conversation === null &&
          !withLegacySources,
        write,
        publish,
      };
    },
  );
}

/** Certify a resident actor's one native effect using the ordinary entry writer's policy. */
export function prepareSessionActorEntryWrite(
  database: OpenClawAgentDatabase,
  state: SessionActorStoredState,
  next: SessionEntry,
) {
  const sessionKey = state.hot.target.sessionKey;
  const previous = state.hot.entry;
  const selected = state.entryRows.get(sessionKey);
  if (!previous || !selected || !state.window || state.window.session_id !== previous.sessionId) {
    return { kind: "requires-transaction" as const };
  }
  const prepared = prepareSessionEntryWrite(
    database,
    sessionKey,
    next,
    {
      canonicalPreviousEntry: previous,
      canonicalPreviousRow: selected.row,
      canonicalPreviousWindow: { sessionId: previous.sessionId, row: state.window },
      previousEntry: previous,
    },
    state,
  );
  if (!prepared) {
    return { kind: "requires-transaction" as const };
  }
  if (!prepared.node) {
    return { kind: "unchanged" as const };
  }
  const node = prepared.node;
  const terminal = getSessionEntryWriteQueries(database.db).terminalNode;
  if (!terminal) {
    return { kind: "requires-transaction" as const };
  }
  return {
    kind: "single-node" as const,
    database: terminal.database,
    publish: () => prepared.publish(undefined),
    write: () =>
      withSqliteDatabaseWriteScope(
        database.db,
        [sessionKey, sqliteSessionIdWriteScope(previous.sessionId)],
        () => terminal.write(node),
      ),
  };
}

export function writeSessionEntry(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  entry: SessionEntry,
  options: Parameters<typeof prepareSessionEntryWrite>[3] = {},
): SessionEntry {
  const prepared = prepareSessionEntryWrite(database, sessionKey, entry, options);
  return prepared.publish(prepared.write());
}

/** Archive bookkeeping shares the entry writer's policy and committed publication. */
export function writeArchivedSessionEntries(
  database: OpenClawAgentDatabase,
  inputs: readonly {
    sessionKey: string;
    entry: SessionEntry;
    previous: ResolvedSessionEntryRow;
  }[],
  postimages?: SessionEntryWritePostimages,
): SessionEntry[] {
  type Prepared = PreparedSessionEntryWrite;
  const written = new Map<string, SessionEntry>();
  const pendingWindows = new Map<string, Prepared["windowPostimage"]>();
  let batch: Prepared[] = [];
  const flush = () => {
    if (batch.length === 0) {
      return;
    }
    const nodes = new Map<string, NonNullable<Prepared["node"]>>();
    const windows = new Map<string, NonNullable<Prepared["window"]>>();
    const windowPostimages = new Map<string, Prepared["windowPostimage"]>();
    for (const prepared of batch) {
      if (prepared.node) {
        nodes.set(prepared.node.session_key, prepared.node);
      }
      if (prepared.window) {
        windows.set(prepared.window.session_id, prepared.window);
        windowPostimages.set(prepared.window.session_id, prepared.windowPostimage);
      }
    }
    withSqliteDatabaseWriteScope(
      database.db,
      batch.flatMap((prepared) => [
        prepared.sessionKey,
        sqliteSessionIdWriteScope(prepared.windowPostimage.session_id),
      ]),
      () => {
        // Each conflict key occurs once, including shared physical transcript windows.
        const generation =
          nodes.size > 0 || windows.size > 0
            ? trackSessionEntryCacheWrite(database, () => {
                if (nodes.size > 0) {
                  executeSqliteQuerySync(
                    database.db,
                    buildSessionEntryNodeUpsert(
                      database.db,
                      [...nodes.values()].map((node) =>
                        Object.assign({}, node, {
                          session_started_at: /* kysely-allow-raw: exact int64 bind matches the single-entry writer. */ sql<
                            number | null
                          >`${node.session_started_at}`,
                        }),
                      ),
                    ),
                  );
                }
                if (windows.size > 0) {
                  executeSqliteQuerySync(
                    database.db,
                    buildSessionEntryWindowUpsert(database.db, [...windows.values()], true),
                  );
                }
              })
            : undefined;
        for (const prepared of batch) {
          const window = windowPostimages.get(prepared.windowPostimage.session_id);
          if (window) {
            prepared.setWindowPostimage(window);
          }
          written.set(prepared.sessionKey, prepared.publish(generation));
        }
      },
    );
    batch = [];
  };
  const uniqueInputs = new Map(inputs.map((input) => [input.sessionKey, input]));
  for (const input of uniqueInputs.values()) {
    const facts = captureSessionEntrySnapshot(input.previous);
    const options = {
      canonicalPreviousEntry: input.previous.entry,
      canonicalPreviousRow: input.previous.row,
      canonicalPreviousWindow: facts.window && {
        ...facts.window,
        row: pendingWindows.get(input.entry.sessionId) ?? facts.window.row,
      },
      canonicalPreviousSideTables: facts.sideTables,
      postimages,
    };
    const prepared = prepareSessionEntryWrite(database, input.sessionKey, input.entry, options);
    if (!prepared.batchable) {
      flush();
      written.set(input.sessionKey, prepared.publish(prepared.write()));
      pendingWindows.set(input.entry.sessionId, prepared.windowPostimage);
      continue;
    }
    batch.push(prepared);
    // Shared windows retain exclusion provenance gained by an earlier logical node.
    pendingWindows.set(input.entry.sessionId, prepared.windowPostimage);
    if (batch.length === 64) {
      flush();
    }
  }
  flush();
  return inputs.map(({ sessionKey }) => written.get(sessionKey)!);
}
