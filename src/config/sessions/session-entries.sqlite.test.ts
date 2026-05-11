import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
import { loadSqliteSessionEntries } from "./session-entries.sqlite.js";
import {
  deleteSessionEntry,
  getSessionEntry,
  listSessionEntries,
  patchSessionEntry,
  upsertSessionEntry,
} from "./store.js";
import {
  appendSqliteSessionTranscriptEvent,
  hasSqliteSessionTranscriptEvents,
} from "./transcript-store.sqlite.js";
import type { SessionEntry } from "./types.js";

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;
type SessionEntriesTestDatabase = Pick<OpenClawAgentKyselyDatabase, "sessions" | "session_entries">;

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sqlite-session-entries-"));
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

  it("allows one durable route key to rotate across session ids", () => {
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

    expect(
      hasSqliteSessionTranscriptEvents({ agentId: "ops", env, sessionId: "ops-session" }),
    ).toBe(true);
    expect(deleteSessionEntry({ agentId: "ops", env, sessionKey: "discord:ops" })).toBe(true);
    expect(getSessionEntry({ agentId: "ops", env, sessionKey: "discord:ops" })).toBeUndefined();
    expect(
      hasSqliteSessionTranscriptEvents({ agentId: "ops", env, sessionId: "ops-session" }),
    ).toBe(false);

    const database = openOpenClawAgentDatabase({ agentId: "ops", env });
    const db = getNodeSqliteKysely<SessionEntriesTestDatabase>(database.db);
    expect(
      executeSqliteQueryTakeFirstSync(
        database.db,
        db.selectFrom("sessions").select("session_id").where("session_id", "=", "ops-session"),
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
