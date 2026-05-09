import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  appendSqliteSessionTranscriptEvent,
  appendSqliteSessionTranscriptMessage,
  deleteSqliteSessionTranscript,
  exportSqliteSessionTranscriptJsonl,
  getSqliteSessionTranscriptFrontier,
  listSqliteSessionTranscripts,
  loadSqliteSessionTranscriptDelta,
  loadSqliteSessionTranscriptEvents,
  recordSqliteSessionTranscriptSnapshot,
  replaceSqliteSessionTranscriptEvents,
} from "./transcript-store.sqlite.js";

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sqlite-transcript-"));
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("SQLite session transcript store", () => {
  it("appends transcript events with stable per-session sequence numbers", () => {
    const stateDir = createTempDir();

    expect(
      appendSqliteSessionTranscriptEvent({
        env: { OPENCLAW_STATE_DIR: stateDir },
        agentId: "Main",
        sessionId: "session-1",
        event: { type: "session", id: "session-1" },
        now: () => 100,
      }),
    ).toEqual({ seq: 0 });
    expect(
      appendSqliteSessionTranscriptEvent({
        env: { OPENCLAW_STATE_DIR: stateDir },
        agentId: "Main",
        sessionId: "session-1",
        event: { type: "message", id: "m1", message: { role: "assistant", content: "ok" } },
        now: () => 200,
      }),
    ).toEqual({ seq: 1 });

    expect(
      loadSqliteSessionTranscriptEvents({
        env: { OPENCLAW_STATE_DIR: stateDir },
        agentId: "main",
        sessionId: "session-1",
      }),
    ).toEqual([
      { seq: 0, createdAt: 100, event: { type: "session", id: "session-1" } },
      {
        seq: 1,
        createdAt: 200,
        event: { type: "message", id: "m1", message: { role: "assistant", content: "ok" } },
      },
    ]);
  });

  it("dedupes message appends by SQLite idempotency identity", () => {
    const stateDir = createTempDir();
    const options = {
      env: { OPENCLAW_STATE_DIR: stateDir },
      agentId: "main",
      sessionId: "session-1",
      sessionVersion: 1,
      message: { role: "user", content: "hi", idempotencyKey: "idem-1" },
      now: () => 100,
    };

    const first = appendSqliteSessionTranscriptMessage(options);
    const second = appendSqliteSessionTranscriptMessage(options);

    expect(second.messageId).toBe(first.messageId);
    expect(
      loadSqliteSessionTranscriptEvents({
        env: { OPENCLAW_STATE_DIR: stateDir },
        agentId: "main",
        sessionId: "session-1",
      }).map((entry) => entry.event),
    ).toEqual([
      expect.objectContaining({ type: "session", id: "session-1" }),
      expect.objectContaining({
        type: "message",
        id: first.messageId,
        parentId: null,
        message: { role: "user", content: "hi", idempotencyKey: "idem-1" },
      }),
    ]);

    const database = openOpenClawAgentDatabase({
      env: { OPENCLAW_STATE_DIR: stateDir },
      agentId: "main",
    });
    const identityRows = database.db
      .prepare(
        "SELECT message_idempotency_key FROM transcript_event_identities WHERE session_id = ? AND message_idempotency_key IS NOT NULL",
      )
      .all("session-1");
    expect(identityRows).toEqual([{ message_idempotency_key: "idem-1" }]);
  });

  it("links transcript message parents inside the SQLite append transaction", () => {
    const stateDir = createTempDir();
    const first = appendSqliteSessionTranscriptMessage({
      env: { OPENCLAW_STATE_DIR: stateDir },
      agentId: "main",
      sessionId: "session-1",
      sessionVersion: 1,
      message: { role: "user", content: "one", idempotencyKey: "idem-1" },
      now: () => 100,
    });
    const second = appendSqliteSessionTranscriptMessage({
      env: { OPENCLAW_STATE_DIR: stateDir },
      agentId: "main",
      sessionId: "session-1",
      sessionVersion: 1,
      message: { role: "assistant", content: "two", idempotencyKey: "idem-2" },
      now: () => 200,
    });

    const events = loadSqliteSessionTranscriptEvents({
      env: { OPENCLAW_STATE_DIR: stateDir },
      agentId: "main",
      sessionId: "session-1",
    }).map((entry) => entry.event as { id?: string; parentId?: string | null });

    expect(events).toEqual([
      expect.objectContaining({ id: "session-1" }),
      expect.objectContaining({ id: first.messageId, parentId: null }),
      expect.objectContaining({ id: second.messageId, parentId: first.messageId }),
    ]);
  });

  it("keeps transcript events isolated by agent id", () => {
    const stateDir = createTempDir();

    appendSqliteSessionTranscriptEvent({
      env: { OPENCLAW_STATE_DIR: stateDir },
      agentId: "main",
      sessionId: "shared-session",
      event: { type: "message", id: "main" },
    });
    appendSqliteSessionTranscriptEvent({
      env: { OPENCLAW_STATE_DIR: stateDir },
      agentId: "ops",
      sessionId: "shared-session",
      event: { type: "message", id: "ops" },
    });

    expect(
      loadSqliteSessionTranscriptEvents({
        env: { OPENCLAW_STATE_DIR: stateDir },
        agentId: "main",
        sessionId: "shared-session",
      }).map((entry) => entry.event),
    ).toEqual([{ type: "message", id: "main" }]);
  });

  it("lists SQLite transcript scopes", () => {
    const stateDir = createTempDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };

    appendSqliteSessionTranscriptEvent({
      env,
      agentId: "main",
      sessionId: "session-1",
      event: { type: "message", id: "older" },
      now: () => 100,
    });
    appendSqliteSessionTranscriptEvent({
      env,
      agentId: "main",
      sessionId: "session-1",
      event: { type: "message", id: "newer" },
      now: () => 200,
    });

    expect(listSqliteSessionTranscripts({ env, agentId: "main" })).toEqual([
      {
        agentId: "main",
        sessionId: "session-1",
        updatedAt: 200,
        eventCount: 2,
      },
    ]);
  });

  it("deletes transcript snapshots with the transcript", () => {
    const stateDir = createTempDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };

    appendSqliteSessionTranscriptEvent({
      env,
      agentId: "main",
      sessionId: "session-1",
      event: { type: "session", id: "session-1" },
    });
    recordSqliteSessionTranscriptSnapshot({
      env,
      agentId: "main",
      sessionId: "session-1",
      snapshotId: "snapshot-1",
      reason: "compaction",
      eventCount: 1,
    });

    expect(deleteSqliteSessionTranscript({ env, agentId: "main", sessionId: "session-1" })).toBe(
      true,
    );

    const agentDatabase = openOpenClawAgentDatabase({ env, agentId: "main" });
    expect(
      agentDatabase.db.prepare("SELECT COUNT(*) AS count FROM transcript_snapshots").get(),
    ).toEqual({ count: 0 });
  });

  it("renders JSONL from SQLite for explicit transcript export", () => {
    const stateDir = createTempDir();

    replaceSqliteSessionTranscriptEvents({
      env: { OPENCLAW_STATE_DIR: stateDir },
      agentId: "main",
      sessionId: "session-1",
      events: [
        { type: "session", id: "session-1" },
        { type: "message", id: "m1", message: { role: "user", content: "hi" } },
      ],
      now: () => 300,
    });

    expect(
      exportSqliteSessionTranscriptJsonl({
        env: { OPENCLAW_STATE_DIR: stateDir },
        agentId: "main",
        sessionId: "session-1",
      }),
    ).toBe(
      `${JSON.stringify({ type: "session", id: "session-1" })}\n${JSON.stringify({
        type: "message",
        id: "m1",
        message: { role: "user", content: "hi" },
      })}\n`,
    );
  });

  it("returns frontier metadata for a populated transcript", () => {
    const stateDir = createTempDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };

    replaceSqliteSessionTranscriptEvents({
      env,
      agentId: "main",
      sessionId: "session-1",
      events: [
        { type: "session", id: "session-1" },
        { type: "message", id: "m1", message: { role: "user", content: "hi" } },
      ],
      now: () => 300,
    });

    expect(
      getSqliteSessionTranscriptFrontier({ env, agentId: "main", sessionId: "session-1" }),
    ).toEqual({
      sessionId: "session-1",
      updatedAt: 300,
      eventCount: 2,
      lastSeq: 1,
      baseCreatedAt: 300,
    });
  });

  it("returns append delta when the transcript only grows", () => {
    const stateDir = createTempDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };

    replaceSqliteSessionTranscriptEvents({
      env,
      agentId: "main",
      sessionId: "session-1",
      events: [{ type: "session", id: "session-1" }],
      now: () => 100,
    });
    replaceSqliteSessionTranscriptEvents({
      env,
      agentId: "main",
      sessionId: "session-1",
      events: [
        { type: "session", id: "session-1" },
        { type: "message", id: "m1", message: { role: "assistant", content: "ok" } },
      ],
      now: () => 100,
    });

    expect(
      loadSqliteSessionTranscriptDelta({
        env,
        agentId: "main",
        sessionId: "session-1",
        cursor: {
          eventCount: 1,
          lastSeq: 0,
          baseCreatedAt: 100,
        },
      }),
    ).toMatchObject({
      mode: "append",
      frontier: {
        sessionId: "session-1",
        updatedAt: 100,
        eventCount: 2,
        lastSeq: 1,
        baseCreatedAt: 100,
      },
      events: [{ seq: 1, event: { type: "message", id: "m1" } }],
    });
  });

  it("returns reset delta after replace rewrites the same session", () => {
    const stateDir = createTempDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };

    replaceSqliteSessionTranscriptEvents({
      env,
      agentId: "main",
      sessionId: "session-1",
      events: [{ type: "session", id: "session-1" }],
      now: () => 100,
    });
    replaceSqliteSessionTranscriptEvents({
      env,
      agentId: "main",
      sessionId: "session-1",
      events: [
        { type: "session", id: "session-1" },
        { type: "message", id: "m2", message: { role: "assistant", content: "rewritten" } },
      ],
      now: () => 200,
    });

    expect(
      loadSqliteSessionTranscriptDelta({
        env,
        agentId: "main",
        sessionId: "session-1",
        cursor: {
          eventCount: 1,
          lastSeq: 0,
          baseCreatedAt: 100,
        },
      }),
    ).toMatchObject({
      mode: "reset",
      frontier: {
        sessionId: "session-1",
        updatedAt: 200,
        eventCount: 2,
        lastSeq: 1,
        baseCreatedAt: 200,
      },
      events: [{ seq: 0 }, { seq: 1, event: { type: "message", id: "m2" } }],
    });
  });

  it("returns missing when a previously cursored transcript is deleted", () => {
    const stateDir = createTempDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };

    replaceSqliteSessionTranscriptEvents({
      env,
      agentId: "main",
      sessionId: "session-1",
      events: [{ type: "session", id: "session-1" }],
      now: () => 100,
    });
    expect(deleteSqliteSessionTranscript({ env, agentId: "main", sessionId: "session-1" })).toBe(
      true,
    );

    expect(
      loadSqliteSessionTranscriptDelta({
        env,
        agentId: "main",
        sessionId: "session-1",
        cursor: {
          eventCount: 1,
          lastSeq: 0,
          baseCreatedAt: 100,
        },
      }),
    ).toEqual({
      mode: "missing",
      frontier: null,
      events: [],
    });
  });
});
