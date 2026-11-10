import type { SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { buildConversationRef } from "../routing/conversation-ref.js";
import {
  backfillSessionConversations,
  ensureSessionAdditiveColumns,
  migrateConversationDeliveryTargetColumn,
} from "./openclaw-agent-db-session-migrations.js";
import { expectRow, readRows } from "./openclaw-state-db-fixtures.test-support.js";

const deliveryContext = (channel: string, to: string) => ({ channel, accountId: "default", to });
function expectValues(
  database: ReturnType<typeof conversationDatabase>,
  sql: string,
  expected: unknown,
) {
  expect(
    readRows(database, sql).map((row) => Object.values(row)),
    sql,
  ).toEqual(expected);
}

function conversationDatabase(deliveryTarget = true) {
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(":memory:");
  database.exec(`
    ${deliveryTarget ? "PRAGMA foreign_keys = ON;" : ""}
    CREATE TABLE conversations (
      conversation_id TEXT PRIMARY KEY, channel TEXT NOT NULL, account_id TEXT NOT NULL,
      kind TEXT NOT NULL, peer_id TEXT NOT NULL,
      ${deliveryTarget ? "delivery_target TEXT NOT NULL," : ""}
      parent_conversation_id TEXT, thread_id TEXT, native_channel_id TEXT,
      native_direct_user_id TEXT, label TEXT, metadata_json TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY, session_key TEXT NOT NULL, session_scope TEXT NOT NULL,
      chat_type TEXT, primary_conversation_id TEXT
    );
    CREATE TABLE session_entries (
      session_key TEXT PRIMARY KEY, session_id TEXT NOT NULL,
      entry_json TEXT NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE session_conversations (
      session_id TEXT NOT NULL, conversation_id TEXT NOT NULL, role TEXT NOT NULL,
      first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, conversation_id, role)
    );
    CREATE UNIQUE INDEX idx_agent_conversations_identity${deliveryTarget ? "" : "_v8"}
      ON conversations(channel, account_id, kind, peer_id,
        IFNULL(parent_conversation_id, ''), IFNULL(thread_id, ''));
    CREATE UNIQUE INDEX idx_agent_session_conversations_primary
      ON session_conversations(session_id) WHERE role = 'primary';
  `);
  return database;
}

describe("agent DB conversation migration", () => {
  it("adds nullable route context without advancing the schema version", () => {
    const sqlite = requireNodeSqlite();
    using database = new sqlite.DatabaseSync(":memory:");
    database.exec(`
      PRAGMA user_version = 17;
      CREATE TABLE session_conversations (
        session_id TEXT NOT NULL, conversation_id TEXT NOT NULL, role TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, conversation_id, role)
      ) STRICT;
      INSERT INTO session_conversations (
        session_id, conversation_id, role, first_seen_at, last_seen_at
      ) VALUES ('session-a', 'conversation-a', 'primary', 1, 1);
    `);

    ensureSessionAdditiveColumns(database);
    ensureSessionAdditiveColumns(database);
    const update = (columns: string, ...values: SQLInputValue[]) =>
      database
        .prepare(
          `UPDATE session_conversations SET ${columns} WHERE session_id = ? AND conversation_id = ?`,
        )
        .run(...values, "session-a", "conversation-a");
    const route = (writeId: string) =>
      JSON.stringify({ version: 1, writeId, observedAt: 1, context: { guildId: "guild-a" } });
    const currentRoute = route("current-write");
    update("route_context_json = ?", route("candidate-write"));
    update("route_context_json = ?, last_seen_at = ?", currentRoute, 1);
    expectRow(
      database,
      "SELECT route_context_json FROM session_conversations WHERE session_id = 'session-a'",
      { route_context_json: currentRoute },
    );
    update("last_seen_at = ?", 1);

    expectRow(database, "PRAGMA user_version", { user_version: 17 });
    expectRow(
      database,
      "SELECT route_context_json, last_seen_at FROM session_conversations WHERE session_id = 'session-a'",
      { route_context_json: null, last_seen_at: 1 },
    );
  });

  it("backfills direct targets and shared-main participants", () => {
    using database = conversationDatabase();
    const insertSession = database.prepare(
      "INSERT INTO sessions (session_id, session_key, session_scope, chat_type) VALUES (?, ?, ?, ?)",
    );
    const entryStatement = database.prepare(
      "INSERT INTO session_entries (session_key, session_id, entry_json, updated_at) VALUES (?, ?, ?, ?)",
    );
    const session = (id: string, key: string, scope: string, chat: string | null = null) =>
      insertSession.run(id, `agent:main:${key}`, scope, chat);
    const entry = (id: string, key: string, channel: string, to: string, at: number, extra = {}) =>
      entryStatement.run(
        `agent:main:${key}`,
        id,
        JSON.stringify({ deliveryContext: deliveryContext(channel, to), ...extra }),
        at,
      );
    session("shared", "main", "shared-main", "channel");
    entry("shared", "main", "discord", "channel:shared-ops", 50, { groupId: "shared-ops" });
    entry("shared", "reef:direct:peer-a", "reef", "reef:peer-a", 100);
    session("dedicated", "reef:direct:peer-b", "conversation", "direct");
    entry("dedicated", "reef:direct:peer-b", "reef", "reef:peer-b", 200, {
      chatType: "direct",
      origin: { provider: "reef", nativeDirectUserId: "stale-peer", from: "reef:stale-peer" },
    });
    entry("dedicated", "reef:direct:peer-a:related", "reef", "reef:peer-a", 300, {
      chatType: "direct",
      origin: { provider: "reef", nativeDirectUserId: "peer-a" },
    });
    session("channel-case", "legacy-room", "channel");
    entry("channel-case", "legacy-room", "discord", "channel:ops-room", 400, {
      groupId: "ops-room",
    });
    session("group-case", "legacy-group", "channel");
    entry("group-case", "legacy-group", "telegram", "-100123", 500, { groupId: "crew-room" });
    session("thread-case", "discord:channel:ops-room:thread", "channel");
    entry("thread-case", "discord:channel:ops-room:thread", "discord", "channel:ops-room", 600, {
      chatType: "channel",
      groupId: "ops-room",
      deliveryContext: {
        ...deliveryContext("discord", "channel:ops-room"),
        threadId: "user-context",
      },
    });

    backfillSessionConversations(database);

    expectValues(
      database,
      `SELECT sc.session_id, sc.role, c.kind, c.peer_id, c.delivery_target
           FROM session_conversations sc
           JOIN conversations c ON c.conversation_id = sc.conversation_id
           ORDER BY sc.session_id, sc.role, c.peer_id`,
      [
        ["channel-case", "primary", "channel", "ops-room", "channel:ops-room"],
        ["dedicated", "primary", "direct", "peer-a", "reef:peer-a"],
        ["dedicated", "related", "direct", "peer-b", "reef:peer-b"],
        ["group-case", "primary", "group", "-100123", "-100123"],
        ["shared", "participant", "direct", "peer-a", "reef:peer-a"],
        ["shared", "primary", "channel", "shared-ops", "channel:shared-ops"],
        ["thread-case", "primary", "channel", "ops-room", "channel:ops-room"],
      ],
    );
    expectRow(
      database,
      `SELECT c.conversation_id, c.parent_conversation_id, c.thread_id
           FROM session_conversations sc
           JOIN conversations c ON c.conversation_id = sc.conversation_id
           WHERE sc.session_id = 'thread-case'`,
      {
        conversation_id: buildConversationRef({
          channel: "discord",
          accountId: "default",
          kind: "channel",
          peerId: "ops-room",
          threadId: "user-context",
        }),
        parent_conversation_id: null,
        thread_id: "user-context",
      },
    );
    expectValues(
      database,
      `SELECT s.session_id, s.primary_conversation_id, c.peer_id
           FROM sessions s
           JOIN conversations c ON c.conversation_id = s.primary_conversation_id
           WHERE s.session_id IN ('shared', 'dedicated') ORDER BY s.session_id`,
      [
        ["dedicated", expect.stringMatching(/^conv_[a-f0-9]{32}$/u), "peer-a"],
        ["shared", expect.stringMatching(/^conv_[a-f0-9]{32}$/u), "shared-ops"],
      ],
    );
  });

  it("drops unrecoverable v8 delivery targets", () => {
    using database = conversationDatabase(false);
    database.exec(`
      INSERT INTO conversations (
        conversation_id, channel, account_id, kind, peer_id, created_at, updated_at
      ) VALUES
        ('stale-direct', 'reef', 'default', 'direct', 'peer-a', 1, 1),
        ('stale-channel', 'discord', 'default', 'channel', 'ops-room', 1, 1);
      INSERT INTO sessions (
        session_id, session_key, session_scope, primary_conversation_id
      ) VALUES
        ('recoverable', 'agent:main:reef:direct:peer-a', 'conversation', 'stale-direct'),
        ('orphaned', 'agent:main:discord:channel:ops-room', 'channel', 'stale-channel');
      INSERT INTO session_conversations (
        session_id, conversation_id, role, first_seen_at, last_seen_at
      ) VALUES
        ('recoverable', 'stale-direct', 'primary', 1, 1),
        ('orphaned', 'stale-channel', 'primary', 1, 1);
      INSERT INTO session_entries (session_key, session_id, entry_json, updated_at)
      VALUES (
        'agent:main:reef:direct:peer-a',
        'recoverable',
        '{"chatType":"direct","origin":{"provider":"reef","nativeDirectUserId":"peer-a"},"deliveryContext":{"channel":"reef","accountId":"default","to":"reef:peer-a"}}',
        100
      );
    `);

    migrateConversationDeliveryTargetColumn(database);
    backfillSessionConversations(database);

    expectValues(
      database,
      "SELECT conversation_id, delivery_target FROM conversations ORDER BY conversation_id",
      [[expect.stringMatching(/^conv_[a-f0-9]{32}$/u), "reef:peer-a"]],
    );
    expectRow(
      database,
      "SELECT primary_conversation_id FROM sessions WHERE session_id = 'orphaned'",
      { primary_conversation_id: null },
    );
    expectRow(
      database,
      "SELECT COUNT(*) AS count FROM session_conversations WHERE session_id = 'orphaned'",
      { count: 0 },
    );
  });
});
