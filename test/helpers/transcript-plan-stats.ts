import type { DatabaseSync, StatementSync } from "node:sqlite";
import { createTranscriptEventInserter } from "../../src/config/sessions/transcript-payload.js";

export function seedTranscriptPlanStatsFixture(db: DatabaseSync, count = 20_000) {
  const events: Record<string, unknown>[] = [];
  db.exec("BEGIN");
  for (const sessionId of ["long", "dense"]) {
    const key = `agent:synthetic:${sessionId}`;
    db.prepare(
      "INSERT INTO session_nodes(session_key,current_session_id,entry_json,updated_at) VALUES (?,?,?,1)",
    ).run(key, sessionId, "{}");
    db.prepare(
      "INSERT INTO session_windows(session_id,session_key,created_at,updated_at) VALUES (?,?,1,1)",
    ).run(sessionId, key);
    const insertEvent = createTranscriptEventInserter(db, sessionId);
    const identity = db.prepare(
      "INSERT INTO transcript_event_identities(session_id,event_id,seq,event_type,parent_id,message_idempotency_key,created_at) VALUES (?,?,?,?,?,?,1)",
    );
    const active = db.prepare(
      "INSERT INTO session_transcript_active_events(session_id,active_position,event_seq,message_position,context_eligible) VALUES (?,?,?,?,1)",
    );
    let messages = 0;
    for (let seq = 0; seq < count; seq++) {
      const type =
        seq === count - 20
          ? "custom_message"
          : seq === 0
            ? "session"
            : seq === count - 100 || seq === count - 200
              ? "reset"
              : seq === count - 50 || (sessionId === "dense" && seq % 2 === 0)
                ? "compaction"
                : "message";
      const event = {
        timestamp: "2026-11-14T00:00:00.000Z",
        ...(type === "custom_message"
          ? {
              customType: "openclaw.system-update",
              content: "update",
              display: false,
              details: { kind: "prompt-update" },
            }
          : {}),
        type,
        id: `event-${seq}`,
        parentId: seq ? `event-${seq - 1}` : null,
        ...(type === "message"
          ? {
              message: {
                role: seq === count - 1 ? "assistant" : "user",
                content: "synthetic",
                ...(seq === count - 2 ? { idempotencyKey: "committed" } : {}),
              },
            }
          : {}),
        ...(type === "compaction"
          ? { summary: "synthetic", firstKeptEntryId: `event-${seq - 1}` }
          : {}),
      };
      if (sessionId === "long") {
        events.push(event);
      }
      insertEvent({ seq, eventJson: JSON.stringify(event), createdAt: 1 });
      identity.run(
        sessionId,
        event.id,
        seq,
        type,
        event.parentId,
        seq === count - 2 ? "committed" : null,
      );
      active.run(sessionId, seq, seq, type === "message" ? messages++ : null);
    }
    db.prepare("INSERT INTO session_transcript_index_state VALUES (?,?,?,0,?,?,1)").run(
      sessionId,
      count - 1,
      `event-${count - 1}`,
      count,
      messages,
    );
  }
  db.exec("COMMIT");
  return events;
}

export function applyTranscriptPlanStatistics(
  db: DatabaseSync,
  state: "none" | "analyzed" | "team",
) {
  db.exec("ANALYZE");
  if (state === "analyzed") {
    return;
  }
  db.exec("DELETE FROM sqlite_stat1");
  // Local SQLite builds may collect STAT4 histograms; the affected store has none.
  if (db.prepare("SELECT name FROM sqlite_schema WHERE name = 'sqlite_stat4'").get()) {
    db.exec("DELETE FROM sqlite_stat4");
  }
  if (state === "team") {
    const insert = db.prepare("INSERT INTO sqlite_stat1(tbl,idx,stat) VALUES (?,?,?)");
    for (const [tbl, idx, stat] of [
      [
        "transcript_event_identities",
        "sqlite_autoindex_transcript_event_identities_1",
        "6284704 251 1",
      ],
      [
        "transcript_event_identities",
        "idx_agent_transcript_event_identity_sequence",
        "6284704 251 1",
      ],
      ["transcript_event_identities", "idx_agent_transcript_event_sequence", "6284704 251 48 1"],
      ["transcript_event_identities", "idx_agent_transcript_message_idempotency", "2335163 91 1"],
      [
        "session_transcript_active_events",
        "sqlite_autoindex_session_transcript_active_events_1",
        "6270135 251 1",
      ],
      [
        "session_transcript_active_events",
        "idx_agent_transcript_active_event_seq",
        "6270135 251 1",
      ],
      ["session_transcript_active_events", "idx_agent_transcript_context_pending", "0 0"],
      ["session_nodes", "sqlite_autoindex_session_nodes_1", "10328 1"],
      ["session_windows", "sqlite_autoindex_session_windows_1", "13752 1"],
      [
        "session_transcript_index_state",
        "sqlite_autoindex_session_transcript_index_state_1",
        "13684 1",
      ],
      [
        "transcript_rewrite_watermarks",
        "sqlite_autoindex_transcript_rewrite_watermarks_1",
        "13684 1",
      ],
    ]) {
      insert.run(tbl!, idx!, stat!);
    }
  }
  db.exec("ANALYZE sqlite_schema");
}

export function captureTranscriptSql(db: DatabaseSync, read: () => unknown) {
  const statements = new Map<string, { sql: string; columns: string[] }>();
  const prototype: StatementSync = Object.getPrototypeOf(db.prepare("SELECT 1"));
  const restorers = (["all", "get", "iterate"] as const).map((method) => {
    const original = prototype[method];
    Object.defineProperty(prototype, method, {
      value: new Proxy(original, {
        apply(invoke, statement: StatementSync, args) {
          const result = Reflect.apply(invoke, statement, args);
          if (/^(select|with)\b/iu.test(statement.sourceSQL)) {
            const sql = statement.expandedSQL;
            statements.set(sql, { sql, columns: statement.columns().map(({ name }) => name) });
          }
          return result;
        },
      }),
    });
    return () => Object.defineProperty(prototype, method, { value: original });
  });
  try {
    return { result: read(), queries: [...statements.values()] };
  } finally {
    for (const restore of restorers) {
      restore();
    }
  }
}
