import type { DatabaseSync } from "node:sqlite";
import { ensureColumn, tableExists } from "./openclaw-state-db-schema-helpers.js";

/** Complete the derived projection before any writer or column-only reader runs. */
export function migratePredicateColumnsV21(db: DatabaseSync, previousVersion: number): boolean {
  if (previousVersion >= 21) {
    return false;
  }
  let changed = false;
  const text = (column: string, path: string) =>
    `CASE WHEN json_valid(${column}) THEN CASE WHEN json_type(${column}, '${path}') = 'text' THEN json_extract(${column}, '${path}') END END`;
  if (tableExists(db, "meeting_transcript_sessions")) {
    const source = ["accountId", "guildId", "channelId", "meetingUrl", "threadTs", "fileId"];
    const columns = [
      "source_account_id",
      "source_guild_id",
      "source_channel_id",
      "source_meeting_url",
      "source_thread_ts",
      "source_file_id",
    ];
    for (const column of [...columns, "metadata_agent_id"]) {
      changed = ensureColumn(db, "meeting_transcript_sessions", `${column} TEXT`) || changed;
    }
    db.exec(`UPDATE meeting_transcript_sessions SET
      ${columns.map((column, i) => `${column} = ${text("source_json", `$.${source[i]}`)}`).join(",")},
      metadata_agent_id = ${text("metadata_json", "$.agentId")}`);
  }
  if (tableExists(db, "meeting_transcript_summaries")) {
    changed = ensureColumn(db, "meeting_transcript_summaries", "overview TEXT") || changed;
    db.exec(
      `UPDATE meeting_transcript_summaries SET overview = ${text("summary_json", "$.overview")}`,
    );
  }
  if (tableExists(db, "delivery_queue_entries")) {
    changed = ensureColumn(db, "delivery_queue_entries", "retention_id_prefix TEXT") || changed;
    changed = ensureColumn(db, "delivery_queue_entries", "retention_max_age_ms INTEGER") || changed;
    changed =
      ensureColumn(db, "delivery_queue_entries", "retention_max_entries INTEGER") || changed;
    // Keep the shipped JSON1 eligibility expressions, including true -> INTEGER 1
    // and compound prefixes -> compact JSON text. Invalid policies project all NULL.
    db.exec(`UPDATE delivery_queue_entries SET
      (retention_id_prefix, retention_max_age_ms, retention_max_entries) = (
        SELECT id_prefix, max_age_ms, max_entries FROM (
          SELECT json_extract(entry_json, '$.completionRetention.idPrefix') id_prefix,
            json_extract(entry_json, '$.completionRetention.maxAgeMs') max_age_ms,
            json_extract(entry_json, '$.completionRetention.maxEntries') max_entries
          WHERE json_valid(entry_json)
            AND json_type(entry_json, '$.completionRetention') = 'object'
        ) WHERE typeof(id_prefix) = 'text' AND id_prefix <> ''
          AND substr(id, 1, length(id_prefix)) = id_prefix
          AND typeof(max_age_ms) = 'integer' AND max_age_ms BETWEEN 1 AND 9007199254740991
          AND typeof(max_entries) = 'integer' AND max_entries BETWEEN 1 AND 9007199254740991
      )`);
  }
  return changed;
}
