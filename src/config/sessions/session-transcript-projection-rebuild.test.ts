import { describe, expect, it } from "vitest";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { prepareSessionTranscriptProjection } from "./session-transcript-projection-rebuild.js";

type SessionTranscriptProjectionSourceRow = { seq: number; event: unknown; createdAt: number };

const SESSION_ID = "projection-session";

function row(
  seq: number,
  event: Record<string, unknown>,
  createdAt = seq * 1_000,
): SessionTranscriptProjectionSourceRow {
  return { createdAt, event, seq };
}

function message(
  seq: number,
  id: string,
  parentId: string | null | undefined,
  role: string,
  content: unknown,
  overrides: Record<string, unknown> = {},
  createdAt?: number,
) {
  return row(
    seq,
    {
      type: "message",
      id,
      ...(parentId !== undefined ? { parentId } : {}),
      message: { role, content },
      ...overrides,
    },
    createdAt,
  );
}

const header = (version = 3) => row(0, { id: SESSION_ID, type: "session", version });

function projection(rows: SessionTranscriptProjectionSourceRow[]) {
  const db = openNodeSqliteDatabase(":memory:");
  try {
    db.exec(`CREATE TABLE session_windows (session_id TEXT PRIMARY KEY, transcript_updated_at INTEGER);
      CREATE TABLE transcript_rewrite_watermarks (session_id TEXT PRIMARY KEY, generation TEXT);
      CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, event_json TEXT, created_at INTEGER,
        event_zstd BLOB, event_utf8_bytes INTEGER, navigation_json TEXT,
        PRIMARY KEY (session_id, seq));`);
    db.prepare("INSERT INTO session_windows VALUES (?, ?)").run(SESSION_ID, 42);
    db.prepare("INSERT INTO transcript_rewrite_watermarks VALUES (?, ?)").run(
      SESSION_ID,
      "projection-generation",
    );
    const insert = db.prepare(
      "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, ?, ?, ?)",
    );
    for (const sourceRow of rows) {
      insert.run(SESSION_ID, sourceRow.seq, JSON.stringify(sourceRow.event), sourceRow.createdAt);
    }
    return prepareSessionTranscriptProjection(db, SESSION_ID)!;
  } finally {
    db.close();
  }
}

describe("canonical SQLite session transcript projection", () => {
  it("projects one deterministic active branch", () => {
    const result = projection([
      header(),
      message(1, "root", null, "user", "root text"),
      message(2, "abandoned", "root", "assistant", "abandoned text"),
      message(3, "active", "root", "assistant", "active text"),
    ]);

    expect(result).toMatchObject({
      activeEventCount: 2,
      activeMessageCount: 2,
      leafEventId: "active",
      sessionId: SESSION_ID,
      sourceIndexedSeq: 3,
      sourceTranscriptUpdatedAt: 42,
    });
    expect(result.activeRows).toEqual([
      { activePosition: 0, contextEligible: 1, eventSeq: 1, messagePosition: 0 },
      { activePosition: 1, contextEligible: 1, eventSeq: 3, messagePosition: 1 },
    ]);
    expect(result.ftsRows).toEqual([
      { messageId: "root", role: "user", text: "root text", timestamp: 1_000 },
      { messageId: "active", role: "assistant", text: "active text", timestamp: 3_000 },
    ]);
  });

  it("keeps persisted row timestamps for timestamp-less and invalid-timestamp messages", () => {
    const result = projection([
      header(),
      message(
        1,
        "old-user",
        null,
        "user",
        [{ text: "old content", type: "text" }],
        {},
        1_700_000_000_000,
      ),
      message(
        2,
        "invalid-timestamp",
        "old-user",
        "assistant",
        "still old",
        { timestamp: "not a date" },
        1_700_000_001_000,
      ),
    ]);

    expect(result.ftsRows.map(({ messageId, timestamp }) => ({ messageId, timestamp }))).toEqual([
      { messageId: "old-user", timestamp: 1_700_000_000_000 },
      { messageId: "invalid-timestamp", timestamp: 1_700_000_001_000 },
    ]);
  });

  it("skips malformed content-block types without dropping neighboring text", () => {
    const result = projection([
      header(),
      message(1, "mixed-content", null, "assistant", [
        { text: "ignored", type: { toString: null } },
        { text: "kept", type: "text" },
      ]),
    ]);

    expect(result.ftsRows).toEqual([
      { messageId: "mixed-content", role: "assistant", text: "kept", timestamp: 1_000 },
    ]);
  });

  it("respects a leaf-control rewind without indexing the abandoned continuation", () => {
    const result = projection([
      header(),
      message(1, "root", null, "user", "keep"),
      message(2, "abandoned", "root", "assistant", "remove"),
      row(3, {
        appendParentId: "root",
        id: "rewind",
        parentId: "abandoned",
        targetId: "root",
        type: "leaf",
      }),
    ]);

    expect(result.leafEventId).toBe("root");
    expect(result.activeRows).toEqual([
      { activePosition: 0, contextEligible: 1, eventSeq: 1, messagePosition: 0 },
    ]);
    expect(result.ftsRows.map((entry) => entry.messageId)).toEqual(["root"]);
  });

  it("keeps legacy flat-message ordering and searchable identities", () => {
    const result = projection([
      header(1),
      message(1, "legacy-user", undefined, "user", "first"),
      message(2, "legacy-assistant", undefined, "assistant", "second"),
    ]);

    expect(result.activeRows).toEqual([
      { activePosition: 0, contextEligible: 1, eventSeq: 1, messagePosition: 0 },
      { activePosition: 1, contextEligible: 1, eventSeq: 2, messagePosition: 1 },
    ]);
    expect(result.ftsRows.map((entry) => entry.messageId)).toEqual([
      "legacy-user",
      "legacy-assistant",
    ]);
    expect(result.sourceIndexedSeq).toBe(2);
  });
});
