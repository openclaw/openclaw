import type { DatabaseSync } from "node:sqlite";
import { hasAgentAuthProfileSourceInDatabase } from "../../agents/auth-profiles/sqlite-json.js";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import { runSqliteReadOperationSync } from "../../infra/sqlite-schema-facts.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { assertExistingDatabaseIdentity } from "../../infra/sqlite-worker-identity.js";
import {
  assertOpenClawAgentDatabaseIdentity,
  isOpenClawAgentDatabasePathCurrent,
  readOpenClawAgentDatabaseIdentity,
} from "../../state/openclaw-agent-db-identity.js";
import {
  withOpenClawAgentDatabaseReadOnly,
  type OpenClawAgentReadOnlyDatabase,
} from "../../state/openclaw-agent-db-readonly.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import { resolveSessionLifecycleTimestampsWithHeader } from "./lifecycle-timestamps.js";
import {
  readSessionEntryRow,
  readSessionKeyBySessionIdInDatabase,
} from "./session-accessor.sqlite-entry-read.js";
import { assertCanonicalSqliteSessionKeysCurrent } from "./session-canonical-key.js";
import {
  sessionColdArchiveMetadataColumns,
  type SessionColdArchive,
} from "./session-cold-storage-state.js";
import { SessionEntryChangedDuringReadError } from "./session-entry-read-errors.js";
import type {
  SessionEntryCohortRequest,
  SessionEntryCohortResult,
  SessionExactEntriesWorkerInput,
  SessionExactEntriesWorkerResult,
} from "./session-entry-read.types.js";
import { readSessionTranscriptAnchorFactsInDatabase } from "./session-transcript-anchor-read.kernel.js";
import { MAX_SESSION_ROW_FACTS_KEYS } from "./session-transcript-worker.types.js";

/** The entry cohort bounds this selection and owns its fresh snapshot. */
function readSessionColdTranscripts(
  db: DatabaseSync,
  sessionIds: readonly string[],
): Array<Omit<SessionColdArchive, "archive_blob">> {
  if (sessionIds.length === 0) {
    return [];
  }
  return executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<DB>(db)
      .selectFrom("session_transcript_cold_archives")
      .select(sessionColdArchiveMetadataColumns)
      .where("session_id", "in", sqliteStringSet(sessionIds)),
  ).rows;
}

/** Captured cohorts retain their native handle and snapshot; standalone reads keep admission. */
export function createSessionEntryReadScope(capturedDatabase?: OpenClawAgentReadOnlyDatabase) {
  return {
    assertCanonicalRead: (
      database: OpenClawAgentReadOnlyDatabase,
      expectedIdentity: SessionExactEntriesWorkerInput["expectedIdentity"],
    ) => {
      if (expectedIdentity) {
        assertOpenClawAgentDatabaseIdentity(database, expectedIdentity);
      }
      // Admitted cohorts validate current selected bytes, including uncertified foreign edits.
      if (!capturedDatabase) {
        assertCanonicalSqliteSessionKeysCurrent(database);
      }
    },
    readDatabase: <T>(
      read: (database: OpenClawAgentReadOnlyDatabase) => T,
      options: Parameters<typeof withOpenClawAgentDatabaseReadOnly>[1],
    ) =>
      capturedDatabase
        ? { found: true as const, value: read(capturedDatabase) }
        : withOpenClawAgentDatabaseReadOnly(read, options),
    snapshot: <T>(database: OpenClawAgentReadOnlyDatabase, read: () => T) =>
      capturedDatabase?.db === database.db && database.db.isTransaction
        ? read()
        : runSqliteDeferredTransactionSync(database.db, read),
  };
}

/** One bounded snapshot on the supplied owner; no locator resolution or connection admission. */
export function readSessionEntryCohort(
  database: OpenClawAgentReadOnlyDatabase,
  input: SessionEntryCohortRequest,
  readEntries: (request: SessionExactEntriesWorkerInput) => SessionExactEntriesWorkerResult,
): SessionEntryCohortResult {
  const {
    expected,
    transcript,
    runtimeTarget,
    includeAuthProfileSource,
    includeColdMetadata,
    ...selection
  } = input;
  const count =
    input.sessionKeys.length +
    (input.replyInitializationSessionKey ? 1 : 0) +
    (transcript?.entryIds.length ?? 0) +
    (runtimeTarget ? 1 : 0);
  if (
    count > MAX_SESSION_ROW_FACTS_KEYS ||
    (expected?.sessions.length ?? 0) > MAX_SESSION_ROW_FACTS_KEYS
  ) {
    throw new Error(
      `Session entry cohorts support at most ${MAX_SESSION_ROW_FACTS_KEYS} selected facts`,
    );
  }
  if (runtimeTarget && !input.sessionKeys.includes(runtimeTarget.sessionKey)) {
    throw new Error("Session runtime target must belong to its entry cohort");
  }
  const source = readOpenClawAgentDatabaseIdentity(database);
  if (typeof source.identity !== "string" || !isOpenClawAgentDatabasePathCurrent(database)) {
    throw new Error("Session entry cohort requires its admitted durable owner");
  }
  const identity = source.identity;
  const assertSource = () => {
    assertExistingDatabaseIdentity(database.path, `file:${identity}`, source.birthtime);
    const current = readOpenClawAgentDatabaseIdentity(database);
    if (
      current.incarnation !== source.incarnation ||
      !isOpenClawAgentDatabasePathCurrent(database) ||
      (expected && current.incarnation !== expected.incarnation)
    ) {
      throw new SessionEntryChangedDuringReadError();
    }
  };
  assertSource();
  const read = (): SessionEntryCohortResult => {
    assertSource();
    const sharedHeader =
      transcript?.includeHeader && transcript.sessionKey === input.lifecycleSessionKey;
    const result = readEntries({
      ...selection,
      kind: "session-exact-entries",
      database: { agentId: database.agentId, path: database.path },
      env: {},
      projection: "full",
      includeAuthorization: true,
      ...(sharedHeader ? { lifecycleSessionKey: undefined } : {}),
    });
    for (const selected of expected?.sessions ?? []) {
      const entry = result.entries.find(
        ({ sessionKey }) => sessionKey === selected.sessionKey,
      )?.entry;
      if (
        !entry ||
        entry.sessionId !== selected.sessionId ||
        entry.lifecycleRevision !== selected.lifecycleRevision
      ) {
        throw new SessionEntryChangedDuringReadError();
      }
    }
    const entry =
      transcript &&
      result.entries.find(({ sessionKey }) => sessionKey === transcript.sessionKey)?.entry;
    const transcriptFacts =
      transcript && entry
        ? readSessionTranscriptAnchorFactsInDatabase(
            database,
            {
              agentId: transcript.agentId ?? database.agentId,
              path: database.path,
              sessionKey: transcript.sessionKey,
              sessionId: entry.sessionId,
            },
            { ...transcript, entryIds: [...new Set(transcript.entryIds)] },
          )
        : { anchors: [] };
    const authProfileSource = includeAuthProfileSource
      ? hasAgentAuthProfileSourceInDatabase(database.db)
      : undefined;
    const preparedRuntimeTarget = runtimeTarget && {
      ...runtimeTarget,
      sessionKey:
        readSessionKeyBySessionIdInDatabase(database, runtimeTarget.sessionId) ??
        runtimeTarget.sessionKey,
      storePath: database.path,
    };
    assertSource();
    return {
      ...result,
      ...(preparedRuntimeTarget ? { runtimeTarget: preparedRuntimeTarget } : {}),
      ...(includeColdMetadata
        ? {
            coldArchives: readSessionColdTranscripts(
              database.db,
              result.entries.map(({ entry: selectedEntry }) => selectedEntry.sessionId),
            ),
          }
        : {}),
      source: {
        agentId: database.agentId,
        path: database.path,
        databaseIdentity: identity,
        databaseBirthtime: source.birthtime,
      },
      databaseIdentity: { ...source, identity },
      ...(sharedHeader
        ? {
            lifecycleTimestamps: resolveSessionLifecycleTimestampsWithHeader({
              entry,
              agentId: database.agentId,
              sessionKey: input.lifecycleSessionKey,
              readHeader: () => transcriptFacts.header,
            }),
          }
        : {}),
      ...(transcript ? { transcript: transcriptFacts } : {}),
      ...(includeAuthProfileSource ? { authProfileSource } : {}),
    };
  };
  // The transaction owner performs the one fresh probe after BEGIN; nested kernels share it.
  return database.db.isTransaction
    ? runSqliteReadOperationSync(database.db, read)
    : runSqliteDeferredTransactionSync(database.db, read);
}

/** Standalone data reads retain their original canonical kernel without a cohort transaction. */
export function readSessionEntryDataInDatabase(
  database: OpenClawAgentReadOnlyDatabase,
  sessionKey: string,
): SessionEntryCohortResult {
  const source = readOpenClawAgentDatabaseIdentity(database);
  const identity = source.identity;
  if (typeof identity !== "string") {
    throw new Error("Session entry read requires its admitted durable owner");
  }
  const assertSource = () => {
    assertExistingDatabaseIdentity(database.path, `file:${identity}`, source.birthtime);
    if (
      readOpenClawAgentDatabaseIdentity(database).incarnation !== source.incarnation ||
      !isOpenClawAgentDatabasePathCurrent(database)
    ) {
      throw new Error("Session entry read changed its admitted physical owner");
    }
  };
  assertSource();
  const entry = readSessionEntryRow(database, sessionKey)?.entry;
  assertSource();
  return {
    kind: "session-exact-entries",
    source: {
      agentId: database.agentId,
      path: database.path,
      databaseIdentity: identity,
      databaseBirthtime: source.birthtime,
    },
    databaseIdentity: { ...source, identity },
    entries: entry ? [{ sessionKey, entry }] : [],
    lifecycleTimestamps: {},
  };
}
