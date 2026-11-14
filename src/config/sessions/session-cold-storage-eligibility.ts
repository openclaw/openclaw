import {
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import { readLegacyCompactionHistory } from "./legacy-compaction-history.js";
import { parseCanonicalSqliteSessionEntry } from "./session-entry-json.js";
import type { InternalSessionEntry } from "./types.js";

/** Cold storage preserves logical owners; only activity and explicit cross-generation references protect bytes. */
export function readSessionColdStorageProtection(
  database: { db: EngineConnection },
  beforeMs: number,
  liveSessionKeys: ReadonlySet<string>,
  sessionIds?: readonly string[],
): Set<string> {
  const db = getNodeSqliteKysely<DB>(database.db);
  const protectedIds = new Set<string>();
  const busyKeys = new Set(liveSessionKeys);
  // Keep only protection facts, not a second store-wide array of serialized metadata.
  for (const row of iterateSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_nodes")
      .select([
        "session_key",
        "current_session_id",
        "updated_at",
        "last_activity_at",
        "last_interaction_at",
        "entry_json",
      ])
      .$if(sessionIds !== undefined, (query) =>
        query.where((eb) =>
          eb.or([
            eb("has_optional_references", "=", 1),
            eb("current_session_id", "in", sqliteStringSet(sessionIds!)),
            eb(
              "session_key",
              "in",
              db
                .selectFrom("session_windows")
                .select("session_key")
                .where("session_id", "in", sqliteStringSet(sessionIds!)),
            ),
          ]),
        ),
      ),
  )) {
    const entry: InternalSessionEntry | undefined =
      parseCanonicalSqliteSessionEntry(row) ?? undefined;
    if (!entry || entry.resumeAfterRestart) {
      busyKeys.add(row.session_key);
    }
    if (
      Math.max(row.updated_at, row.last_activity_at ?? 0, row.last_interaction_at ?? 0) >= beforeMs
    ) {
      protectedIds.add(row.current_session_id);
    }
    if (!entry) {
      continue;
    }
    if (entry.previousSessionId) {
      protectedIds.add(entry.previousSessionId);
    }
    for (const id of entry.usageFamilySessionIds ?? []) {
      if (id !== row.current_session_id) {
        protectedIds.add(id);
      }
    }
    for (const checkpoint of readLegacyCompactionHistory(entry)) {
      // A self-reference is not cross-generation; the current window stays governed by activity.
      for (const id of [
        checkpoint.sessionId,
        checkpoint.preCompaction.sessionId,
        checkpoint.postCompaction.sessionId,
      ]) {
        if (id && id !== row.current_session_id) {
          protectedIds.add(id);
        }
      }
    }
  }
  for (const row of iterateSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_windows")
      .select("session_id")
      .$if(sessionIds !== undefined, (query) =>
        query.where("session_id", "in", sqliteStringSet(sessionIds!)),
      )
      // Live work, a graceful resume marker, and unreadable nodes protect the exact key.
      .where((eb) =>
        eb.or([
          ...(busyKeys.size > 0 ? [eb("session_key", "in", sqliteStringSet([...busyKeys]))] : []),
          eb("updated_at", ">=", beforeMs),
          eb(eb.fn.coalesce("transcript_updated_at", eb.val(0)), ">=", beforeMs),
        ]),
      ),
  )) {
    protectedIds.add(row.session_id);
  }

  return protectedIds;
}
