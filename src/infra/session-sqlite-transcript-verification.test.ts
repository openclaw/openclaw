import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { importSqliteSessionRows } from "../config/sessions/session-accessor.sqlite-import.test-support.js";
import { loadTranscriptEventsSync } from "../config/sessions/session-accessor.sqlite-read.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createTranscriptEventReader } from "./session-sqlite-migration-readers.js";
import { verifyTranscriptEvents } from "./session-sqlite-transcript-verification.js";

it("verifies legacy media without accepting changed events or rewriting history", async () => {
  await withOpenClawTestState({ label: "verify-legacy-media" }, async (state) => {
    const sessionId = "legacy-media";
    const header = { type: "session", id: sessionId, version: 3 };
    const legacyMediaMessage = {
      type: "message",
      id: "m1",
      parentId: null,
      message: {
        role: "user",
        content: "see attached",
        MediaPath: "/tmp/photo.png",
        MediaPaths: ["/tmp/photo.png", "/tmp/document.pdf"],
        MediaType: "image/png",
        MediaTypes: ["image/png", "application/pdf"],
        __openclaw: { retained: "message metadata" },
      },
    };
    const filename = await state.writeText(
      "legacy.jsonl",
      `${JSON.stringify(header)}\n${JSON.stringify(legacyMediaMessage)}\n`,
    );
    const scope = {
      agentId: "main",
      env: state.env,
      sessionId,
      sessionKey: `agent:main:${sessionId}`,
      storePath: path.join(state.sessionsDir(), "sessions.json"),
    };
    await importSqliteSessionRows({
      ...scope,
      entry: { sessionId, updatedAt: 1 },
      readTranscriptEvents: createTranscriptEventReader(filename, sessionId),
    });
    const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    const source = { path: filename, sessionId, originalPath: filename };
    const original = fs.readFileSync(filename, "utf8");
    const stored = loadTranscriptEventsSync(scope);
    expect(stored[1]).toMatchObject({
      id: "m1",
      message: {
        role: "user",
        content: "see attached",
        __openclaw: {
          retained: "message metadata",
          media: [
            { path: "/tmp/photo.png", contentType: "image/png" },
            { path: "/tmp/document.pdf", contentType: "application/pdf" },
          ],
        },
      },
    });
    for (const mode of ["ordered", "contained", "appendable"] as const) {
      expect(verifyTranscriptEvents(database.db, source, mode)).toEqual({
        events: 2,
        missingEvents: 0,
        sqliteEvents: 2,
      });
    }
    expect(fs.readFileSync(filename, "utf8")).toBe(original);

    for (const changed of [
      { ...legacyMediaMessage, message: { ...legacyMediaMessage.message, content: "changed" } },
      {
        ...legacyMediaMessage,
        message: {
          ...legacyMediaMessage.message,
          MediaPath: "/tmp/other.png",
          MediaPaths: ["/tmp/other.png", "/tmp/document.pdf"],
        },
      },
      {
        ...legacyMediaMessage,
        message: { ...legacyMediaMessage.message, __openclaw: { retained: "changed metadata" } },
      },
    ]) {
      await state.writeText(
        "legacy.jsonl",
        `${JSON.stringify(header)}\n${JSON.stringify(changed)}\n`,
      );
      expect(verifyTranscriptEvents(database.db, source, "ordered")).toBeUndefined();
      expect(verifyTranscriptEvents(database.db, source, "contained")).toBeUndefined();
      expect(() => verifyTranscriptEvents(database.db, source, "appendable")).toThrow(
        "Legacy event m1 conflicts with the SQLite event of the same identity",
      );
    }
    expect(loadTranscriptEventsSync(scope)).toEqual(stored);
  });
});

it("treats importer-normalized Codex metadata as the same event on a retry", async () => {
  await withOpenClawTestState({ label: "verify-legacy-codex-retry" }, async (state) => {
    const sessionId = "legacy-codex";
    const header = {
      type: "session",
      id: sessionId,
      version: 3,
      timestamp: "2026-05-26T00:00:00.000Z",
    };
    const legacy = {
      type: "message",
      id: "m1",
      parentId: null,
      message: {
        role: "assistant",
        content: "stored once",
        provider: "openai-codex",
        api: "openai-codex-responses",
      },
    };
    const filename = await state.writeText(
      "legacy.jsonl",
      `${JSON.stringify(header)}\n${JSON.stringify(legacy)}\n`,
    );
    const scope = {
      agentId: "main",
      env: state.env,
      sessionId,
      sessionKey: `agent:main:${sessionId}`,
      storePath: path.join(state.sessionsDir(), "sessions.json"),
    };
    await importSqliteSessionRows({
      ...scope,
      entry: { sessionId, updatedAt: 1 },
      repairLegacyTranscript: true,
      readTranscriptEvents: createTranscriptEventReader(filename, sessionId),
    });
    const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    const source = { path: filename, sessionId, originalPath: filename };
    expect(loadTranscriptEventsSync(scope)[1]).toMatchObject({
      id: "m1",
      message: {
        provider: "openai",
        api: "openai-chatgpt-responses",
      },
    });
    for (const mode of ["contained", "appendable"] as const) {
      expect(verifyTranscriptEvents(database.db, source, mode)).toEqual({
        events: 2,
        missingEvents: 0,
        sqliteEvents: 2,
      });
    }
    // Receipt adoption still refuses a transcript whose stored bytes were rewritten.
    expect(verifyTranscriptEvents(database.db, source, "ordered")).toBeUndefined();

    await state.writeText(
      "legacy.jsonl",
      `${JSON.stringify(header)}\n${JSON.stringify({
        ...legacy,
        message: { ...legacy.message, content: "changed after import" },
      })}\n`,
    );
    expect(verifyTranscriptEvents(database.db, source, "contained")).toBeUndefined();
    expect(() => verifyTranscriptEvents(database.db, source, "appendable")).toThrow(
      "Legacy event m1 conflicts with the SQLite event of the same identity",
    );
  });
});

it("accepts a timestamp-only extra session header and refuses a divergent one", async () => {
  await withOpenClawTestState({ label: "verify-duplicate-session-header-retry" }, async (state) => {
    const sessionId = "legacy-header";
    const header = {
      type: "session",
      id: sessionId,
      version: 3,
      timestamp: "2026-05-26T00:00:05.000Z",
      cwd: "/workspace",
    };
    const message = {
      type: "message",
      id: "m1",
      parentId: null,
      message: { role: "user", content: "kept" },
    };
    const earlierHeader = { ...header, timestamp: "2026-05-26T00:00:01.000Z" };
    const filename = await state.writeText(
      "legacy.jsonl",
      `${JSON.stringify(header)}\n${JSON.stringify(message)}\n${JSON.stringify(earlierHeader)}\n`,
    );
    const scope = {
      agentId: "main",
      env: state.env,
      sessionId,
      sessionKey: `agent:main:${sessionId}`,
      storePath: path.join(state.sessionsDir(), "sessions.json"),
    };
    await importSqliteSessionRows({
      ...scope,
      entry: { sessionId, updatedAt: 1 },
      repairLegacyTranscript: true,
      readTranscriptEvents: createTranscriptEventReader(filename, sessionId),
    });
    const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    const source = { path: filename, sessionId, originalPath: filename };
    expect(verifyTranscriptEvents(database.db, source, "appendable")).toEqual({
      events: 2,
      missingEvents: 0,
      sqliteEvents: 2,
    });

    await state.writeText(
      "legacy.jsonl",
      `${JSON.stringify(header)}\n${JSON.stringify(message)}\n${JSON.stringify({
        ...earlierHeader,
        cwd: "/other",
      })}\n`,
    );
    expect(() => verifyTranscriptEvents(database.db, source, "appendable")).toThrow(
      `Legacy event ${sessionId} conflicts with the SQLite event of the same identity`,
    );
  });
});
