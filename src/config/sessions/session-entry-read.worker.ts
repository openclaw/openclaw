import { expectDefined } from "@openclaw/normalization-core";
import { ok } from "@openclaw/normalization-core/result";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import { withSqlitePostCommitPublications } from "../../infra/sqlite-post-commit.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import {
  assertOpenClawAgentDatabaseIdentity,
  isOpenClawAgentDatabasePathCurrent,
  readOpenClawAgentDatabaseIdentity,
} from "../../state/openclaw-agent-db-identity.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import { SessionMetadataUnavailableError } from "../../state/session-metadata-unavailable-error.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { readSessionActivitySummary } from "./activity-summary.js";
import { resolveSessionLifecycleTimestampsWithHeader } from "./lifecycle-timestamps.js";
import { matchesPluginHostCleanupSession } from "./plugin-host-cleanup.js";
import { hasPendingSessionTranscriptArchives } from "./session-accessor.sqlite-archive-store-kernel.js";
import { readSessionCreationSnapshotInDatabase } from "./session-accessor.sqlite-creation-read.js";
import { readExactSessionEntryCandidatesInDatabase } from "./session-accessor.sqlite-entry-cache.js";
import {
  listSqliteSessionEntriesFromDatabase,
  readSelectedSessionEntriesInDatabase,
} from "./session-accessor.sqlite-entry-list.read.js";
import {
  prepareExactSessionEntryRowReads,
  readExactSessionEntryRow,
  readSessionEntryByIdInDatabase,
  readSessionEntryRow,
} from "./session-accessor.sqlite-entry-read.js";
import { participantRecordsBySessionKey } from "./session-accessor.sqlite-participant-projection.js";
import { readSessionEntryReplacementState } from "./session-accessor.sqlite-replacement-read.js";
import { resolveSqliteSessionKey } from "./session-accessor.sqlite-scope-helpers.js";
import { resolveSqliteScope } from "./session-accessor.sqlite-scope.js";
import {
  readLatestAssistantTextFromDatabase,
  readTranscriptHeaderFromDatabase,
} from "./session-accessor.sqlite-transcript-metadata-read.js";
import { readSessionTranscriptWatermarkInDatabase } from "./session-accessor.sqlite-transcript-watermark.js";
import { readSessionWorktreeOwnerFactsInDatabase } from "./session-accessor.sqlite-worktree-owner.js";
import {
  assertCanonicalSessionKeyWrite,
  assertCanonicalSqliteSessionKeysCurrent,
  canonicalSessionKeyMigrationRequiredError,
  readWithCanonicalSessionReaderContinuation,
} from "./session-canonical-key.js";
import { prepareSessionColdSourceGuard } from "./session-cold-storage-source-guard.worker.js";
import { readSessionColdTranscript } from "./session-cold-storage-state.js";
import { boundSessionDiagnosticText } from "./session-diagnostic-text.js";
import {
  assertSessionEntryCurrentNativeSource,
  readSessionEntryCurrentFactsInDatabase,
} from "./session-entry-current-admission.worker.js";
import { captureSessionEntryReadSource } from "./session-entry-read-source.js";
import type {
  SessionEntryListWorkerInput,
  SessionEntryListWorkerResult,
  SessionEntryReadWorkerInput,
  SessionEntryReadWorkerResult,
  SessionExactEntriesWorkerInput,
  SessionExactEntriesWorkerResult,
  SessionRuntimeTargetWorkerInput,
  SessionRuntimeTargetWorkerResult,
} from "./session-entry-read.types.js";
import type { SessionRowDatabaseFacts } from "./session-row-facts.types.js";
import { listSessionMembersInDatabase } from "./session-sharing-store.kernel.js";
import type { SessionStoreProjectionWorkerInput } from "./session-store-projection.types.js";
import { runWithSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import {
  MAX_SESSION_ROW_FACTS_KEYS,
  type SessionDiagnosticTextWorkerInput,
  type SessionEntryCurrentWorkerInput,
  type SessionEntryCurrentWorkerResult,
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

/** Private entry and transcript-target reads share the same admitted reader and error codec. */
export async function readSessionEntryWorkerRequest(
  request: SessionEntryReadWorkerInput | SessionRuntimeTargetWorkerInput,
): Promise<SessionEntryReadWorkerResult | SessionRuntimeTargetWorkerResult> {
  if (request.kind === "session-runtime-target") {
    const { readSessionTranscriptRuntimeTarget } =
      await import("./session-accessor.transcript-target.js");
    const read = withOpenClawAgentDatabaseReadOnly(
      (database) => {
        const target = readSessionTranscriptRuntimeTarget(
          request.scope,
          {
            keyFormat: request.keyFormat,
            databaseAgentId: request.database.agentId,
            continuation: request.continuation,
          },
          database,
        );
        return {
          target,
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
  const [{ loadSessionEntryReadOnlyResultInScope }, { encodeSessionTranscriptWorkerError }] =
    await Promise.all([
      import("./session-accessor.sqlite-exact-read.js"),
      import("./session-history-worker-errors.js"),
    ]);
  let source: SessionEntryReadWorkerResult["source"];
  const read = loadSessionEntryReadOnlyResultInScope(
    {
      ...request.scope,
      env: cloneEnvWithPlatformSemantics(request.scope.env ?? process.env),
    },
    request.continuation,
    (readSource) => {
      if (typeof readSource.databaseIdentity !== "string") {
        throw new Error("Private session entry requires its process-held owner");
      }
      source = { ...readSource, databaseIdentity: readSource.databaseIdentity };
    },
  );
  if (!read.ok) {
    const readError = encodeSessionTranscriptWorkerError(read.error);
    if (!readError || readError.kind === "fence") {
      throw read.error;
    }
    return { kind: "session-entry-read", entry: undefined, source, readError };
  }
  return { kind: "session-entry-read", entry: read.value, source };
}

/** Cleanup selects identity columns before materializing metadata in the same worker snapshot. */
export function readSessionEntryList(request: SessionEntryListWorkerInput) {
  const scope = {
    ...request.scope,
    env: cloneEnvWithPlatformSemantics(request.scope.env ?? process.env),
  };
  let source: SessionEntryListWorkerResult["source"];

  const result = withOpenClawAgentDatabaseReadOnly(
    (database) =>
      readWithCanonicalSessionReaderContinuation(database, request.continuation, () => {
        source = captureSessionEntryReadSource(database, request.expectedIdentity);
        if (scope.cleanupSession === undefined) {
          return listSqliteSessionEntriesFromDatabase(
            database,
            resolveSqliteScope({ ...scope, sessionKey: "" }),
            scope,
          );
        }
        return withSqlitePostCommitPublications(database.db, () =>
          runSqliteDeferredTransactionSync(database.db, () => {
            const identities = executeSqliteQuerySync(
              database.db,
              getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database.db)
                .selectFrom("session_nodes")
                .select(["session_key as sessionKey", "current_session_id as sessionId"])
                .orderBy("session_key"),
            ).rows;
            const keys = identities
              .filter((row) =>
                matchesPluginHostCleanupSession(row.sessionKey, row, scope.cleanupSession),
              )
              .map((row) => row.sessionKey);
            const entries = new Map(
              readSelectedSessionEntriesInDatabase(database, keys).map((entry) => [
                entry.sessionKey,
                entry,
              ]),
            );
            return keys.flatMap((key) => {
              const entry = entries.get(key);
              return entry ? [entry] : [];
            });
          }),
        );
      }),
    { ...request.database, env: scope.env },
  );
  if (!result.found && request.expectedIdentity?.key.startsWith("file:")) {
    throw new Error("Session listing lost its captured physical owner");
  }
  return { entries: result.found ? result.value : [], source };
}

/** Canonical entry currency reuses parsed facts only at the same native connection revision. */
export function readSessionEntryCurrentFacts(
  request: SessionEntryCurrentWorkerInput,
): SessionEntryCurrentWorkerResult {
  const sessionKey = request.scope.sessionKey;
  assertCanonicalSessionKeyWrite(sessionKey, request.scope.agentId);
  if (request.source) {
    if (
      request.source.path !== request.database.path ||
      request.source.agentId !== request.database.agentId ||
      request.source.sessionKey !== sessionKey
    ) {
      throw new Error("Session currency request differs from its captured source");
    }
    assertSessionEntryCurrentNativeSource(request.source);
  }
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) =>
      readWithCanonicalSessionReaderContinuation(database, request.continuation, () => {
        const source = captureSessionEntryReadSource(
          database,
          undefined,
          "Session currency read requires its current durable owner",
        );
        if (request.source) {
          assertSessionEntryCurrentNativeSource(request.source, database);
        }
        return {
          entry: readSessionEntryCurrentFactsInDatabase(database, sessionKey),
          source,
        };
      }),
    { ...request.database, env: request.scope.env },
  );
  if (!result.found && result.reason !== "database-missing") {
    throw new SessionMetadataUnavailableError(result.reason);
  }
  return {
    kind: "session-entry-current",
    ...(result.found ? result.value : { entry: undefined }),
  };
}

/** Current identity and assistant bytes come from one existing-only read snapshot. */
export function readSessionDiagnosticText(request: SessionDiagnosticTextWorkerInput) {
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) =>
      readWithCanonicalSessionReaderContinuation(database, request.continuation, () =>
        runSqliteDeferredTransactionSync(database.db, () => {
          const source = captureSessionEntryReadSource(
            database,
            undefined,
            "Session diagnostic read requires its current durable owner",
          );
          const scope = {
            agentId: request.scope.agentId,
            sessionKey: resolveSqliteSessionKey(request.scope.sessionKey, request.scope.agentId),
            sessionId: request.scope.sessionId,
          };
          const entry = readSessionEntryRow(database, scope.sessionKey, "list")?.entry;
          if (entry?.sessionId !== scope.sessionId || entry.incognito === true) {
            return { text: undefined, source };
          }
          const latest = runWithSessionTranscriptReadFence(request.admission, () =>
            readLatestAssistantTextFromDatabase(database, scope),
          );
          return { text: latest ? boundSessionDiagnosticText(latest.text) : undefined, source };
        }),
      ),
    { ...request.database, env: request.scope.env },
  );
  if (!result.found && result.reason !== "database-missing") {
    throw new SessionMetadataUnavailableError(result.reason);
  }
  return {
    kind: "session-diagnostic-text" as const,
    ...(result.found ? result.value : { text: undefined }),
  };
}

/** Full rows share a snapshot with lifecycle fallback; list reads retain listing admission. */
export function readExactSessionEntriesWithLifecycle(
  request: SessionExactEntriesWorkerInput,
): SessionExactEntriesWorkerResult {
  if (request.projection === "exact" || request.projection === "worktree") {
    // Logical accessors validate only their candidates; unrelated rows are not listing admission.
    let source: SessionExactEntriesWorkerResult["source"];
    const read = withOpenClawAgentDatabaseReadOnly(
      (database) => {
        source = captureSessionEntryReadSource(database, request.expectedIdentity);
        using sourceGuard = prepareSessionColdSourceGuard(
          { ...request.database, env: request.env },
          request.manualCompact?.sources,
        );
        return runSqliteDeferredTransactionSync(database.db, () => {
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
                    ),
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
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) =>
      request.projection === "list"
        ? {
            kind: "session-exact-entries" as const,
            entries: readSelectedSessionEntriesInDatabase(database, request.sessionKeys, {
              continuation: request.continuation,
            }),
            lifecycleTimestamps: {},
          }
        : withSqlitePostCommitPublications(database.db, () =>
            runSqliteDeferredTransactionSync(database.db, () => {
              assertCanonicalSqliteSessionKeysCurrent(database);
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
              const selectedById = request.selection
                ? readSessionEntryByIdInDatabase(database, {
                    sessionId: request.selection.sessionId,
                    projection: "list",
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
                        participantRecordsBySessionKey(database.db, request.sessionKeys),
                      ),
                    }
                  : {}),
                kind: "session-exact-entries" as const,
                entries: selected.value,
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
            { includeBoardPresence: true },
          );
          return {
            kind: "session-row-facts" as const,
            rows: request.sessionKeys.flatMap((sessionKey) => {
              const selected = readRow(sessionKey);
              if (!selected) {
                return [];
              }
              const { entry } = selected;
              const facts: SessionRowDatabaseFacts = {
                sessionKey,
                entry,
                hasBoard:
                  selected.row.session_key === sessionKey && selected.row.board_present === 1,
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
        return withSqlitePostCommitPublications(database.db, () =>
          database.db.isTransaction ? read() : runSqliteDeferredTransactionSync(database.db, read),
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
