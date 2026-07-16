// Active transcript projection tests cover branch rebuilds and bounded large-history reads.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { persistSessionTranscriptTurn } from "./session-accessor.js";
import {
  readRecentSessionTranscriptMessageEvents,
  readSessionTranscriptMessageAnchorPage,
  readSessionTranscriptMessageEventById,
  readSessionTranscriptMessageEventCount,
  readSessionTranscriptMessageEventPage,
} from "./session-accessor.sqlite-active-events.js";

describe("SQLite active transcript event projection", () => {
  let stateDir: string;
  let scope: {
    agentId: string;
    env: NodeJS.ProcessEnv;
    sessionId: string;
    sessionKey: string;
  };

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-active-transcript-"));
    scope = {
      agentId: "main",
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      sessionId: "active-transcript-test",
      sessionKey: "agent:main:active-transcript-test",
    };
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("rebuilds branch rewinds into the same active path used by history", async () => {
    await persistSessionTranscriptTurn(scope, {
      messages: [
        {
          eventId: "root",
          parentId: null,
          message: { role: "user", content: "root" },
        },
        {
          eventId: "inactive",
          parentId: "root",
          message: { role: "assistant", content: "inactive" },
        },
        {
          eventId: "active",
          parentId: "root",
          message: { role: "assistant", content: "active" },
        },
      ],
      touchSessionEntry: false,
    });
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });

    expect(
      database.db
        .prepare(
          "SELECT needs_rebuild, active_message_count FROM session_transcript_index_state WHERE session_id = ?",
        )
        .get(scope.sessionId),
    ).toEqual({ active_message_count: 2, needs_rebuild: 1 });

    const page = readSessionTranscriptMessageEventPage(scope, { maxMessages: 10, offset: 0 });

    expect(page.events.map((entry) => (entry.event as { id?: unknown }).id)).toEqual([
      "root",
      "active",
    ]);
    expect(page.events.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(page.totalMessages).toBe(2);
    expect(
      database.db
        .prepare(
          "SELECT needs_rebuild, active_event_count, active_message_count FROM session_transcript_index_state WHERE session_id = ?",
        )
        .get(scope.sessionId),
    ).toEqual({ active_event_count: 2, active_message_count: 2, needs_rebuild: 0 });
    expect(
      database.db
        .prepare(
          "SELECT active_position, event_seq, message_position FROM session_transcript_active_events WHERE session_id = ? ORDER BY active_position",
        )
        .all(scope.sessionId),
    ).toEqual([
      { active_position: 0, event_seq: 1, message_position: 0 },
      { active_position: 1, event_seq: 3, message_position: 1 },
    ]);
  });

  it("keeps projection state and rows on one snapshot during a concurrent append", async () => {
    await persistSessionTranscriptTurn(scope, {
      messages: [
        {
          eventId: "seed",
          parentId: null,
          message: { role: "toolResult", content: "seed" },
        },
      ],
      touchSessionEntry: false,
    });
    expect(readSessionTranscriptMessageEventCount(scope)).toBe(1);

    const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });
    const state = database.db
      .prepare(
        `
          SELECT indexed_seq, active_event_count, active_message_count
          FROM session_transcript_index_state
          WHERE session_id = ?
        `,
      )
      .get(scope.sessionId) as {
      active_event_count: number;
      active_message_count: number;
      indexed_seq: number;
    };
    const nextSeq = state.indexed_seq + 1;
    const appendedEvent = {
      type: "message",
      id: "concurrent",
      parentId: "seed",
      message: { role: "toolResult", content: "concurrent" },
    };
    const { DatabaseSync } = requireNodeSqlite();
    const writer = new DatabaseSync(database.path);
    writer.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 1000; PRAGMA foreign_keys = ON;");
    let appended = false;
    const options = {
      maxBytes: 1024 * 1024,
      maxLines: 10,
      get maxMessages() {
        if (!appended) {
          appended = true;
          writer.exec("BEGIN IMMEDIATE;");
          try {
            writer
              .prepare(
                `
                  INSERT INTO transcript_events (session_id, seq, event_json, created_at)
                  VALUES (?, ?, ?, ?)
                `,
              )
              .run(scope.sessionId, nextSeq, JSON.stringify(appendedEvent), Date.now());
            writer
              .prepare(
                `
                  INSERT INTO transcript_event_identities
                    (session_id, event_id, seq, event_type, parent_id,
                     message_idempotency_key, created_at)
                  VALUES (?, 'concurrent', ?, 'message', 'seed', NULL, ?)
                `,
              )
              .run(scope.sessionId, nextSeq, Date.now());
            writer
              .prepare(
                `
                  INSERT INTO session_transcript_active_events
                    (session_id, active_position, event_seq, message_position)
                  VALUES (?, ?, ?, ?)
                `,
              )
              .run(scope.sessionId, state.active_event_count, nextSeq, state.active_message_count);
            writer
              .prepare(
                `
                  UPDATE session_transcript_index_state
                  SET indexed_seq = ?, leaf_event_id = 'concurrent', needs_rebuild = 0,
                      active_event_count = active_event_count + 1,
                      active_message_count = active_message_count + 1,
                      updated_at = ?
                  WHERE session_id = ?
                `,
              )
              .run(nextSeq, Date.now(), scope.sessionId);
            writer.exec("COMMIT;");
          } catch (error) {
            writer.exec("ROLLBACK;");
            throw error;
          }
        }
        return 10;
      },
    };

    try {
      const concurrentRead = readRecentSessionTranscriptMessageEvents(scope, options);
      expect(concurrentRead.totalMessages).toBe(1);
      expect(concurrentRead.events.map((entry) => (entry.event as { id?: string }).id)).toEqual([
        "seed",
      ]);

      const afterCommit = readRecentSessionTranscriptMessageEvents(scope, {
        maxBytes: 1024 * 1024,
        maxLines: 10,
        maxMessages: 10,
      });
      expect(afterCommit.totalMessages).toBe(2);
      expect(afterCommit.events.map((entry) => (entry.event as { id?: string }).id)).toEqual([
        "seed",
        "concurrent",
      ]);
    } finally {
      writer.close();
    }
  });

  it("keeps page, recent, count, id, and anchor reads bounded at 100k messages", async () => {
    await persistSessionTranscriptTurn(scope, {
      messages: [
        {
          eventId: "seed",
          message: { role: "toolResult", content: "seed" },
        },
      ],
      touchSessionEntry: false,
    });
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });
    const insertEvent = database.db.prepare(`
      INSERT INTO transcript_events (session_id, seq, event_json, created_at)
      VALUES (?, ?, ?, ?)
    `);
    const insertIdentity = database.db.prepare(`
      INSERT INTO transcript_event_identities
        (session_id, event_id, seq, event_type, parent_id, message_idempotency_key, created_at)
      VALUES (?, ?, ?, 'message', ?, NULL, ?)
    `);
    const insertActive = database.db.prepare(`
      INSERT INTO session_transcript_active_events
        (session_id, active_position, event_seq, message_position)
      VALUES (?, ?, ?, ?)
    `);
    database.db.exec("BEGIN IMMEDIATE;");
    try {
      database.db
        .prepare("DELETE FROM session_transcript_fts WHERE session_id = ?")
        .run(scope.sessionId);
      database.db
        .prepare("DELETE FROM session_transcript_index_state WHERE session_id = ?")
        .run(scope.sessionId);
      database.db
        .prepare("DELETE FROM transcript_event_identities WHERE session_id = ?")
        .run(scope.sessionId);
      database.db
        .prepare("DELETE FROM transcript_events WHERE session_id = ?")
        .run(scope.sessionId);
      insertEvent.run(
        scope.sessionId,
        0,
        JSON.stringify({ id: scope.sessionId, type: "session", version: 3 }),
        0,
      );
      for (let index = 1; index <= 100_000; index += 1) {
        const eventId = `message-${index}`;
        const parentId = index === 1 ? null : `message-${index - 1}`;
        insertEvent.run(
          scope.sessionId,
          index,
          JSON.stringify({
            type: "message",
            id: eventId,
            parentId,
            message: { role: "toolResult", content: `payload-${index}` },
          }),
          index,
        );
        insertIdentity.run(scope.sessionId, eventId, index, parentId, index);
        insertActive.run(scope.sessionId, index - 1, index, index - 1);
      }
      database.db
        .prepare(
          `
            INSERT INTO session_transcript_index_state
              (session_id, indexed_seq, leaf_event_id, needs_rebuild,
               active_event_count, active_message_count, updated_at)
            VALUES (?, 100000, 'message-100000', 0, 100000, 100000, 100000)
          `,
        )
        .run(scope.sessionId);
      database.db.exec("COMMIT;");
    } catch (error) {
      database.db.exec("ROLLBACK;");
      throw error;
    }

    // Parse sentinel: any accidental full materialization fails before reaching the bounded tail.
    database.db
      .prepare("UPDATE transcript_events SET event_json = '{' WHERE session_id = ? AND seq = 1")
      .run(scope.sessionId);

    const page = readSessionTranscriptMessageEventPage(scope, { maxMessages: 25, offset: 0 });
    const recent = readRecentSessionTranscriptMessageEvents(scope, {
      maxBytes: 1024 * 1024,
      maxLines: 10,
      maxMessages: 10,
    });
    const lineCappedRecent = readRecentSessionTranscriptMessageEvents(scope, {
      maxBytes: 1024 * 1024,
      maxLines: 3,
      maxMessages: 10,
    });
    const byId = readSessionTranscriptMessageEventById(scope, "message-100000");
    const anchor = readSessionTranscriptMessageAnchorPage(scope, {
      maxMessages: 5,
      messageId: "message-100000",
    });

    expect(page.totalMessages).toBe(100_000);
    expect(page.events).toHaveLength(25);
    expect(page.events.map((entry) => entry.seq)).toEqual(
      Array.from({ length: 25 }, (_, index) => 99_976 + index),
    );
    expect(recent.totalMessages).toBe(100_000);
    expect(recent.events).toHaveLength(10);
    expect(recent.events.at(-1)?.seq).toBe(100_000);
    expect(lineCappedRecent.events).toHaveLength(3);
    expect(lineCappedRecent.events.at(-1)?.seq).toBe(100_000);
    expect(readSessionTranscriptMessageEventCount(scope)).toBe(100_000);
    expect(byId?.seq).toBe(100_000);
    expect(anchor).toMatchObject({
      found: true,
      hasOverreadContext: true,
      offset: 0,
      totalMessages: 100_000,
    });
    expect(anchor.events).toHaveLength(6);
    expect(anchor.events.at(-1)?.seq).toBe(100_000);
  });
});
