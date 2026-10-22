import { expectDefined } from "@openclaw/normalization-core";
import { ok } from "@openclaw/normalization-core/result";
import { readStoredSessionRowTranscriptProjection } from "../../gateway/session-row-transcript-preview.js";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import { sqlPublicationAnchor } from "../../infra/sql-connection.js";
import { withSqlitePostCommitPublications } from "../../infra/sqlite-post-commit.js";
import { runSqliteReadSnapshotSync } from "../../infra/sqlite-transaction.js";
import {
  assertOpenClawAgentDatabaseIdentity,
  isOpenClawAgentDatabasePathCurrent,
  readOpenClawAgentDatabaseIdentity,
} from "../../state/openclaw-agent-db-identity.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { OpenClawAgentReadOnlyDatabase } from "../../state/openclaw-agent-db-readonly.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import { SessionMetadataUnavailableError } from "../../state/session-metadata-unavailable-error.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { readSessionActivitySummary } from "./activity-summary.js";
import { resolveSessionLifecycleTimestampsWithHeader } from "./lifecycle-timestamps.js";
import { hasPendingSessionTranscriptArchives } from "./session-accessor.sqlite-archive-store-kernel.js";
import { readSessionCreationSnapshotInDatabase } from "./session-accessor.sqlite-creation-read.js";
import { readExactSessionEntryCandidatesInDatabase } from "./session-accessor.sqlite-entry-cache.js";
import { readExactSessionEntryFactsInDatabase } from "./session-accessor.sqlite-entry-facts.worker.js";
import { listSqliteSessionEntriesFromDatabase } from "./session-accessor.sqlite-entry-list.read.js";
import {
  prepareExactSessionEntryRowReads,
  readExactSessionEntryRow,
  readSessionChildEntriesInDatabase,
  readSessionEntryByIdInDatabase,
  readSessionEntrySelectionInDatabase,
  readSessionKeyBySessionIdInDatabase,
} from "./session-accessor.sqlite-entry-read.js";
import { readSelectedSessionEntriesInDatabase } from "./session-accessor.sqlite-entry-selected.read.js";
import { participantRecordsBySessionKey } from "./session-accessor.sqlite-participant-projection.js";
import { readSessionEntryReplacementState } from "./session-accessor.sqlite-replacement-read.js";
import { resolveSqliteSessionKey } from "./session-accessor.sqlite-scope-helpers.js";
import { resolveSqliteScope } from "./session-accessor.sqlite-scope.js";
import { readTranscriptHeaderFromDatabase } from "./session-accessor.sqlite-transcript-metadata-read.js";
import { readSessionTranscriptWatermarkInDatabase } from "./session-accessor.sqlite-transcript-watermark.js";
import { readSessionWorktreeOwnerFactsInDatabase } from "./session-accessor.sqlite-worktree-owner.js";
import {
  canonicalSessionKeyMigrationRequiredError,
  readWithCanonicalSessionReaderContinuation,
} from "./session-canonical-key.js";
import { prepareSessionColdSourceGuard } from "./session-cold-storage-source-guard.worker.js";
import { readSessionColdTranscript } from "./session-cold-storage-state.js";
import { createSessionEntryReadScope } from "./session-entry-cohort.worker.js";
import { captureSessionEntryReadSource } from "./session-entry-read-source.js";
import type {
  SessionEntryReadWorkerInput,
  SessionEntryReadWorkerResult,
  SessionExactEntriesWorkerInput,
  SessionExactEntriesWorkerResult,
  SessionRuntimeTargetWorkerInput,
  SessionRuntimeTargetWorkerResult,
} from "./session-entry-read.types.js";
import type { SessionRowDatabaseFacts } from "./session-row-facts.types.js";
import { listSessionMembersInDatabase } from "./session-sharing-store.kernel.js";
import { readSessionSourceChecks } from "./session-source-predicate.worker.js";
import type { SessionStoreProjectionWorkerInput } from "./session-store-projection.types.js";
import { readSessionEntryTranscriptFacts } from "./session-transcript-anchor-read.kernel.js";
import {
  MAX_SESSION_ROW_FACTS_KEYS,
  type SessionRowFactsWorkerInput,
  type SessionRowFactsWorkerResult,
  type SessionTranscriptWorkerValues,
} from "./session-transcript-worker.types.js";
import { normalizeStoreSessionKey } from "./store-entry.js";

/** Hydrate a newly admitted resident store using the projection lane's native reader. */
export function readSessionStoreProjection(
  request: SessionStoreProjectionWorkerInput,
): SessionTranscriptWorkerValues["session-store-projection"] {
  const env = cloneEnvWithPlatformSemantics(request.env);
  const scope = {
    agentId: request.database.agentId,
    databaseAgentId: request.database.agentId,
    storePath: request.database.path,
    projection: "list" as const,
    clone: false,
    env,
  };
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) => {
      assertOpenClawAgentDatabaseIdentity(database, request.expectedIdentity);
      const source = readOpenClawAgentDatabaseIdentity(database);
      if (typeof source.identity !== "string") {
        throw new Error("Resident session projection requires a durable store");
      }
      const entries = listSqliteSessionEntriesFromDatabase(
        database,
        resolveSqliteScope({ ...scope, sessionKey: "" }),
        scope,
        { deferParticipants: true },
      );
      return {
        entries,
        source: {
          identity: source.identity,
          birthtime: source.birthtime,
          filename: source.filename,
        },
      };
    },
    { ...request.database, env },
  );
  return { kind: "session-store-projection", ...(result.found ? result.value : { entries: [] }) };
}

/** Runtime targets consume the existing reader without importing the caller's memory/write adapters. */
export function readSessionRuntimeTargetWorkerRequest(
  request: SessionRuntimeTargetWorkerInput,
): SessionRuntimeTargetWorkerResult {
  const read = withOpenClawAgentDatabaseReadOnly(
    (database) => {
      const { agentId, sessionId, storePath } = request.scope;
      const persistedSessionKey = readSessionKeyBySessionIdInDatabase(database, sessionId);
      const selected =
        persistedSessionKey && !request.keyFormat
          ? undefined
          : readWithCanonicalSessionReaderContinuation(database, request.continuation, () => {
              const resolved = resolveSqliteScope({
                ...request.scope,
                sessionKey: persistedSessionKey ?? request.scope.sessionKey,
                storePath: undefined,
              });
              const row = readSessionEntrySelectionInDatabase(
                database,
                resolved.agentId,
                resolved.sessionKey,
                { keyFormat: request.keyFormat, allowCanonicalMove: !persistedSessionKey },
              );
              return {
                existing: row?.entry ?? undefined,
                normalizedKey: row?.row.session_key ?? resolved.sessionKey,
              };
            });
      return {
        target: {
          agentId,
          sessionId,
          sessionKey: persistedSessionKey ?? selected?.normalizedKey ?? request.scope.sessionKey,
          storePath,
          ...(request.keyFormat
            ? {
                selectedSessionId: selected?.existing?.sessionId ?? null,
                selectedLifecycleRevision: selected?.existing?.lifecycleRevision ?? null,
              }
            : {}),
        },
        source: captureSessionEntryReadSource(
          database,
          undefined,
          "Session runtime target requires its current durable owner",
        ),
      };
    },
    { ...request.database, env: request.scope.env },
  );
  return {
    kind: "session-runtime-target",
    ...(read.found
      ? read.value
      : {
          target: {
            agentId: request.scope.agentId,
            sessionId: request.scope.sessionId,
            sessionKey: resolveSqliteSessionKey(request.scope.sessionKey, request.scope.agentId),
            storePath: request.scope.storePath,
            ...(request.keyFormat
              ? { selectedSessionId: null, selectedLifecycleRevision: null }
              : {}),
          },
        }),
  };
}

/** Private entry and transcript-target reads share the same admitted reader and error codec. */
export async function readSessionEntryWorkerRequest(
  request: SessionEntryReadWorkerInput | SessionRuntimeTargetWorkerInput,
): Promise<SessionEntryReadWorkerResult | SessionRuntimeTargetWorkerResult> {
  if (request.kind === "session-runtime-target") {
    return readSessionRuntimeTargetWorkerRequest(request);
  }
  // Keep the exact-read owner off the lazy reader import graph.
  const { readSessionEntryResult } = await import("./session-entry-read-result.worker.js");
  return readSessionEntryResult(request);
}

function selectsChildEntries(
  request: SessionExactEntriesWorkerInput,
): request is Extract<SessionExactEntriesWorkerInput, { selection: { kind: "children" } }> {
  return request.selection?.kind === "children";
}

/** Exact facts are one statement; richer selections retain their shared snapshot. */
export function readExactSessionEntriesWithLifecycle(
  request: SessionExactEntriesWorkerInput,
  capturedDatabase?: OpenClawAgentReadOnlyDatabase,
): SessionExactEntriesWorkerResult {
  if (request.sourceChecks) {
    return readSessionSourceChecks(request, capturedDatabase);
  }
  const { readDatabase, snapshot, assertCanonicalRead } =
    createSessionEntryReadScope(capturedDatabase);
  if (selectsChildEntries(request)) {
    const { parentSessionKeys } = request.selection;
    const result = readDatabase(
      (database) => {
        assertCanonicalRead(database, request.expectedIdentity);
        return {
          kind: "session-exact-entries" as const,
          entries: readSessionChildEntriesInDatabase(
            database,
            parentSessionKeys,
            request.snapshotFields ?? request.projection,
          ),
          lifecycleTimestamps: {},
        };
      },
      { ...request.database, env: request.env },
    );
    if (!result.found && result.reason !== "database-missing") {
      throw new SessionMetadataUnavailableError(result.reason);
    }
    return result.found
      ? result.value
      : { kind: "session-exact-entries", entries: [], lifecycleTimestamps: {} };
  }
  if (
    !request.selection &&
    (request.projection === undefined ||
      request.projection === "full" ||
      request.projection === "exact") &&
    !request.manualCompact &&
    !request.replyInitializationSessionKey &&
    !request.transcript &&
    request.sessionKeys.length <= MAX_SESSION_ROW_FACTS_KEYS
  ) {
    const result = readDatabase(
      (database) => {
        const read = () => {
          const source = captureSessionEntryReadSource(database, request.expectedIdentity);
          const identity = readOpenClawAgentDatabaseIdentity(database);
          const facts = readExactSessionEntryFactsInDatabase(
            database,
            request.sessionKeys,
            request.snapshotFields ?? "full",
          );
          return {
            kind: "session-exact-entries" as const,
            ...facts,
            source,
            databaseIdentity: { ...identity, identity: source.databaseIdentity },
            lifecycleTimestamps: resolveSessionLifecycleTimestampsWithHeader({
              entry: facts.entries.find(
                ({ sessionKey }) => sessionKey === request.lifecycleSessionKey,
              )?.entry,
              agentId: database.agentId,
              sessionKey: request.lifecycleSessionKey,
              readHeader: ({ sessionId }) => readTranscriptHeaderFromDatabase(database, sessionId),
            }),
          };
        };
        // Lifecycle metadata uses the captured session ID. A replaced header may be newer
        // than the entry; its own transcript snapshot suffices for this descriptive fallback.
        return read();
      },
      { ...request.database, env: request.env },
    );
    if (result.found) {
      return result.value;
    }
    if (result.reason !== "database-missing") {
      throw new SessionMetadataUnavailableError(result.reason);
    }
    if (request.expectedIdentity?.key.startsWith("file:")) {
      throw new Error("Session entry read lost its captured physical owner");
    }
    return { kind: "session-exact-entries", entries: [], lifecycleTimestamps: {} };
  }
  if (
    (request.projection === "exact" || request.projection === "worktree") &&
    !request.transcript
  ) {
    // Logical accessors validate only their candidates; unrelated rows are not listing admission.
    let source: SessionExactEntriesWorkerResult["source"];
    const read = readDatabase(
      (database) => {
        source = captureSessionEntryReadSource(database, request.expectedIdentity);
        if (request.projection === "worktree" && !request.manualCompact) {
          return {
            entries: readSessionWorktreeOwnerFactsInDatabase(database, request.sessionKeys),
          };
        }
        using sourceGuard = prepareSessionColdSourceGuard(
          { ...request.database, env: request.env },
          request.manualCompact?.sources,
        );
        return snapshot(database, () => {
          const entries =
            request.projection === "worktree"
              ? readSessionWorktreeOwnerFactsInDatabase(database, request.sessionKeys)
              : request.sessionKeys.flatMap((sessionKey) => {
                  const entry = readExactSessionEntryRow(
                    database,
                    sessionKey,
                    request.snapshotFields ?? "full",
                    "canonical",
                  )?.entry;
                  return entry ? [{ sessionKey, entry }] : [];
                });
          return {
            entries,
            ...(request.manualCompact
              ? {
                  manualCompact: {
                    archive: readSessionColdTranscript(
                      database.db,
                      request.manualCompact.sessionId,
                    ),
                    refusedSource: sourceGuard.read(
                      database,
                      new Map(
                        request.sessionKeys.map((key) => [
                          key,
                          entries.find((row) => row.sessionKey === key)?.entry,
                        ]),
                      ),
                    ).refusedSource,
                  },
                }
              : {}),
          };
        });
      },
      { ...request.database, env: request.env },
    );
    if (!read.found && read.reason !== "database-missing") {
      throw new SessionMetadataUnavailableError(read.reason);
    }
    if (!read.found && request.expectedIdentity?.key.startsWith("file:")) {
      throw new Error("Session entry read lost its captured physical owner");
    }
    return {
      kind: "session-exact-entries",
      source,
      ...(read.found ? read.value : { entries: [] }),
      lifecycleTimestamps: {},
    };
  }
  const result = readDatabase(
    (database) =>
      request.projection === "list"
        ? {
            kind: "session-exact-entries" as const,
            ...(request.expectedIdentity
              ? { source: captureSessionEntryReadSource(database, request.expectedIdentity) }
              : {}),
            entries: readSelectedSessionEntriesInDatabase(database, request.sessionKeys ?? [], {
              continuation: request.continuation,
              ...(request.selection?.kind === "label" ? { label: request.selection.label } : {}),
              ...(request.selection?.kind === "session-id-or-key"
                ? { sessionIdOrKey: request.selection.sessionIdOrKey }
                : {}),
            }),
            lifecycleTimestamps: {},
          }
        : withSqlitePostCommitPublications(sqlPublicationAnchor(database.db), () =>
            snapshot(database, () => {
              assertCanonicalRead(database, request.expectedIdentity);
              if (request.projection === "creation") {
                const { identity, canonicalPath } = readOpenClawAgentDatabaseIdentity(database);
                const sessionKey = request.sessionKeys[0];
                if (
                  typeof identity !== "string" ||
                  !sessionKey ||
                  request.sessionKeys.length !== 1
                ) {
                  throw new Error(
                    "Session creation snapshot requires its durable owner and target",
                  );
                }
                return {
                  kind: "session-exact-entries" as const,
                  entries: [],
                  lifecycleTimestamps: {},
                  creation: {
                    ...readSessionCreationSnapshotInDatabase(
                      database,
                      sessionKey,
                      request.creationLabel,
                    ),
                    databaseIdentity: identity,
                    databasePath: canonicalPath,
                  },
                };
              }
              if (request.projection === "replacement") {
                const identity = readOpenClawAgentDatabaseIdentity(database).identity;
                if (typeof identity !== "string" || !request.replacementSelection) {
                  throw new Error(
                    "Session replacement snapshot requires its durable owner and selection",
                  );
                }
                const replacement = readSessionEntryReplacementState(
                  database,
                  request.replacementSelection,
                );
                return {
                  kind: "session-exact-entries" as const,
                  entries: replacement.entries,
                  lifecycleTimestamps: {},
                  replacement: { ...replacement, databaseIdentity: identity },
                };
              }
              const selectedById =
                request.selection?.kind === "session-id"
                  ? readSessionEntryByIdInDatabase(database, {
                      sessionId: request.selection.sessionId,
                      orderBy: request.selection.orderBy,
                      projection: request.projection === "sharing" ? "list" : "full",
                    })
                  : undefined;
              const selected = request.selection
                ? ok(selectedById ? [selectedById] : [])
                : expectDefined(
                    readExactSessionEntryCandidatesInDatabase(
                      database,
                      [request.sessionKeys],
                      request.projection === "sharing"
                        ? "list"
                        : (request.snapshotFields ?? "full"),
                      { validation: capturedDatabase ? "canonical" : undefined },
                    )[0],
                    "exact session read result",
                  );
              if (!selected.ok) {
                throw selected.error;
              }
              if (request.replyInitializationSessionKey) {
                const parent = selected.value.find(
                  ({ sessionKey }) => sessionKey === request.replyInitializationSessionKey,
                )?.entry.parentSessionKey;
                const parentKey = parent ? normalizeStoreSessionKey(parent) : undefined;
                if (
                  parentKey &&
                  !selected.value.some(({ sessionKey }) => sessionKey === parentKey)
                ) {
                  const related = expectDefined(
                    readExactSessionEntryCandidatesInDatabase(
                      database,
                      [[parentKey]],
                      request.snapshotFields ?? "full",
                      { validation: capturedDatabase ? "canonical" : undefined },
                    )[0],
                    "reply initialization parent read result",
                  );
                  if (!related.ok) {
                    throw related.error;
                  }
                  selected.value.push(...related.value);
                }
              }
              if (request.projection === "sharing") {
                const source = readOpenClawAgentDatabaseIdentity(database);
                const { identity } = source;
                if (typeof identity !== "string" || !isOpenClawAgentDatabasePathCurrent(database)) {
                  throw new Error("Private session facts require their process-held owner");
                }
                const presentKeys = new Set(selected.value.map(({ sessionKey }) => sessionKey));
                const missingKeys = (request.sessionKeys ?? []).filter(
                  (key) => !presentKeys.has(key),
                );
                const placeholders = missingKeys.length
                  ? executeSqliteQuerySync(
                      database.db,
                      getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database.db)
                        .selectFrom("session_nodes as node")
                        .leftJoin("session_windows as window", (join) =>
                          join
                            .onRef("window.session_id", "=", "node.current_session_id")
                            .onRef("window.session_key", "=", "node.session_key"),
                        )
                        .select([
                          "node.session_key",
                          "node.current_session_id",
                          "node.entry_json",
                          "node.entry_valid",
                          "window.session_id as retained_session_id",
                        ])
                        .where("node.session_key", "in", sqliteStringSet(missingKeys)),
                    ).rows.map((row) => {
                      if (
                        row.entry_json !== "{}" ||
                        row.entry_valid !== -1 ||
                        row.retained_session_id !== row.current_session_id
                      ) {
                        throw canonicalSessionKeyMigrationRequiredError(
                          `invalid retained session row requires repair for ${row.session_key}`,
                        );
                      }
                      return { sessionKey: row.session_key, sessionId: row.current_session_id };
                    })
                  : [];
                return {
                  kind: "session-exact-entries" as const,
                  ...(request.includeAuthorization
                    ? { databaseIdentity: { ...source, identity } }
                    : {}),
                  entries: selected.value,
                  lifecycleTimestamps: {},
                  sharing: {
                    source: { agentId: database.agentId, path: database.path },
                    databaseIdentity: `file:${identity}`,
                    placeholders,
                    members: selected.value.map(({ sessionKey }) => ({
                      sessionKey,
                      identityIds: listSessionMembersInDatabase(database, sessionKey).map(
                        (member) => member.identityId,
                      ),
                    })),
                  },
                };
              }
              const entry = selected.value.find(
                ({ sessionKey }) => sessionKey === request.lifecycleSessionKey,
              )?.entry;
              const identity = request.includeAuthorization
                ? readOpenClawAgentDatabaseIdentity(database)
                : undefined;
              if (
                identity &&
                (typeof identity.identity !== "string" ||
                  !isOpenClawAgentDatabasePathCurrent(database))
              ) {
                throw new Error("Session database physical identity changed");
              }
              return {
                ...(identity && typeof identity.identity === "string"
                  ? { databaseIdentity: { ...identity, identity: identity.identity } }
                  : {}),
                ...(request.includeMembers
                  ? {
                      members: Object.fromEntries(
                        selected.value.map(({ sessionKey }) => [
                          sessionKey,
                          listSessionMembersInDatabase(database, sessionKey),
                        ]),
                      ),
                    }
                  : {}),
                ...(request.includeParticipantRecords
                  ? {
                      participantRecords: Object.fromEntries(
                        participantRecordsBySessionKey(
                          database.db,
                          request.sessionKeys ?? selected.value.map(({ sessionKey }) => sessionKey),
                        ),
                      ),
                    }
                  : {}),
                kind: "session-exact-entries" as const,
                entries: selected.value,
                ...readSessionEntryTranscriptFacts(database, request, selected.value),
                ...(request.projection === "lifecycle"
                  ? { pendingArchives: hasPendingSessionTranscriptArchives(database) }
                  : {}),
                lifecycleTimestamps: resolveSessionLifecycleTimestampsWithHeader({
                  entry,
                  agentId: database.agentId,
                  sessionKey: request.lifecycleSessionKey,
                  readHeader: ({ sessionId }) =>
                    readTranscriptHeaderFromDatabase(database, sessionId),
                }),
              };
            }),
          ),
    { ...request.database, env: request.env },
  );
  if (result.found) {
    return result.value;
  }
  if (result.reason !== "database-missing") {
    throw new SessionMetadataUnavailableError(result.reason);
  }
  if (request.expectedIdentity?.key.startsWith("file:")) {
    throw new Error("Session entry read lost its captured physical owner");
  }
  return {
    kind: "session-exact-entries",
    entries: [],
    lifecycleTimestamps: {},
    ...(request.projection === "lifecycle" ? { pendingArchives: false } : {}),
  };
}

/** Entry, board presence, and summary validity describe one committed snapshot. */
export function readSessionRowDatabaseFacts(
  request: SessionRowFactsWorkerInput,
): SessionRowFactsWorkerResult {
  if (request.sessionKeys.length > MAX_SESSION_ROW_FACTS_KEYS) {
    throw new Error(`Session row facts support at most ${MAX_SESSION_ROW_FACTS_KEYS} keys`);
  }
  if (request.sessionKeys.length === 0) {
    return { kind: "session-row-facts", rows: [] };
  }
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) =>
      readWithCanonicalSessionReaderContinuation(database, request.continuation, () => {
        const read = () => {
          const readRow = prepareExactSessionEntryRowReads(
            database,
            request.sessionKeys,
            "list",
            "canonical",
            { includeBoardPresence: true, includeRowTranscriptProjection: true },
          );
          return {
            kind: "session-row-facts" as const,
            rows: request.sessionKeys.flatMap((sessionKey) => {
              const selected = readRow(sessionKey);
              if (!selected) {
                return [];
              }
              const { entry } = selected;
              const storedTranscript =
                selected.row.row_transcript_window_id === null
                  ? { lastMessagePreview: null, lastAssistantMessage: null, terminalModel: null }
                  : readStoredSessionRowTranscriptProjection({
                      json: selected.row.row_transcript_json,
                      updatedAt: selected.row.row_transcript_updated_at,
                      transcriptUpdatedAt: selected.row.row_transcript_source_updated_at,
                      indexedSeq: selected.row.row_transcript_indexed_seq,
                    });
              const facts: SessionRowDatabaseFacts = {
                sessionKey,
                entry,
                hasBoard:
                  selected.row.session_key === sessionKey && selected.row.board_present === 1,
                transcriptPreview: storedTranscript?.lastMessagePreview,
                transcriptAssistantMessage: storedTranscript
                  ? storedTranscript.lastAssistantMessage
                  : "unknown",
                transcriptTerminalModel: storedTranscript?.terminalModel,
              };
              if (readSessionActivitySummary(entry)) {
                facts.activitySummaryWatermark = readSessionTranscriptWatermarkInDatabase(
                  database,
                  entry.sessionId,
                );
              }
              return facts;
            }),
          };
        };
        return withSqlitePostCommitPublications(sqlPublicationAnchor(database.db), () =>
          database.db.isTransaction ? read() : runSqliteReadSnapshotSync(database.db, read),
        );
      }),
    { ...request.database, env: request.env },
  );
  if (result.found) {
    return result.value;
  }
  if (result.reason !== "database-missing") {
    throw new SessionMetadataUnavailableError(result.reason);
  }
  return { kind: "session-row-facts", rows: [] };
}
