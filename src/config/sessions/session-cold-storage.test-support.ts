import { expect } from "vitest";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import type { AgentsConfig } from "../types.agents.js";
import { replaceSessionEntrySync } from "./session-accessor.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { transcriptEventReadBytesSql } from "./session-transcript-read-bytes.js";
import { waitForSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";
import { prepareTranscriptPayload, readTranscriptPayload } from "./transcript-payload.js";
import { CURRENT_SESSION_VERSION } from "./version.js";

export const historicalId = "cold-history-window";
export const currentId = "current-window";
const history = [
  ["user", "你好 🦞\n".repeat(12_000)],
  ["assistant", "Preserved response"],
] as const;

export async function createSessionColdStorageFixture(
  storePath: string,
  sessionKey = "agent:main:cold-roundtrip",
) {
  const options = { agentId: "main", path: storePath };
  const scope = { agentId: "main", storePath, sessionKey, sessionId: historicalId };
  // Callers own explicit cold-storage maintenance; seeding must not arm automatic age cleanup.
  replaceSessionEntrySync(scope, { sessionId: historicalId, updatedAt: 1 });
  await replaceTranscriptEvents(scope, [
    { type: "session", id: historicalId, version: CURRENT_SESSION_VERSION },
    ...history.map(([role, text], index) => ({
      type: "message",
      id: `history-${role}`,
      parentId: index ? "history-user" : null,
      timestamp: new Date(10 + index).toISOString(),
      message: { role, content: [{ type: "text", text }] },
    })),
  ]);
  await waitForSessionTranscriptIndexReconcile(options);
  replaceSessionEntrySync(scope, { sessionId: currentId, updatedAt: 1 });
  await replaceTranscriptEvents({ ...scope, sessionId: currentId }, [
    { type: "session", id: currentId, version: CURRENT_SESSION_VERSION, content: "current" },
  ]);
  await waitForSessionTranscriptIndexReconcile(options);
  replaceSessionEntrySync(scope, { sessionId: currentId, updatedAt: 1 });
  runOpenClawAgentWriteTransaction(({ db: database }) => {
    const db = getNodeSqliteKysely<DB>(database);
    database.exec(`UPDATE session_windows SET previous_session_id = NULL;
      UPDATE session_windows SET updated_at = 1, transcript_updated_at = 1
      WHERE session_id = 'cold-history-window';`);
    // Importers preserve raw JSON spacing and identity metadata independently of event payloads.
    const rawHeader = `{ "type" : "session", "id" : "cold-history-window", "version" : ${CURRENT_SESSION_VERSION} }`;
    const payload = prepareTranscriptPayload(database, rawHeader);
    executeSqliteQuerySync(
      database,
      db
        .updateTable("transcript_events")
        .set({ ...payload, created_at: 7 })
        .where("session_id", "=", historicalId)
        .where("seq", "=", 0),
    );
    database
      .prepare(`UPDATE transcript_event_identities
      SET message_idempotency_key = 'original-idempotency-key', created_at = 8
      WHERE session_id = ? AND event_id = 'history-user'`)
      .run(historicalId);
  }, options);

  const database = () => requireNativeSqliteDatabase(openOpenClawAgentDatabase(options).db);
  const snapshot = (db = database()) => {
    const rows = (table: string, order: string, columns = "*") =>
      db.prepare(`SELECT ${columns} FROM ${table} ORDER BY ${order}`).all();
    return {
      events: executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<DB>(db)
          .selectFrom("transcript_events")
          .select([
            "session_id",
            "seq",
            "created_at",
            "event_json",
            "event_zstd",
            "event_utf8_bytes",
            transcriptEventReadBytesSql().as("event_bytes"),
          ])
          .orderBy("session_id")
          .orderBy("seq"),
      ).rows.map(({ event_zstd, event_utf8_bytes, ...row }) => {
        if (row.event_json !== null || event_zstd !== null) {
          row.event_json = readTranscriptPayload({ ...row, event_zstd, event_utf8_bytes });
        }
        return row;
      }),
      identities: rows("transcript_event_identities", "session_id, seq, event_id"),
      active: rows("session_transcript_active_events", "session_id, active_position"),
      index: rows("session_transcript_index_state", "session_id"),
      search: rows(
        "session_transcript_fts",
        "session_id, message_id",
        "session_id, message_id, text, role, timestamp",
      ),
      generations: rows("transcript_rewrite_watermarks", "session_id"),
      windows: rows("session_windows", "session_id"),
      nodes: rows("session_nodes", "session_key"),
    };
  };
  const original = snapshot();
  const contains = (rows: unknown[], value: object) =>
    expect(rows).toContainEqual(expect.objectContaining(value));
  contains(original.identities, { message_idempotency_key: "original-idempotency-key" });
  contains(original.active, { session_id: historicalId });
  contains(original.search, { message_id: "history-user", timestamp: 10 });
  return { options, scope, database, snapshot, original };
}

export function maintenanceConfig(storePath: string, enabled = true, afterDays = 30) {
  const agents: AgentsConfig = { entries: { main: {} } };
  return {
    agents,
    session: { store: storePath, maintenance: { coldStorage: { enabled, afterDays } } },
  };
}
