import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { ConversationBindingSnapshot } from "./conversation-binding-facts.types.js";
import { parseSessionEntryJson } from "./session-accessor.sqlite-status.js";

/** Keep every candidate: deleting the winner can expose an older association. */
export function selectConversationBindingFacts(
  database: Pick<OpenClawAgentDatabase, "db">,
  conversationRefs: readonly string[],
): ConversationBindingSnapshot {
  const db = getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("conversations as c")
      .leftJoin("session_conversations as sc", "sc.conversation_id", "c.conversation_id")
      .leftJoin("session_windows as s", "s.session_id", "sc.session_id")
      .leftJoin("session_nodes as sn", "sn.session_key", "s.session_key")
      .select([
        "c.conversation_id",
        "c.kind",
        "sc.session_id",
        "sc.role",
        "sc.last_seen_at",
        "s.session_key",
        "s.primary_conversation_id",
        "sn.current_session_id",
        "sn.entry_valid",
        "sn.entry_json",
        "sn.updated_at",
      ])
      .where("c.conversation_id", "in", sqliteStringSet(conversationRefs))
      .orderBy("sc.last_seen_at", "desc")
      .orderBy("sn.updated_at", "desc"),
  ).rows;
  return {
    source: readOpenClawAgentDatabaseIdentity(database),
    catalogues: rows.map(({ conversation_id, kind }) => ({ conversation_id, kind })),
    associations: rows.flatMap((row) =>
      row.session_id && row.role && row.last_seen_at !== null
        ? [
            {
              session_id: row.session_id,
              conversation_id: row.conversation_id,
              role: row.role,
              last_seen_at: row.last_seen_at,
            },
          ]
        : [],
    ),
    windows: rows.flatMap((row) =>
      row.session_id && row.session_key
        ? [
            {
              session_id: row.session_id,
              session_key: row.session_key,
              primary_conversation_id: row.primary_conversation_id,
            },
          ]
        : [],
    ),
    nodes: rows.flatMap((row) =>
      row.session_key &&
      row.current_session_id &&
      row.entry_valid !== null &&
      row.updated_at !== null
        ? [
            {
              session_key: row.session_key,
              current_session_id: row.current_session_id,
              entry_valid: row.entry_valid,
              updated_at: row.updated_at,
              entry_session_id: row.entry_json
                ? (parseSessionEntryJson({ entry_json: row.entry_json })?.sessionId ?? null)
                : null,
            },
          ]
        : [],
    ),
  };
}
