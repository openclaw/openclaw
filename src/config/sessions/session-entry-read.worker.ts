import { expectDefined } from "@openclaw/normalization-core";
import { readBoardSessionKeys } from "../../boards/sqlite-board-store.kernel.js";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import { withSqlitePostCommitPublications } from "../../infra/sqlite-post-commit.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import {
  isOpenClawAgentDatabasePathCurrent,
  readOpenClawAgentDatabaseIdentity,
} from "../../state/openclaw-agent-db-identity.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import { SessionMetadataUnavailableError } from "../../state/session-metadata-unavailable-error.js";
import { readSessionActivitySummary } from "./activity-summary.js";
import { resolveSessionLifecycleTimestamps } from "./lifecycle.js";
import { readSessionCreationSnapshotInDatabase } from "./session-accessor.sqlite-creation-read.js";
import { readExactSessionEntryCandidatesInDatabase } from "./session-accessor.sqlite-entry-cache.js";
import { readSelectedSessionEntryMetadataInDatabase } from "./session-accessor.sqlite-entry-list.read.js";
import { participantRecordsBySessionKey } from "./session-accessor.sqlite-participant-projection.js";
import { readTranscriptHeaderFromDatabase } from "./session-accessor.sqlite-read.js";
import { readSessionEntryReplacementState } from "./session-accessor.sqlite-replacement-read.js";
import { readSessionTranscriptWatermarkInDatabase } from "./session-accessor.sqlite-transcript-watermark.js";
import { readSessionBackingFactsInDatabase } from "./session-backing-facts.js";
import {
  assertCanonicalSqliteSessionKeysCurrent,
  assertCanonicalSqliteSessionRowsCurrent,
  canonicalSessionKeyMigrationRequiredError,
  readWithCanonicalSessionReaderContinuation,
} from "./session-canonical-key.js";
import { listSessionMembersInDatabase } from "./session-sharing-store.kernel.js";
import {
  MAX_SESSION_ROW_FACTS_KEYS,
  type SessionExactEntriesWorkerInput,
  type SessionExactEntriesWorkerResult,
  type SessionRowDatabaseFacts,
  type SessionRowFactsWorkerInput,
  type SessionRowFactsWorkerResult,
} from "./session-transcript-worker.types.js";

/** Full rows share a snapshot with lifecycle fallback; backing reads retain listing admission. */
export function readExactSessionEntriesWithLifecycle(
  request: SessionExactEntriesWorkerInput,
): SessionExactEntriesWorkerResult {
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) =>
      request.projection === "backing" || request.projection === "list"
        ? {
            kind: "session-exact-entries" as const,
            entries: (request.projection === "list"
              ? readSelectedSessionEntryMetadataInDatabase
              : readSessionBackingFactsInDatabase)(
              database,
              request.sessionKeys,
              request.continuation,
            ),
            lifecycleTimestamps: {},
          }
        : withSqlitePostCommitPublications(database.db, () =>
            runSqliteDeferredTransactionSync(database.db, () => {
              assertCanonicalSqliteSessionKeysCurrent(database);
              if (request.projection === "creation") {
                const identity = readOpenClawAgentDatabaseIdentity(database).identity;
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
                    ...readSessionCreationSnapshotInDatabase(database, sessionKey),
                    databaseIdentity: identity,
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
              const selected = expectDefined(
                readExactSessionEntryCandidatesInDatabase(
                  database,
                  [request.sessionKeys],
                  request.projection === "sharing" ? "list" : "full",
                )[0],
                "exact session read result",
              );
              if (!selected.ok) {
                throw selected.error;
              }
              if (request.projection === "sharing") {
                const { identity } = readOpenClawAgentDatabaseIdentity(database);
                if (typeof identity !== "string") {
                  throw new Error("Private session facts require their process-held owner");
                }
                const presentKeys = new Set(selected.value.map(({ sessionKey }) => sessionKey));
                const missingKeys = request.sessionKeys.filter((key) => !presentKeys.has(key));
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
                lifecycleTimestamps: resolveSessionLifecycleTimestamps({
                  entry,
                  agentId: database.agentId,
                  sessionKey: request.lifecycleSessionKey,
                  readHeader: (sessionId) => readTranscriptHeaderFromDatabase(database, sessionId),
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
  return { kind: "session-exact-entries", entries: [], lifecycleTimestamps: {} };
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
      readWithCanonicalSessionReaderContinuation(database, request.continuation, () =>
        withSqlitePostCommitPublications(database.db, () =>
          runSqliteDeferredTransactionSync(database.db, () => {
            assertCanonicalSqliteSessionRowsCurrent(database, request.sessionKeys);
            const selected = expectDefined(
              readExactSessionEntryCandidatesInDatabase(database, [request.sessionKeys], "list")[0],
              "session row facts read result",
            );
            if (!selected.ok) {
              throw selected.error;
            }
            return {
              kind: "session-row-facts" as const,
              rows: selected.value.map(({ sessionKey, entry }) => {
                const facts: SessionRowDatabaseFacts = {
                  sessionKey,
                  entry,
                  hasBoard: readBoardSessionKeys(database, sessionKey).length > 0,
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
          }),
        ),
      ),
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
