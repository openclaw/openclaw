import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import { isPostgresSqlConnection } from "../../infra/sql-connection.js";
import { runSqliteReadSnapshotSync } from "../../infra/sqlite-transaction.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import type {
  SessionColdBatchInput,
  SessionColdCleanupCursor,
} from "./session-accessor.sqlite-archive-types.js";
import { readSessionStateDeleteSnapshot } from "./session-accessor.sqlite-delete-snapshot.js";
import { collectSessionStateIdsForEntry } from "./session-accessor.sqlite-references.js";
import { parseSessionEntryJson } from "./session-accessor.sqlite-status.js";
import { readSessionColdStorageProtection } from "./session-cold-storage-eligibility.js";
import { readSessionColdTranscript } from "./session-cold-storage-state.js";
import { collectSessionAdmissionReferences } from "./session-history-eviction-candidates.js";
import { sessionTranscriptIndexNeedsReconcile } from "./session-transcript-index.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import { prepareColdTranscriptPayload, readTranscriptPayload } from "./transcript-payload.js";

export function selectSessionColdBatch(input: SessionColdBatchInput) {
  return withOpenClawAgentDatabaseReadOnly(
    (database) =>
      runSqliteReadSnapshotSync(
        database.db,
        () => {
          const db = getNodeSqliteKysely<DB>(database.db);
          const admissions = collectSessionAdmissionReferences({
            database,
            admissionIdentities: [...input.admissionIdentities, ...input.liveSessionKeys],
          });
          const cooled = new Set(input.cooledSessionIds);
          const externalizations = executeSqliteQuerySync(
            database.db,
            db
              .selectFrom("session_transcript_cold_archives")
              .select("session_id")
              .where("storage", "=", "sqlite")
              .$if(cooled.size + admissions.size > 0, (query) =>
                query.where("session_id", "not in", sqliteStringSet([...cooled, ...admissions])),
              )
              .orderBy("archived_at")
              .orderBy("session_id")
              .limit(input.maxTranscripts),
          ).rows.flatMap((row) => {
            const archive = readSessionColdTranscript(database.db, row.session_id);
            return archive ? [archive] : [];
          });
          let candidates: { session_id: string }[] = [];
          // A window has to be old by both clocks before protection can affect selection.
          // Check the indexed window age before reading every logical session on an idle tick.
          if (
            externalizations.length < input.maxTranscripts &&
            executeSqliteQuerySync(
              database.db,
              db
                .selectFrom("session_windows")
                .select("session_id")
                .where("updated_at", "<", input.beforeMs)
                .where("transcript_updated_at", "<", input.beforeMs)
                .limit(1),
            ).rows.length > 0
          ) {
            const excluded = readSessionColdStorageProtection(
              database,
              input.beforeMs,
              new Set(input.liveSessionKeys),
            );
            for (const id of [...admissions, ...cooled]) {
              excluded.add(id);
            }
            candidates = executeSqliteQuerySync(
              database.db,
              db
                .selectFrom("session_windows as window")
                .leftJoin(
                  "session_transcript_cold_archives as cold",
                  "cold.session_id",
                  "window.session_id",
                )
                .select("window.session_id")
                .where("cold.session_id", "is", null)
                .$if(excluded.size > 0, (query) =>
                  query.where("window.session_id", "not in", sqliteStringSet([...excluded])),
                )
                .where("window.transcript_updated_at", "<", input.beforeMs)
                .where((eb) =>
                  eb.exists(
                    eb
                      .selectFrom("transcript_events as event")
                      .select("event.seq")
                      .whereRef("event.session_id", "=", "window.session_id"),
                  ),
                )
                .orderBy("window.transcript_updated_at")
                .orderBy("window.session_id")
                .limit(input.maxTranscripts - externalizations.length),
            ).rows;
          }
          const plans = candidates.flatMap(({ session_id: sessionId }) => {
            const snapshot = readSessionStateDeleteSnapshot(database.db, sessionId);
            return snapshot.generation && snapshot.lastSeq !== null
              ? [
                  {
                    databaseOptions: input.databaseOptions,
                    sessionId,
                    snapshot,
                  },
                ]
              : [];
          });
          let freePages = 0;
          if (
            plans.length + externalizations.length === 0 &&
            !isPostgresSqlConnection(database.db)
          ) {
            freePages = Number(
              // sqlite-allow-raw -- Physical maintenance is needed only when SQLite owns free pages.
              database.db.prepare("PRAGMA freelist_count").get()?.freelist_count ?? 0,
            );
          }
          const cleanup = selectSessionColdCleanupSessions(
            database,
            input.maxTranscripts,
            input.cleanupCursor,
          );
          return {
            plans,
            externalizations,
            freePages,
            ...cleanup,
            needsReconcile: plans.some(({ sessionId }) =>
              sessionTranscriptIndexNeedsReconcile(database.db, sessionId),
            ),
          };
        },
        { databaseLabel: database.path, operationLabel: "cold transcript selection" },
      ),
    input.databaseOptions,
  );
}

/** Bound discovery even when no archive needs cleanup; cursors wrap to revisit interrupted work. */
function selectSessionColdCleanupSessions(
  database: Pick<OpenClawAgentDatabase, "db">,
  limit: number,
  cursor?: SessionColdCleanupCursor,
): { cleanupSessionIds: string[]; cleanupCursor?: SessionColdCleanupCursor } {
  const db = getNodeSqliteKysely<DB>(database.db);
  const pending: string[] = [];
  let remainingRows = 65_536;
  let cleanupCursor: SessionColdCleanupCursor | undefined;
  let archives = 0;
  for (const cold of iterateSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_transcript_cold_archives as cold")
      .select("cold.session_id")
      .where("cold.storage", "=", "file")
      .$if(cursor !== undefined, (query) =>
        query.where(
          "cold.session_id",
          cursor?.afterSeq === undefined ? ">" : ">=",
          cursor!.sessionId,
        ),
      )
      .select((eb) =>
        eb
          .or([
            eb.exists(
              eb
                .selectFrom("session_transcript_fts_rows as fts")
                .select("fts.id")
                .whereRef("fts.session_id", "=", "cold.session_id"),
            ),
            eb.exists(
              eb
                .selectFrom("session_transcript_cold_archive_chunks as chunk")
                .select("chunk.chunk_index")
                .whereRef("chunk.session_id", "=", "cold.session_id")
                .where("chunk.archive_blob", "is not", null),
            ),
          ])
          .as("hasCleanup"),
      )
      .orderBy("cold.session_id")
      .limit(limit),
  )) {
    archives++;
    cleanupCursor = { sessionId: cold.session_id };
    let needsCleanup = Boolean(cold.hasCleanup);
    if (!needsCleanup) {
      for (const row of iterateSqliteQuerySync(
        database.db,
        db
          .selectFrom("transcript_events")
          .select(["seq", "event_json", "event_zstd", "event_utf8_bytes"])
          .select((eb) => eb("navigation_json", "is not", null).as("hasNavigation"))
          .where("session_id", "=", cold.session_id)
          .where("seq", ">", cursor?.sessionId === cold.session_id ? (cursor.afterSeq ?? -1) : -1)
          .orderBy("seq")
          .limit(remainingRows),
      )) {
        remainingRows--;
        cleanupCursor.afterSeq = row.seq;
        if (
          (row.event_json !== null || row.event_zstd !== null) &&
          (row.hasNavigation ||
            prepareColdTranscriptPayload(database.db, readTranscriptPayload(row))
              .navigation_json !== null)
        ) {
          needsCleanup = true;
          break;
        }
      }
    }
    if (needsCleanup) {
      pending.push(cold.session_id);
    }
    if (remainingRows === 0) {
      return { cleanupSessionIds: pending, cleanupCursor };
    }
    cleanupCursor = { sessionId: cold.session_id };
  }
  return {
    cleanupSessionIds: pending,
    cleanupCursor: archives === limit ? cleanupCursor : undefined,
  };
}

/** Keys whose live admissions protect any selected generation, including entry references. */
export function readSessionAdmissionProtectionKeys(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionIds: readonly string[],
): Set<string> {
  const selected = new Set(sessionIds);
  const keys = new Set<string>();
  if (selected.size === 0) {
    return keys;
  }
  const db = getNodeSqliteKysely<DB>(database.db);
  for (const row of iterateSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_nodes")
      .select(["session_key", "current_session_id"])
      .select((eb) =>
        eb
          .case()
          .when(eb.and([eb("entry_valid", "=", 1), eb("has_optional_references", "=", 0)]))
          .then(null)
          .else(eb.ref("entry_json"))
          .end()
          .as("entry_json"),
      ),
  )) {
    // Admitted rows without optional references need only their canonical current ID.
    const entry =
      row.entry_json === null
        ? null
        : parseSessionEntryJson({ ...row, entry_json: row.entry_json });
    if (
      selected.has(row.current_session_id) ||
      (row.entry_json === null && selected.has(row.current_session_id.trim())) ||
      (entry && collectSessionStateIdsForEntry(entry).some((id) => selected.has(id)))
    ) {
      keys.add(normalizeStoreSessionKey(row.session_key));
    }
  }
  for (const row of iterateSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_windows")
      .select("session_key")
      .where("session_id", "in", sqliteStringSet(sessionIds)),
  )) {
    keys.add(normalizeStoreSessionKey(row.session_key));
  }
  return keys;
}
