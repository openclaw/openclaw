import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OriginatingChannelType } from "../../auto-reply/templating.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  loadSqliteSessionEntries,
  readSqliteSessionDeliveryContext,
} from "./session-entries.sqlite.js";
import {
  deleteSessionEntry,
  getSessionEntry,
  listSessionEntries,
  patchSessionEntry,
  recordSessionMetaFromInbound,
  updateLastRoute,
  upsertSessionEntry,
} from "./store.js";
import {
  appendSqliteSessionTranscriptEvent,
  hasSqliteSessionTranscriptEvents,
} from "./transcript-store.sqlite.js";
import type { SessionEntry } from "./types.js";

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;
type SessionEntriesTestDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  | "conversations"
  | "memory_index_chunks"
  | "memory_index_sources"
  | "session_conversations"
  | "session_entries"
  | "session_routes"
  | "sessions"
>;

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sqlite-session-entries-"));
}

function originatingChannel(channel: string): OriginatingChannelType {
  return channel as OriginatingChannelType;
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  if (ORIGINAL_STATE_DIR === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
  }
});

describe("SQLite session row backend", () => {
  it("round-trips session entries by agent id", () => {
    const stateDir = createTempDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const mainEntry: SessionEntry = {
      sessionId: "main-session",
      updatedAt: 123,
    };
    const opsEntry: SessionEntry = {
      sessionId: "ops-session",
      updatedAt: 456,
    };

    upsertSessionEntry({ agentId: "main", env, sessionKey: "discord:u1", entry: mainEntry });
    upsertSessionEntry({ agentId: "ops", env, sessionKey: "discord:u1", entry: opsEntry });

    expect(loadSqliteSessionEntries({ agentId: "main", env })).toEqual({
      "discord:u1": mainEntry,
    });
    expect(loadSqliteSessionEntries({ agentId: "ops", env })).toEqual({
      "discord:u1": opsEntry,
    });
  });

  it("routes the production session row API through SQLite", () => {
    const stateDir = createTempDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const entry: SessionEntry = {
      sessionId: "sqlite-primary",
      updatedAt: 100,
    };

    upsertSessionEntry({ agentId: "ops", env, sessionKey: "discord:ops", entry });
    upsertSessionEntry({
      agentId: "ops",
      env,
      sessionKey: "discord:ops",
      entry: {
        ...entry,
        updatedAt: 200,
        modelOverride: "gpt-5.5",
      },
    });

    expect(loadSqliteSessionEntries({ agentId: "ops", env })).toEqual({
      "discord:ops": {
        ...entry,
        updatedAt: 200,
        modelOverride: "gpt-5.5",
      },
    });
  });

  it("stores hot session metadata in canonical session roots", () => {
    const stateDir = createTempDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };

    upsertSessionEntry({
      agentId: "ops",
      env,
      sessionKey: "discord:ops",
      entry: {
        sessionId: "ops-session",
        updatedAt: 200,
        sessionStartedAt: 100,
        status: "running",
        chatType: "direct",
        channel: "discord",
        deliveryContext: {
          channel: "discord",
          to: "user:U1",
          accountId: "work",
          threadId: "thread-1",
        },
        modelProvider: "openai",
        model: "gpt-5.5",
        agentHarnessId: "codex",
        displayName: "Ops",
      },
    });

    const database = openOpenClawAgentDatabase({ agentId: "ops", env });
    const db = getNodeSqliteKysely<SessionEntriesTestDatabase>(database.db);
    const row = executeSqliteQueryTakeFirstSync(
      database.db,
      db.selectFrom("sessions").selectAll().where("session_id", "=", "ops-session"),
    );
    expect(row).toMatchObject({
      session_id: "ops-session",
      session_key: "discord:ops",
      session_scope: "conversation",
      created_at: 100,
      updated_at: 200,
      status: "running",
      chat_type: "direct",
      channel: "discord",
      model_provider: "openai",
      model: "gpt-5.5",
      agent_harness_id: "codex",
      display_name: "Ops",
    });
  });

  it("rejects invalid persisted session and conversation enum values", () => {
    const stateDir = createTempDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const database = openOpenClawAgentDatabase({ agentId: "ops", env });
    const db = getNodeSqliteKysely<SessionEntriesTestDatabase>(database.db);

    expect(() =>
      executeSqliteQuerySync(
        database.db,
        db.insertInto("sessions").values({
          session_id: "invalid-session",
          session_key: "invalid-session",
          session_scope: "legacy-file",
          created_at: 1,
          updated_at: 1,
        }),
      ),
    ).toThrow(/CHECK constraint failed/);

    expect(() =>
      executeSqliteQuerySync(
        database.db,
        db.insertInto("conversations").values({
          conversation_id: "invalid-conversation",
          channel: "discord",
          account_id: "default",
          kind: "file",
          peer_id: "user:U1",
          created_at: 1,
          updated_at: 1,
        }),
      ),
    ).toThrow(/CHECK constraint failed/);
  });

  it("does not recover route updates from stale entry_json delivery context", async () => {
    const stateDir = createTempDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };

    upsertSessionEntry({
      agentId: "ops",
      env,
      sessionKey: "discord:ops",
      entry: {
        sessionId: "ops-session",
        updatedAt: 200,
        chatType: "direct",
        channel: "discord",
        deliveryContext: {
          channel: "discord",
          to: "user:U1",
          accountId: "work",
        },
      },
    });

    const database = openOpenClawAgentDatabase({ agentId: "ops", env });
    const db = getNodeSqliteKysely<SessionEntriesTestDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      db
        .updateTable("session_entries")
        .set({
          entry_json: JSON.stringify({
            sessionId: "ops-session",
            updatedAt: 200,
            chatType: "direct",
            channel: "discord",
            deliveryContext: {
              channel: "discord",
              to: "user:stale",
              accountId: "stale-account",
            },
          }),
        })
        .where("session_key", "=", "discord:ops"),
    );
    executeSqliteQuerySync(database.db, db.deleteFrom("conversations"));

    await updateLastRoute({
      agentId: "ops",
      env,
      sessionKey: "discord:ops",
      channel: "discord",
      to: "user:U2",
    });

    expect(getSessionEntry({ agentId: "ops", env, sessionKey: "discord:ops" })).toMatchObject({
      deliveryContext: {
        channel: "discord",
        to: "user:U2",
        accountId: "default",
      },
      lastChannel: "discord",
      lastTo: "user:U2",
      lastAccountId: "default",
    });
  });

  it("projects hot session fields from typed rows instead of entry_json", () => {
    const stateDir = createTempDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };

    upsertSessionEntry({
      agentId: "ops",
      env,
      sessionKey: "discord:ops",
      entry: {
        sessionId: "ops-session",
        updatedAt: 200,
        status: "running",
        chatType: "direct",
        channel: "discord",
        deliveryContext: {
          channel: "discord",
          to: "user:U1",
          accountId: "work",
          threadId: "thread-1",
        },
        modelProvider: "openai",
        model: "gpt-5.5",
        agentHarnessId: "codex",
        displayName: "Ops",
      },
    });

    const database = openOpenClawAgentDatabase({ agentId: "ops", env });
    const db = getNodeSqliteKysely<SessionEntriesTestDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      db
        .updateTable("session_entries")
        .set({
          entry_json: JSON.stringify({
            sessionId: "stale-session",
            updatedAt: 1,
            status: "stale",
            chatType: "group",
            channel: "slack",
            deliveryContext: {
              channel: "slack",
              to: "wrong",
              accountId: "stale",
              threadId: "wrong-thread",
            },
            modelProvider: "anthropic",
            model: "claude",
            agentHarnessId: "legacy",
            displayName: "Stale",
          }),
        })
        .where("session_key", "=", "discord:ops"),
    );

    expect(getSessionEntry({ agentId: "ops", env, sessionKey: "discord:ops" })).toMatchObject({
      sessionId: "ops-session",
      updatedAt: 200,
      status: "running",
      chatType: "direct",
      channel: "discord",
      lastChannel: "discord",
      lastTo: "user:U1",
      lastAccountId: "work",
      lastThreadId: "thread-1",
      deliveryContext: {
        channel: "discord",
        to: "user:U1",
        accountId: "work",
        threadId: "thread-1",
      },
      modelProvider: "openai",
      model: "gpt-5.5",
      agentHarnessId: "codex",
      displayName: "Ops",
    });
    expect(loadSqliteSessionEntries({ agentId: "ops", env })["discord:ops"]).toMatchObject({
      sessionId: "ops-session",
      updatedAt: 200,
      chatType: "direct",
      channel: "discord",
      lastTo: "user:U1",
    });
    expect(listSessionEntries({ agentId: "ops", env })[0]?.entry).toMatchObject({
      sessionId: "ops-session",
      updatedAt: 200,
      chatType: "direct",
      channel: "discord",
      lastTo: "user:U1",
    });
  });

  it("can read a session row when entry_json is no longer parseable", () => {
    const stateDir = createTempDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };

    upsertSessionEntry({
      agentId: "ops",
      env,
      sessionKey: "discord:ops",
      entry: {
        sessionId: "ops-session",
        updatedAt: 200,
        chatType: "direct",
        channel: "discord",
        deliveryContext: {
          channel: "discord",
          to: "user:U1",
          accountId: "work",
        },
      },
    });

    const database = openOpenClawAgentDatabase({ agentId: "ops", env });
    const db = getNodeSqliteKysely<SessionEntriesTestDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      db
        .updateTable("session_entries")
        .set({ entry_json: "{not-json" })
        .where("session_key", "=", "discord:ops"),
    );

    expect(getSessionEntry({ agentId: "ops", env, sessionKey: "discord:ops" })).toMatchObject({
      sessionId: "ops-session",
      updatedAt: 200,
      chatType: "direct",
      channel: "discord",
      lastTo: "user:U1",
      deliveryContext: {
        channel: "discord",
        to: "user:U1",
        accountId: "work",
      },
    });
  });

  it("stores direct conversation identity in typed agent rows", () => {
    const stateDir = createTempDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };

    upsertSessionEntry({
      agentId: "ops",
      env,
      sessionKey: "discord:main",
      entry: {
        sessionId: "main-session",
        updatedAt: 200,
        chatType: "direct",
        deliveryContext: {
          channel: "discord",
          to: "user:U1",
          accountId: "work",
        },
        nativeChannelId: "D1",
        nativeDirectUserId: "U1",
      },
    });

    const database = openOpenClawAgentDatabase({ agentId: "ops", env });
    const db = getNodeSqliteKysely<SessionEntriesTestDatabase>(database.db);
    const session = executeSqliteQueryTakeFirstSync(
      database.db,
      db.selectFrom("sessions").selectAll().where("session_id", "=", "main-session"),
    );
    expect(session).toMatchObject({
      session_scope: "shared-main",
      account_id: "work",
    });
    expect(session?.primary_conversation_id).toMatch(/^conv_/);
    const conversation = executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("conversations")
        .selectAll()
        .where("conversation_id", "=", session?.primary_conversation_id ?? ""),
    );
    expect(conversation).toMatchObject({
      channel: "discord",
      account_id: "work",
      kind: "direct",
      peer_id: "U1",
      native_channel_id: "D1",
      native_direct_user_id: "U1",
    });
    expect(getSessionEntry({ agentId: "ops", env, sessionKey: "discord:main" })).toMatchObject({
      nativeChannelId: "D1",
      nativeDirectUserId: "U1",
    });
    expect(
      executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("session_conversations")
          .select(["session_id", "conversation_id", "role"])
          .where("session_id", "=", "main-session"),
      ).rows,
    ).toEqual([
      {
        session_id: "main-session",
        conversation_id: session?.primary_conversation_id,
        role: "participant",
      },
    ]);
  });

  it("rejects duplicate natural conversation identities", () => {
    const stateDir = createTempDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const database = openOpenClawAgentDatabase({ agentId: "ops", env });
    const db = getNodeSqliteKysely<SessionEntriesTestDatabase>(database.db);

    executeSqliteQuerySync(
      database.db,
      db.insertInto("conversations").values({
        conversation_id: "conv_a",
        channel: "discord",
        account_id: "work",
        kind: "direct",
        peer_id: "U1",
        parent_conversation_id: null,
        thread_id: null,
        native_channel_id: null,
        native_direct_user_id: "U1",
        label: null,
        metadata_json: null,
        created_at: 100,
        updated_at: 100,
      }),
    );

    expect(() =>
      executeSqliteQuerySync(
        database.db,
        db.insertInto("conversations").values({
          conversation_id: "conv_b",
          channel: "discord",
          account_id: "work",
          kind: "direct",
          peer_id: "U1",
          parent_conversation_id: null,
          thread_id: null,
          native_channel_id: "D1",
          native_direct_user_id: "U1",
          label: "Duplicate",
          metadata_json: null,
          created_at: 101,
          updated_at: 101,
        }),
      ),
    ).toThrow(/UNIQUE/);
  });

  it("links multiple direct peers to a shared main DM session", async () => {
    const stateDir = createTempDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    process.env.OPENCLAW_STATE_DIR = stateDir;

    await recordSessionMetaFromInbound({
      agentId: "ops",
      sessionKey: "discord:main",
      ctx: {
        Provider: "discord",
        ChatType: "direct",
        From: "discord:user:U1",
        To: "bot",
        OriginatingChannel: originatingChannel("discord"),
        OriginatingTo: "user:U1",
        AccountId: "work",
        NativeDirectUserId: "U1",
      },
    });
    await recordSessionMetaFromInbound({
      agentId: "ops",
      sessionKey: "discord:main",
      ctx: {
        Provider: "discord",
        ChatType: "direct",
        From: "discord:user:U2",
        To: "bot",
        OriginatingChannel: originatingChannel("discord"),
        OriginatingTo: "user:U2",
        AccountId: "work",
        NativeDirectUserId: "U2",
      },
    });

    const stored = getSessionEntry({ agentId: "ops", env, sessionKey: "discord:main" });
    expect(stored?.sessionId).toBeTruthy();

    const database = openOpenClawAgentDatabase({ agentId: "ops", env });
    const db = getNodeSqliteKysely<SessionEntriesTestDatabase>(database.db);
    const conversations = executeSqliteQuerySync(
      database.db,
      db.selectFrom("conversations").select(["kind", "peer_id"]).orderBy("peer_id", "asc"),
    ).rows;
    expect(conversations).toEqual([
      { kind: "direct", peer_id: "U1" },
      { kind: "direct", peer_id: "U2" },
    ]);
    const links = executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("session_conversations")
        .innerJoin(
          "conversations",
          "conversations.conversation_id",
          "session_conversations.conversation_id",
        )
        .select(["conversations.peer_id", "session_conversations.role"])
        .where("session_conversations.session_id", "=", stored?.sessionId ?? "")
        .orderBy("conversations.peer_id", "asc"),
    ).rows;
    expect(links).toEqual([
      { peer_id: "U1", role: "participant" },
      { peer_id: "U2", role: "participant" },
    ]);
    expect(
      readSqliteSessionDeliveryContext({
        agentId: "ops",
        env,
        sessionKey: "discord:main",
      }),
    ).toMatchObject({
      channel: "discord",
      to: "U2",
      accountId: "work",
    });
  });

  it("stores group conversation identity in typed agent rows", async () => {
    const stateDir = createTempDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    process.env.OPENCLAW_STATE_DIR = stateDir;

    await recordSessionMetaFromInbound({
      agentId: "ops",
      sessionKey: "slack:group:T1:C1",
      ctx: {
        Provider: "slack",
        ChatType: "channel",
        From: "slack:channel:C1",
        To: "bot",
        OriginatingChannel: originatingChannel("slack"),
        OriginatingTo: "channel:C1",
        AccountId: "workspace-a",
        GroupChannel: "#ops",
        GroupSpace: "T1",
        NativeChannelId: "C1",
      },
      groupResolution: {
        key: "slack:channel:c1",
        channel: "slack",
        id: "c1",
        chatType: "channel",
      },
    });

    const database = openOpenClawAgentDatabase({ agentId: "ops", env });
    const db = getNodeSqliteKysely<SessionEntriesTestDatabase>(database.db);
    const conversation = executeSqliteQueryTakeFirstSync(
      database.db,
      db.selectFrom("conversations").selectAll(),
    );
    expect(conversation).toMatchObject({
      channel: "slack",
      account_id: "workspace-a",
      kind: "channel",
      peer_id: "c1",
      native_channel_id: "C1",
    });
  });

  it("keeps one active route while preserving rotated session roots", () => {
    const stateDir = createTempDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };

    upsertSessionEntry({
      agentId: "ops",
      env,
      sessionKey: "discord:ops",
      entry: { sessionId: "first-session", updatedAt: 100 },
    });
    upsertSessionEntry({
      agentId: "ops",
      env,
      sessionKey: "discord:ops",
      entry: { sessionId: "second-session", updatedAt: 200 },
    });

    expect(loadSqliteSessionEntries({ agentId: "ops", env })).toEqual({
      "discord:ops": { sessionId: "second-session", updatedAt: 200 },
    });

    const database = openOpenClawAgentDatabase({ agentId: "ops", env });
    const db = getNodeSqliteKysely<SessionEntriesTestDatabase>(database.db);
    expect(
      executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("sessions")
          .select(["session_id", "session_key"])
          .orderBy("updated_at", "asc"),
      ).rows,
    ).toEqual([
      { session_id: "first-session", session_key: "discord:ops" },
      { session_id: "second-session", session_key: "discord:ops" },
    ]);
    expect(
      executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("session_routes")
          .select(["session_key", "session_id"])
          .orderBy("session_key", "asc"),
      ).rows,
    ).toEqual([{ session_key: "discord:ops", session_id: "second-session" }]);
    expect(
      executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("session_entries")
          .select(["session_id", "session_key"])
          .orderBy("updated_at", "asc"),
      ).rows,
    ).toEqual([
      { session_id: "first-session", session_key: "discord:ops" },
      { session_id: "second-session", session_key: "discord:ops" },
    ]);
  });

  it("updates one session entry without replacing the whole SQLite store", async () => {
    const stateDir = createTempDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    upsertSessionEntry({
      agentId: "ops",
      env,
      sessionKey: "discord:ops",
      entry: {
        sessionId: "ops-session",
        updatedAt: 100,
      },
    });
    upsertSessionEntry({
      agentId: "ops",
      env,
      sessionKey: "discord:other",
      entry: {
        sessionId: "other-session",
        updatedAt: 50,
      },
    });

    const updated = await patchSessionEntry({
      agentId: "ops",
      env,
      sessionKey: "discord:ops",
      update: async () => ({ modelOverride: "gpt-5.5", updatedAt: 200 }),
    });

    expect(updated?.modelOverride).toBe("gpt-5.5");
    expect(loadSqliteSessionEntries({ agentId: "ops", env })).toEqual({
      "discord:ops": expect.objectContaining({
        sessionId: "ops-session",
        modelOverride: "gpt-5.5",
      }),
      "discord:other": {
        sessionId: "other-session",
        updatedAt: 50,
      },
    });
  });

  it("exposes row-level session entry APIs by agent id", () => {
    const stateDir = createTempDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };

    upsertSessionEntry({
      agentId: "ops",
      env,
      sessionKey: "discord:ops",
      entry: {
        sessionId: "ops-session",
        updatedAt: 100,
      },
    });
    upsertSessionEntry({
      agentId: "ops",
      env,
      sessionKey: "discord:other",
      entry: {
        sessionId: "other-session",
        updatedAt: 50,
      },
    });

    expect(getSessionEntry({ agentId: "ops", env, sessionKey: "discord:ops" })).toMatchObject({
      sessionId: "ops-session",
    });
    expect(listSessionEntries({ agentId: "ops", env }).map((row) => row.sessionKey)).toEqual([
      "discord:ops",
      "discord:other",
    ]);
    expect(deleteSessionEntry({ agentId: "ops", env, sessionKey: "discord:ops" })).toBe(true);
    expect(getSessionEntry({ agentId: "ops", env, sessionKey: "discord:ops" })).toBeUndefined();
    expect(getSessionEntry({ agentId: "main", env, sessionKey: "discord:other" })).toBeUndefined();
  });

  it("deletes the canonical session root and cascades session-owned rows", () => {
    const stateDir = createTempDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    upsertSessionEntry({
      agentId: "ops",
      env,
      sessionKey: "discord:ops",
      entry: {
        sessionId: "ops-session",
        updatedAt: 100,
      },
    });
    appendSqliteSessionTranscriptEvent({
      agentId: "ops",
      env,
      sessionId: "ops-session",
      event: { type: "session", id: "ops-session" },
    });
    const database = openOpenClawAgentDatabase({ agentId: "ops", env });
    const db = getNodeSqliteKysely<SessionEntriesTestDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      db.insertInto("memory_index_sources").values({
        source_kind: "sessions",
        source_key: "session:ops-session",
        path: "transcript:ops:ops-session",
        session_id: "ops-session",
        hash: "hash",
        mtime: 100,
        size: 10,
      }),
    );
    executeSqliteQuerySync(
      database.db,
      db.insertInto("memory_index_chunks").values({
        id: "chunk-1",
        source_kind: "sessions",
        source_key: "session:ops-session",
        path: "transcript:ops:ops-session",
        session_id: "ops-session",
        start_line: 0,
        end_line: 1,
        hash: "hash",
        model: "test",
        text: "hello",
        embedding: new Uint8Array([0, 0, 0, 0]),
        embedding_dims: 1,
        updated_at: 100,
      }),
    );

    expect(
      hasSqliteSessionTranscriptEvents({ agentId: "ops", env, sessionId: "ops-session" }),
    ).toBe(true);
    expect(deleteSessionEntry({ agentId: "ops", env, sessionKey: "discord:ops" })).toBe(true);
    expect(getSessionEntry({ agentId: "ops", env, sessionKey: "discord:ops" })).toBeUndefined();
    expect(
      hasSqliteSessionTranscriptEvents({ agentId: "ops", env, sessionId: "ops-session" }),
    ).toBe(false);
    expect(
      executeSqliteQueryTakeFirstSync(
        database.db,
        db.selectFrom("sessions").select("session_id").where("session_id", "=", "ops-session"),
      ),
    ).toBeUndefined();
    expect(
      executeSqliteQueryTakeFirstSync(
        database.db,
        db
          .selectFrom("memory_index_sources")
          .select("source_key")
          .where("source_key", "=", "session:ops-session"),
      ),
    ).toBeUndefined();
    expect(
      executeSqliteQueryTakeFirstSync(
        database.db,
        db.selectFrom("memory_index_chunks").select("id").where("id", "=", "chunk-1"),
      ),
    ).toBeUndefined();
  });

  it("uses SQLite by default for canonical per-agent session rows", () => {
    const stateDir = createTempDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const entry: SessionEntry = {
      sessionId: "sqlite-default",
      updatedAt: 100,
    };

    upsertSessionEntry({ agentId: "ops", env, sessionKey: "discord:ops", entry });

    expect(loadSqliteSessionEntries({ agentId: "ops", env })).toEqual({
      "discord:ops": entry,
    });
  });
});
