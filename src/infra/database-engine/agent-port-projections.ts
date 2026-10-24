import {
  MEMORY_EMBEDDING_CACHE_TABLE,
  MEMORY_INDEX_DERIVED_TABLES,
} from "../../../packages/memory-host-sdk/src/host/memory-schema-base.js";
import {
  appendPreparedSessionTranscriptProjectionChunkInTransaction,
  prepareProjectionSource,
  prepareSessionTranscriptProjection,
} from "../../config/sessions/session-transcript-projection-rebuild.js";
import type { PortEndpoint } from "./port-types.js";

export const AGENT_PORT_PROJECTION_TABLES = [
  "session_transcript_active_events",
  "session_transcript_fts_rows",
  "session_transcript_fts",
  "session_transcript_index_state",
  "standing_intents_fts",
  // Reusing embeddings must not require another provider call after an engine switch.
  ...MEMORY_INDEX_DERIVED_TABLES.filter((table) => table !== MEMORY_EMBEDDING_CACHE_TABLE),
] as const;

/** Reuse the transcript owner's branch and eligibility policy on the private port target. */
export async function rebuildAgentPortProjections(target: PortEndpoint): Promise<void> {
  const sessions =
    target.engine === "sqlite"
      ? // sqlite-allow-raw -- Offline port enumeration; the transcript owner prepares each projection.
        target.db.prepare("SELECT session_id FROM session_windows ORDER BY session_id").all()
      : (
          await target.db.query<{
            session_id: string;
            generation: string | null;
            transcript_updated_at: string | null;
          }>(`SELECT session.session_id, session.transcript_updated_at, rewrite.generation
            FROM session_windows AS session LEFT JOIN transcript_rewrite_watermarks AS rewrite
              ON rewrite.session_id = session.session_id ORDER BY session.session_id`)
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
      appendPreparedSessionTranscriptProjectionChunkInTransaction(target.db, plan);
    } else {
      for (const row of plan.activeRows) {
        await target.db.query(
          `INSERT INTO session_transcript_active_events
            (session_id, active_position, event_seq, message_position, context_eligible)
            VALUES ($1, $2, $3, $4, $5)`,
          [sessionId, row.activePosition, row.eventSeq, row.messagePosition, row.contextEligible],
        );
      }
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
    const values = [
      sessionId,
      plan.sourceIndexedSeq,
      plan.leafEventId,
      plan.activeEventCount,
      plan.activeMessageCount,
      Date.now(),
    ];
    const sql = `INSERT INTO session_transcript_index_state
      (session_id, indexed_seq, leaf_event_id, needs_rebuild, active_event_count, active_message_count, updated_at)
      VALUES ($1, $2, $3, 0, $4, $5, $6)`;
    if (target.engine === "sqlite") {
      // sqlite-allow-raw -- Offline projection publication has no concurrent writer or claim.
      target.db.prepare(sql.replace(/\$\d+/g, "?")).run(...values);
    } else {
      await target.db.query(sql, values);
    }
  }
  // The command invokes the selected memory owner after publishing and releasing port custody.
  // Seed empty metadata so that owner rebuilds from sources and the preserved embedding cache.
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
