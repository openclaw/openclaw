import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  appendSqliteSessionTranscriptEvent,
  exportSqliteSessionTranscriptJsonl,
  importJsonlTranscriptToSqlite,
  loadSqliteSessionTranscriptEvents,
  writeSqliteSessionTranscriptJsonl,
} from "./transcript-store.sqlite.js";

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sqlite-transcript-"));
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("SQLite session transcript store", () => {
  it("appends transcript events with stable per-session sequence numbers", () => {
    const stateDir = createTempDir();
    const transcriptPath = path.join(stateDir, "session.jsonl");

    expect(
      appendSqliteSessionTranscriptEvent({
        env: { OPENCLAW_STATE_DIR: stateDir },
        agentId: "Main",
        sessionId: "session-1",
        transcriptPath,
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

  it("imports and exports JSONL transcript compatibility files", async () => {
    const stateDir = createTempDir();
    const sourcePath = path.join(stateDir, "source.jsonl");
    const exportedPath = path.join(stateDir, "exported.jsonl");
    fs.writeFileSync(
      sourcePath,
      [
        JSON.stringify({ type: "session", id: "session-1" }),
        JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: "hi" } }),
        "",
      ].join("\n"),
      { mode: 0o600 },
    );

    expect(
      importJsonlTranscriptToSqlite({
        env: { OPENCLAW_STATE_DIR: stateDir },
        agentId: "main",
        sessionId: "session-1",
        transcriptPath: sourcePath,
        now: () => 300,
      }),
    ).toEqual({ imported: 2, transcriptPath: sourcePath });

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
    await expect(
      writeSqliteSessionTranscriptJsonl({
        env: { OPENCLAW_STATE_DIR: stateDir },
        agentId: "main",
        sessionId: "session-1",
        transcriptPath: exportedPath,
      }),
    ).resolves.toEqual({ exported: 2, transcriptPath: exportedPath });
    expect(fs.readFileSync(exportedPath, "utf-8")).toBe(
      exportSqliteSessionTranscriptJsonl({
        env: { OPENCLAW_STATE_DIR: stateDir },
        agentId: "main",
        sessionId: "session-1",
      }),
    );
  });
});
