import { sql } from "kysely";
import {
  createSqliteQueryCache,
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  prepareSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import { coerceRequiredSqliteNumber as sqliteNumber } from "../../infra/sqlite-number.js";
import { runSqliteReadSnapshotSync } from "../../infra/sqlite-transaction.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withCurrentProjectionSnapshot } from "./session-accessor.sqlite-active-projection.js";
import type {
  SessionTranscriptEventRow,
  SessionTranscriptReadScope,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import {
  selectActiveTranscriptEventRows,
  selectActiveTranscriptIdentityRows,
} from "./session-accessor.sqlite-projection-read.js";
import {
  getSessionKysely,
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { assertSessionTranscriptHot } from "./session-cold-storage-state.js";
import {
  resolveSqliteSessionTranscriptReadFence,
  SessionTranscriptReadFenceError,
} from "./session-transcript-read-fence.js";
import {
  projectTranscriptRetainedDataSql,
  transcriptRetainedDataBytesSql,
} from "./session-transcript-retained-data.js";
import { transcriptEventJsonSql } from "./transcript-payload.js";

/** Native adapter for the deprecated synchronous manager and process-held incognito. */
export function loadTranscriptSuffixEventsBoundedSync(
  scope: SessionTranscriptReadScope,
  startSeq: number,
  limits: {
    maxBytes: number;
    maxEvents: number;
    retainedCustomDataIds?: readonly string[];
  },
): TranscriptEvent[] {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  return loadTranscriptSuffixEventsBoundedFromDatabase(
    openOpenClawAgentDatabase(toDatabaseOptions(resolved)),
    scope,
    startSeq,
    limits,
  );
}

export function loadTranscriptSuffixEventsBoundedFromDatabase(
  database: Pick<ReturnType<typeof openOpenClawAgentDatabase>, "db" | "path">,
  scope: SessionTranscriptReadScope,
  startSeq: number,
  limits: { maxBytes: number; maxEvents: number; retainedCustomDataIds?: readonly string[] },
): TranscriptEvent[] {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  return runSqliteReadSnapshotSync(
    database.db,
    () => {
      assertSessionTranscriptHot(database.db, resolved.sessionId);
      const db = getSessionKysely(database.db);
      const fence = resolveSqliteSessionTranscriptReadFence({ database, ...resolved });
      if (fence) {
        const hiddenSuffix = executeSqliteQueryTakeFirstSync(
          database.db,
          db
            .selectFrom("transcript_events")
            .select("seq")
            .where("session_id", "=", resolved.sessionId)
            .where("seq", ">=", fence.beforeRawSeq)
            .limit(1),
        );
        if (hiddenSuffix) {
          throw new SessionTranscriptReadFenceError(
            `Current-turn transcript admission hides rows needed for suffix mutation: ${fence.admission.entryId}`,
          );
        }
      }
      const metadata = executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("transcript_events")
          .select([
            "seq",
            /* kysely-allow-raw: reject oversized suffixes before acquiring their JSON payloads. */
            sql<number>`${transcriptRetainedDataBytesSql(database.db, limits.retainedCustomDataIds ?? [])} + 1`.as(
              "serialized_bytes",
            ),
          ])
          .where("session_id", "=", resolved.sessionId)
          .where("seq", ">=", startSeq)
          .orderBy("seq", "asc")
          .limit(limits.maxEvents + 1),
      ).rows;
      if (metadata.length > limits.maxEvents) {
        throw new Error(
          `Transcript suffix exceeds synchronous planning row limit for ${resolved.sessionId}`,
        );
      }
      let bytes = 0;
      for (const row of metadata) {
        bytes += row.serialized_bytes;
        if (bytes > limits.maxBytes) {
          throw new Error(
            `Transcript suffix exceeds synchronous planning byte limit for ${resolved.sessionId}`,
          );
        }
      }
      if (metadata.length === 0) {
        return [];
      }
      const rows = executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("transcript_events")
          .select([
            projectTranscriptRetainedDataSql(
              database.db,
              transcriptEventJsonSql(database.db),
              limits.retainedCustomDataIds ?? [],
            ).as("event_json"),
            "seq",
          ])
          .where("session_id", "=", resolved.sessionId)
          .where(
            "seq",
            "in",
            metadata.map((row) => row.seq),
          )
          .orderBy("seq", "asc"),
      ).rows;
      // SAFETY: Raw transcript rows are parsed through the persisted transcript event union.
      return rows.map((row) => JSON.parse(row.event_json) as TranscriptEvent);
    },
    {
      databaseLabel: database.path,
      operationLabel: "bounded transcript suffix read",
    },
  );
}

// Compilation belongs to the connection; each snapshot binds fresh selection parameters.
const previousIndexedEventReader = createSqliteQueryCache((db: EngineConnection) =>
  prepareSqliteQueryTakeFirstSync<
    { sessionId: string; beforeSeq: number },
    { event_json: string; seq: number }
  >(db, (parameter) =>
    selectActiveTranscriptEventRows({ db })
      .select([transcriptEventJsonSql(db, "event").as("event_json"), "event.seq"])
      .where(
        "active.session_id",
        "=",
        parameter((params) => params.sessionId),
      )
      // Resolve the position using metadata before touching the one winning payload.
      .where(
        "active.active_position",
        "=",
        selectActiveTranscriptIdentityRows({ db })
          .select((eb) => eb.fn.max<number>("active.active_position").as("position"))
          .where(
            "identity.session_id",
            "=",
            parameter((params) => params.sessionId),
          )
          .where(
            "identity.seq",
            "<",
            parameter((params) => params.beforeSeq),
          ),
      ),
  ),
);

/** Reads the nearest active indexed event before a raw transcript sequence. */
export function readPreviousIndexedTranscriptEventSync(
  scope: SessionTranscriptReadScope,
  beforeSeq: number,
  options: { readOnly?: boolean } = {},
): SessionTranscriptEventRow | undefined {
  return withCurrentProjectionSnapshot(
    scope,
    (projection) => {
      const row = previousIndexedEventReader(projection.database.db)({
        sessionId: projection.resolved.sessionId,
        beforeSeq,
      });
      return row
        ? {
            // SAFETY: Indexed transcript rows contain the persisted transcript event union.
            event: JSON.parse(row.event_json) as TranscriptEvent,
            seq: sqliteNumber(row.seq),
          }
        : undefined;
    },
    options,
  );
}
