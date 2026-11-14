import {
  MEMORY_EMBEDDING_CACHE_TABLE,
  MEMORY_INDEX_DERIVED_TABLES,
  MEMORY_INDEX_META_TABLE,
} from "../../../packages/memory-host-sdk/src/host/memory-schema-base.js";
import {
  appendPreparedSessionTranscriptProjectionChunkInTransaction,
  prepareProjectionSource,
  prepareSessionTranscriptProjection,
} from "../../config/sessions/session-transcript-projection-rebuild.js";
import type { PortEndpoint } from "./port-types.js";

export const AGENT_PORT_PROJECTION_TABLES = [
  "session_transcript_fts_rows",
  "session_transcript_fts",
  "standing_intents_fts",
  // Keep chunk vectors and their identity in the verified copy, even when the cache evicted them.
  ...MEMORY_INDEX_DERIVED_TABLES.filter(
    (table) =>
      table !== MEMORY_EMBEDDING_CACHE_TABLE &&
      table !== MEMORY_INDEX_META_TABLE &&
      table !== "memory_index_chunks",
  ),
] as const;

/** Navigation rows are copied exactly; only hot search projections are reconstructed. */
export async function rebuildAgentPortProjections(target: PortEndpoint): Promise<void> {
  const sessions =
    target.engine === "sqlite"
      ? // sqlite-allow-raw -- Offline port enumeration; the transcript owner prepares each projection.
        target.db
          .prepare(`SELECT session_id FROM session_windows AS session
          WHERE NOT EXISTS (SELECT 1 FROM session_transcript_cold_archives AS archive
            WHERE archive.session_id = session.session_id) ORDER BY session_id`)
          .all()
      : (
          await target.db.query<{
            session_id: string;
            generation: string | null;
            transcript_updated_at: string | null;
          }>(`SELECT session.session_id, session.transcript_updated_at, rewrite.generation
            FROM session_windows AS session LEFT JOIN transcript_rewrite_watermarks AS rewrite
              ON rewrite.session_id = session.session_id
            WHERE NOT EXISTS (SELECT 1 FROM session_transcript_cold_archives AS archive
              WHERE archive.session_id = session.session_id) ORDER BY session.session_id`)
        ).rows;
  for (const session of sessions) {
    const sessionId = String(session.session_id);
    let plan: ReturnType<typeof prepareProjectionSource>;
    if (target.engine === "sqlite") {
      plan = prepareSessionTranscriptProjection(target.db, sessionId);
    } else {
      const events = (
        await target.db.query<{ event_json: string; seq: string; created_at: string }>(
          "SELECT event_json, seq, created_at FROM transcript_events WHERE session_id = $1 ORDER BY seq",
          [sessionId],
        )
      ).rows.map((row) => ({
        event_json: row.event_json,
        seq: Number(row.seq),
        created_at: Number(row.created_at),
      }));
      const bySequence = new Map(events.map((row) => [row.seq, row]));
      plan = prepareProjectionSource({
        sessionId,
        transcriptGeneration: String(session.generation ?? "") || null,
        transcriptUpdatedAt:
          session.transcript_updated_at == null ? null : Number(session.transcript_updated_at),
        rows: () => events,
        row: (seq) => bySequence.get(seq),
      });
    }
    if (!plan) {
      continue;
    }
    if (target.engine === "sqlite") {
      appendPreparedSessionTranscriptProjectionChunkInTransaction(target.db, {
        sessionId,
        ftsRows: plan.ftsRows,
      });
    } else {
      for (const row of plan.ftsRows) {
        await target.db.query(
          `WITH inserted AS (
            INSERT INTO session_transcript_fts_rows (session_id, message_id) VALUES ($1, $2)
            RETURNING id
          ) INSERT INTO session_transcript_fts ("rowid", text, session_id, message_id, role, timestamp)
            SELECT id, $3, $1, $2, $4, $5 FROM inserted`,
          [sessionId, row.messageId, row.text, row.role, row.timestamp],
        );
      }
    }
  }
  // The command invokes the selected memory owner after publishing and releasing port custody.
  // The owner force-rebuilds from sources, reusing the preserved cache and compatible chunk vectors.
  const seed =
    "INSERT INTO memory_index_state (id, revision) VALUES (1, 0) ON CONFLICT (id) DO NOTHING";
  if (target.engine === "sqlite") {
    // sqlite-allow-raw -- Seed omitted derived state and rebuild the canonical external-content FTS.
    target.db.exec(
      `${seed}; INSERT INTO standing_intents_fts(standing_intents_fts) VALUES ('rebuild')`,
    );
  } else {
    await target.db.query(seed);
  }
}
