import { sql } from "kysely";
import {
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import type { SqliteSessionFileMarker } from "./legacy-sqlite-marker.js";
import { resolveSqliteReadScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import {
  forEachVerifiedSessionColdArchiveEvent,
  MAX_SESSION_COLD_ARCHIVE_COMPRESSED_BYTES,
} from "./session-cold-storage-codec.js";
import type { SessionColdArchive } from "./session-cold-storage-state.js";
import {
  transcriptEventJsonMayOverlapRange,
  transcriptMetadataMayOverlapRange,
  type SessionTranscriptEventTimeRange,
} from "./transcript-event-time.js";
import { transcriptEventJsonSql } from "./transcript-payload.js";

export type SessionTranscriptEventTimeSource =
  | { kind: "include" }
  | { kind: "hot"; overlapsRange: boolean }
  | { kind: "cold"; storePath: string; archive: SessionColdArchive };

function coldArchiveBlobByteLengthSql() {
  return /* kysely-allow-raw: SQLite length reads the stored BLOB byte count without selecting its payload. */ sql<
    number | null
  >`length(archive_blob)`.as("archive_blob_bytes");
}

/** Read event-time evidence from one admitted database snapshot, without restoring cold rows. */
export function readSessionTranscriptEventTimeSourceFromDatabase(
  database: Pick<OpenClawAgentDatabase, "db" | "path">,
  marker: Pick<SqliteSessionFileMarker, "sessionId">,
  range: SessionTranscriptEventTimeRange,
  updatedAtMs: number | null | undefined,
): SessionTranscriptEventTimeSource {
  return runSqliteDeferredTransactionSync(
    database.db,
    () => {
      const db = getNodeSqliteKysely<DB>(database.db);
      const coldMetadata = executeSqliteQueryTakeFirstSync(
        database.db,
        db
          .selectFrom("session_transcript_cold_archives")
          .select([
            "session_id",
            "generation",
            "archive_name",
            "archive_sha256",
            "event_count",
            "raw_bytes",
            "archive_bytes",
            "last_seq",
            "archived_at",
            "storage",
          ])
          .where("session_id", "=", marker.sessionId),
      );
      if (coldMetadata) {
        const storedArchiveBytes = executeSqliteQueryTakeFirstSync(
          database.db,
          db
            .selectFrom("session_transcript_cold_archives")
            .select(coldArchiveBlobByteLengthSql())
            .where("session_id", "=", marker.sessionId),
        )?.archive_blob_bytes;
        if (
          coldMetadata.archive_bytes > MAX_SESSION_COLD_ARCHIVE_COMPRESSED_BYTES ||
          (coldMetadata.storage === "sqlite" &&
            storedArchiveBytes !== coldMetadata.archive_bytes) ||
          (coldMetadata.storage === "file" && storedArchiveBytes !== null)
        ) {
          throw new Error(
            `Cold transcript archive ${coldMetadata.archive_name} has invalid bounded size metadata`,
          );
        }
        const archiveBlob =
          coldMetadata.storage === "sqlite"
            ? executeSqliteQueryTakeFirstSync(
                database.db,
                db
                  .selectFrom("session_transcript_cold_archives")
                  .select("archive_blob")
                  .where("session_id", "=", marker.sessionId),
              )?.archive_blob
            : null;
        if (coldMetadata.storage === "sqlite" && !archiveBlob) {
          throw new Error(
            `Cold transcript archive ${coldMetadata.archive_name} has no stored bytes`,
          );
        }
        return {
          kind: "cold",
          storePath: database.path,
          archive: { ...coldMetadata, archive_blob: archiveBlob ?? null },
        };
      }
      if (transcriptMetadataMayOverlapRange(updatedAtMs, range)) {
        return { kind: "include" };
      }
      const query = db
        .selectFrom("transcript_events")
        .select(transcriptEventJsonSql(database.db).as("event_json"))
        .where("session_id", "=", marker.sessionId)
        .orderBy("seq", "asc");
      for (const row of iterateSqliteQuerySync(database.db, query)) {
        if (transcriptEventJsonMayOverlapRange(row.event_json, range)) {
          return { kind: "hot", overlapsRange: true };
        }
      }
      return { kind: "hot", overlapsRange: false };
    },
    { databaseLabel: database.path, operationLabel: "session transcript event-time preflight" },
  );
}

export async function sessionTranscriptEventTimeSourceOverlapsRange(
  source: SessionTranscriptEventTimeSource,
  range: SessionTranscriptEventTimeRange,
): Promise<boolean> {
  if (source.kind === "include") {
    return true;
  }
  if (source.kind === "hot") {
    return source.overlapsRange;
  }
  let overlapsRange = false;
  await forEachVerifiedSessionColdArchiveEvent({
    storePath: source.storePath,
    archive: source.archive,
    visitEventJson(eventJson) {
      overlapsRange ||= transcriptEventJsonMayOverlapRange(eventJson, range);
    },
  });
  return overlapsRange;
}

/** Worker-side convenience; incognito callers use the admitted host database explicitly. */
export async function sessionTranscriptEventsOverlapRange(
  marker: SqliteSessionFileMarker,
  range: SessionTranscriptEventTimeRange,
  updatedAtMs: number | null | undefined,
  env?: NodeJS.ProcessEnv,
): Promise<boolean> {
  const scope = resolveSqliteReadScope({ ...marker, env });
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) =>
      readSessionTranscriptEventTimeSourceFromDatabase(database, marker, range, updatedAtMs),
    toDatabaseOptions(scope),
  );
  if (!result.found) {
    throw new Error(`Usage transcript database is unavailable for ${marker.sessionId}`);
  }
  return sessionTranscriptEventTimeSourceOverlapsRange(result.value, range);
}
