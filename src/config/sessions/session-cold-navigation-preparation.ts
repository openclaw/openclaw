import path from "node:path";
import { sql } from "kysely";
import {
  enableNodeSqliteKyselyStatementCache,
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { openNodeSqliteDatabase, resolveImmutableSqliteFileUri } from "../../infra/node-sqlite.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import { assertSqliteDatabaseAdmissionWaitActive } from "../../infra/sqlite-database-admission-wait.js";
import { admitSqliteSchema } from "../../infra/sqlite-schema-facts.js";
import { acquireSqliteSnapshotReadToken } from "../../infra/sqlite-snapshot-staging.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
  type DatabaseFileIdentity,
} from "../../infra/sqlite-worker-identity.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../../state/openclaw-agent-schema.js";
import type { SessionColdArchive } from "./session-accessor.sqlite-archive-types.js";
import { iterateSessionColdRecords } from "./session-cold-storage-chunks.js";
import { SessionColdArchiveReadError } from "./session-cold-storage-codec.js";
import { backfillSessionColdNavigationInTransaction } from "./session-cold-storage-navigation.js";
import {
  pendingSessionColdNavigationQuery,
  readSessionColdTranscript,
} from "./session-cold-storage-state.js";
import { deleteSessionTranscriptFtsRowsInTransaction } from "./session-transcript-fts.js";
import { readTranscriptStorageEncoding } from "./transcript-payload.js";

export type PreparedSessionColdNavigation = {
  kind: "prepared";
  archive: Omit<SessionColdArchive, "archive_blob">;
  directory: string;
  stagingIdentity: DatabaseFileIdentity;
  sourceIdentity: DatabaseFileIdentity;
  encoding: string;
};
export type SessionColdNavigationPreparation =
  | PreparedSessionColdNavigation
  | { kind: "unavailable"; warning?: string };

/** The session read worker builds disposable rows, never reserving the source writer. */
export function prepareSessionColdNavigation(
  source: Pick<OpenClawAgentDatabase, "db" | "path">,
  sessionId: string,
  directory: string,
): SessionColdNavigationPreparation {
  const archive = readSessionColdTranscript(source.db, sessionId);
  if (
    !archive ||
    !executeSqliteQueryTakeFirstSync(
      source.db,
      pendingSessionColdNavigationQuery(source.db)
        .select("archive.session_id")
        .where("archive.session_id", "=", sessionId),
    )
  ) {
    return { kind: "unavailable" };
  }
  const release = acquireSqliteSnapshotReadToken(directory);
  try {
    const stagingPath = path.join(directory, "database.sqlite");
    using staging = openNodeSqliteDatabase(stagingPath);
    const encoding = readTranscriptStorageEncoding(source.db);
    // Reuse the maintained schema and exact native projection/encoding, not a second codec.
    // This private scratch is never registered as an agent store or used after restart.
    executeSqliteQuerySync(staging, {
      compile: () =>
        sql`PRAGMA encoding = ${sql.lit(encoding)}`.compile(getNodeSqliteKysely(staging)),
    });
    const db = getNodeSqliteKysely<DB>(staging);
    runSqliteImmediateTransactionSync(
      staging,
      () => {
        // Scratch has no published readers; create its schema in the same transaction
        // instead of syncing every table/index before preparing the archive.
        staging.exec(OPENCLAW_AGENT_SCHEMA_SQL);
        admitSqliteSchema(staging);
        enableNodeSqliteKyselyStatementCache(staging);
        // Only transcript rows leave scratch. These private parent rows satisfy the
        // canonical foreign keys and let the existing archive index repair run here.
        executeSqliteQuerySync(
          staging,
          db.insertInto("session_nodes").values({
            session_key: sessionId,
            current_session_id: sessionId,
            entry_json: "{}",
            updated_at: 0,
          }),
        );
        executeSqliteQuerySync(
          staging,
          db.insertInto("session_windows").values({
            session_id: sessionId,
            session_key: sessionId,
            created_at: 0,
            updated_at: 0,
          }),
        );
        backfillSessionColdNavigationInTransaction(
          { db: staging, path: stagingPath },
          archive,
          function* () {
            for (const record of iterateSessionColdRecords(source.db, source.path, archive)) {
              assertSqliteDatabaseAdmissionWaitActive();
              yield record;
            }
          },
        );
      },
      { operationLabel: "sessions.cold-navigation.prepare" },
    );
    const identity = readOpenClawAgentDatabaseIdentity(source);
    return {
      kind: "prepared",
      archive,
      directory,
      encoding,
      sourceIdentity: { key: `file:${identity.identity}`, birthtime: identity.birthtime },
      stagingIdentity: readDatabasePathIdentitySync(stagingPath),
    };
  } catch (error) {
    if (error instanceof SessionColdArchiveReadError) {
      return { kind: "unavailable", warning: error.message };
    }
    throw error;
  } finally {
    release();
  }
}

/** Attach only fully prepared disposable bytes; the canonical owner still grants the write. */
export function openPreparedSessionColdNavigation(
  database: EngineConnection,
  databasePath: string,
  prepared: PreparedSessionColdNavigation,
) {
  const release = acquireSqliteSnapshotReadToken(prepared.directory);
  try {
    const filename = path.join(prepared.directory, "database.sqlite");
    assertExistingDatabaseIdentity(
      filename,
      prepared.stagingIdentity.key,
      prepared.stagingIdentity.birthtime,
    );
    executeSqliteQuerySync(database, {
      compile: () =>
        sql`ATTACH DATABASE ${resolveImmutableSqliteFileUri(filename)} AS cold_navigation`.compile(
          getNodeSqliteKysely(database),
        ),
    });
  } catch (error) {
    release();
    throw error;
  }
  return {
    publish() {
      if (!database.isTransaction) {
        throw new Error("Prepared cold navigation requires its owner's transaction");
      }
      assertExistingDatabaseIdentity(
        databasePath,
        prepared.sourceIdentity.key,
        prepared.sourceIdentity.birthtime,
      );
      const current = readSessionColdTranscript(database, prepared.archive.session_id);
      const pending = executeSqliteQueryTakeFirstSync(
        database,
        pendingSessionColdNavigationQuery(database)
          .select("archive.session_id")
          .where("archive.session_id", "=", prepared.archive.session_id),
      );
      if (!current || !pending) {
        return false;
      }
      // Externalization may change storage while leaving the same canonical archive.
      if (
        current.generation !== prepared.archive.generation ||
        current.archive_sha256 !== prepared.archive.archive_sha256 ||
        current.archive_name !== prepared.archive.archive_name ||
        current.event_count !== prepared.archive.event_count ||
        current.last_seq !== prepared.archive.last_seq ||
        current.raw_bytes !== prepared.archive.raw_bytes ||
        current.archive_bytes !== prepared.archive.archive_bytes ||
        readTranscriptStorageEncoding(database) !== prepared.encoding
      ) {
        throw new Error("Cold transcript changed before navigation publication");
      }
      // Migrated databases can have a different physical column order than a
      // newly created scratch. Name both sides; never copy positional SELECT *.
      const tables = {
        transcript_events: [
          "session_id",
          "seq",
          "event_json",
          "created_at",
          "event_zstd",
          "event_utf8_bytes",
          "navigation_json",
          "navigation_type",
          "navigation_custom_type",
          "navigation_display",
          "message_role",
          "navigation_last_type",
          "navigation_last_custom_type",
          "navigation_valid",
        ],
        transcript_event_identities: [
          "session_id",
          "event_id",
          "seq",
          "event_type",
          "parent_id",
          "message_idempotency_key",
          "created_at",
        ],
        session_transcript_active_events: [
          "session_id",
          "active_position",
          "event_seq",
          "message_position",
          "context_eligible",
        ],
        session_transcript_index_state: [
          "session_id",
          "indexed_seq",
          "leaf_event_id",
          "needs_rebuild",
          "active_event_count",
          "active_message_count",
          "updated_at",
        ],
        session_transcript_active_event_facts: [
          "session_id",
          "seq",
          "serialized_bytes",
          "dependency_navigation_json",
        ],
      } as const satisfies {
        [
          Table in
            | "transcript_events"
            | "transcript_event_identities"
            | "session_transcript_active_events"
            | "session_transcript_index_state"
            | "session_transcript_active_event_facts"
        ]: readonly (keyof DB[Table])[];
      };
      for (const [table, columns] of Object.entries(tables)) {
        // kysely-allow-raw: atomic native copy of the same schema's closed projection tables.
        const names = sql.join(columns.map((column) => sql.ref(column)));
        executeSqliteQuerySync(database, {
          compile: () =>
            sql`INSERT INTO ${sql.table(table)} (${names}) SELECT ${names} FROM ${sql.table(`cold_navigation.${table}`)} WHERE session_id = ${current.session_id}`.compile(
              getNodeSqliteKysely(database),
            ),
        });
      }
      deleteSessionTranscriptFtsRowsInTransaction(database, current.session_id);
      return true;
    },
    close() {
      try {
        database.exec("DETACH DATABASE cold_navigation");
      } finally {
        release();
      }
    },
  };
}
