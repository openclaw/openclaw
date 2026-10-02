import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import type {
  OpenClawAgentDatabase,
  OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import { readSessionStateDeleteSnapshot } from "./session-accessor.sqlite-delete-snapshot.js";
import { collectSessionStateIdsForEntry } from "./session-accessor.sqlite-references.js";
import { parseSessionEntryJson } from "./session-accessor.sqlite-status.js";
import { readSessionColdStorageProtection } from "./session-cold-storage-eligibility.js";
import { readSessionColdTranscript } from "./session-cold-storage-state.js";
import { collectSessionAdmissionReferences } from "./session-history-eviction-candidates.js";
import { normalizeStoreSessionKey } from "./store-entry.js";

export type SessionColdBatchInput = {
  databaseOptions: OpenClawAgentDatabaseOptions & { path: string };
  admissionIdentities: string[];
  cooledSessionIds: string[];
  beforeMs: number;
  maxTranscripts: number;
  maxBytes: number;
};
export function selectSessionColdBatch(input: SessionColdBatchInput) {
  return withOpenClawAgentDatabaseReadOnly(
    (database) =>
      runSqliteDeferredTransactionSync(
        database.db,
        () => {
          const db = getNodeSqliteKysely<DB>(database.db);
          const admissions = collectSessionAdmissionReferences({
            database,
            admissionIdentities: input.admissionIdentities,
          });
          const cooled = new Set(input.cooledSessionIds);
          const excluded = readSessionColdStorageProtection(database, input.beforeMs);
          for (const id of [...admissions, ...cooled]) {
            excluded.add(id);
          }
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
          const candidates =
            externalizations.length < input.maxTranscripts
              ? executeSqliteQuerySync(
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
                ).rows
              : [];
          const plans = candidates.flatMap(({ session_id: sessionId }) => {
            const snapshot = readSessionStateDeleteSnapshot(database.db, sessionId);
            return snapshot.generation && snapshot.lastSeq !== null
              ? [
                  {
                    databaseOptions: input.databaseOptions,
                    sessionId,
                    beforeMs: input.beforeMs,
                    snapshot,
                  },
                ]
              : [];
          });
          let freePages = 0;
          if (plans.length + externalizations.length === 0) {
            freePages = Number(
              // sqlite-allow-raw -- Physical maintenance is needed only when SQLite owns free pages.
              database.db.prepare("PRAGMA freelist_count").get()?.freelist_count ?? 0,
            );
          }
          return { plans, externalizations, freePages };
        },
        { databaseLabel: database.path, operationLabel: "cold transcript selection" },
      ),
    input.databaseOptions,
  );
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
    db.selectFrom("session_nodes").select(["session_key", "current_session_id", "entry_json"]),
  )) {
    const entry = parseSessionEntryJson(row);
    if (
      selected.has(row.current_session_id) ||
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
