import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type {
  DB as OpenClawAgentKyselyDatabase,
  SessionReactions,
} from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { StoredMessageReactionSummary } from "./session-reaction-store.types.js";

export function reactionDb(database: Pick<OpenClawAgentDatabase, "db">) {
  return getNodeSqliteKysely<
    Pick<OpenClawAgentKyselyDatabase, "session_reactions" | "transcript_event_identities">
  >(database.db);
}

export function summarizeReactions(rows: SessionReactions[]): StoredMessageReactionSummary[] {
  const summaries = new Map<string, StoredMessageReactionSummary>();
  for (const row of rows) {
    let summary = summaries.get(row.emoji);
    if (!summary) {
      summary = { emoji: row.emoji, count: 0, identities: [] };
      summaries.set(row.emoji, summary);
    }
    summary.count += 1;
    summary.identities.push({
      id: row.identity_id,
      ...(row.identity_label ? { label: row.identity_label } : {}),
    });
  }
  return [...summaries.values()];
}

export function reactionRows(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionKey: string,
  sessionId: string,
) {
  return reactionDb(database)
    .selectFrom("session_reactions")
    .selectAll()
    .where("session_key", "=", sessionKey)
    .where("session_id", "=", sessionId)
    .orderBy("created_at")
    .orderBy("emoji")
    .orderBy("identity_id");
}

export function listSessionReactionsInDatabase(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionKey: string,
  params: { sessionId: string },
): Record<string, StoredMessageReactionSummary[]> {
  const messages = Map.groupBy(
    executeSqliteQuerySync(database.db, reactionRows(database, sessionKey, params.sessionId)).rows,
    (row) => row.message_id,
  );
  return Object.fromEntries(
    [...messages].map(([messageId, rows]) => [messageId, summarizeReactions(rows)]),
  );
}
