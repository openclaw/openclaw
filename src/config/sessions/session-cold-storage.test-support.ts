import { expect } from "vitest";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { replaceSessionEntry } from "./session-accessor.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.js";
import { waitForSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";

export const historicalId = "cold-history-window";
export const currentId = "current-window";

export async function createSessionColdStorageFixture(storePath: string) {
  const options = { agentId: "main", path: storePath };
  const scope = {
    agentId: "main",
    storePath,
    sessionKey: "agent:main:cold-roundtrip",
    sessionId: historicalId,
  };
  await replaceSessionEntry(scope, { sessionId: historicalId, updatedAt: 1 });
  await replaceTranscriptEvents(scope, [
    { type: "session", id: historicalId },
    {
      type: "message",
      id: "history-user",
      parentId: null,
      timestamp: 10,
      message: { role: "user", content: [{ type: "text", text: "你好 🦞\n".repeat(12_000) }] },
    },
    {
      type: "message",
      id: "history-assistant",
      parentId: "history-user",
      timestamp: 11,
      message: { role: "assistant", content: [{ type: "text", text: "Preserved response" }] },
    },
  ]);
  await waitForSessionTranscriptIndexReconcile(options);
  await replaceSessionEntry(scope, { sessionId: currentId, updatedAt: 1 });
  await replaceTranscriptEvents({ ...scope, sessionId: currentId }, [
    { type: "session", id: currentId, content: "Keep current history hot" },
  ]);
  await waitForSessionTranscriptIndexReconcile(options);
  await replaceSessionEntry(scope, { sessionId: currentId, updatedAt: 1 });
  runOpenClawAgentWriteTransaction(({ db: database }) => {
    const db = getNodeSqliteKysely<DB>(database);
    executeSqliteQuerySync(
      database,
      db.updateTable("session_windows").set({ previous_session_id: null }),
    );
    executeSqliteQuerySync(
      database,
      db
        .updateTable("session_windows")
        .set({ updated_at: 1, transcript_updated_at: 1 })
        .where("session_id", "=", historicalId),
    );
    // Importers preserve raw JSON spacing and identity metadata independently of event payloads.
    executeSqliteQuerySync(
      database,
      db
        .updateTable("transcript_events")
        .set({ event_json: '{ "type" : "session", "id" : "cold-history-window" }', created_at: 7 })
        .where("session_id", "=", historicalId)
        .where("seq", "=", 0),
    );
    executeSqliteQuerySync(
      database,
      db
        .updateTable("transcript_event_identities")
        .set({ message_idempotency_key: "original-idempotency-key", created_at: 8 })
        .where("session_id", "=", historicalId)
        .where("event_id", "=", "history-user"),
    );
  }, options);

  const database = () => openOpenClawAgentDatabase(options).db;
  const snapshot = () => {
    const db = database();
    return {
      events: db.prepare("SELECT * FROM transcript_events ORDER BY session_id, seq").all(),
      identities: db
        .prepare("SELECT * FROM transcript_event_identities ORDER BY session_id, seq, event_id")
        .all(),
      active: db
        .prepare(
          "SELECT * FROM session_transcript_active_events ORDER BY session_id, active_position",
        )
        .all(),
      index: db.prepare("SELECT * FROM session_transcript_index_state ORDER BY session_id").all(),
      search: db
        .prepare(
          "SELECT session_id, message_id, text, role, timestamp FROM session_transcript_fts ORDER BY session_id, message_id",
        )
        .all(),
      generations: db
        .prepare("SELECT * FROM transcript_rewrite_watermarks ORDER BY session_id")
        .all(),
      windows: db.prepare("SELECT * FROM session_windows ORDER BY session_id").all(),
      nodes: db.prepare("SELECT * FROM session_nodes ORDER BY session_key").all(),
    };
  };
  const original = snapshot();
  expect(original.identities).toContainEqual(
    expect.objectContaining({ message_idempotency_key: "original-idempotency-key" }),
  );
  expect(original.active).toContainEqual(expect.objectContaining({ session_id: historicalId }));
  expect(original.search).toContainEqual(
    expect.objectContaining({ message_id: "history-user", timestamp: 10 }),
  );
  return { options, scope, database, snapshot, original };
}

export function maintenanceConfig(storePath: string, enabled = true, afterDays = 30) {
  return {
    agents: { list: [{ id: "main" }] },
    session: { store: storePath, maintenance: { coldStorage: { enabled, afterDays } } },
  };
}
