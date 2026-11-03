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

it("verifies Doctor-normalized inbound headings without rewriting history", async () => {
  await withOpenClawTestState({ label: "verify-inbound-headings" }, async (state) => {
    const sessionId = "inbound-headings";
    const header = { type: "session", id: sessionId, version: 3 };
    const headingMessage = (normalized: boolean, suffix = "") => ({
      type: "message",
      id: "m1",
      parentId: null,
      message: {
        role: "user",
        content:
          (normalized
            ? 'Conversation info: ⟦openclaw:ctx⟧\n```json\n{"chat_type":"direct"}\n```\nQuestion'
            : 'Conversation info (untrusted metadata):\n```json\n{"chat_type":"direct"}\n```\nQuestion') +
          suffix,
      },
    });
    const write = (event: unknown) =>
      state.writeText("source.jsonl", `${JSON.stringify(header)}\n${JSON.stringify(event)}\n`);
    // SQLite holds the Doctor-normalized heading; the retained JSONL keeps the legacy label.
    const filename = await write(headingMessage(true));
    const scope = {
      agentId: "main",
      env: state.env,
      sessionId,
      sessionKey: "agent:main:main",
      storePath: path.join(state.sessionsDir(), "sessions.json"),
    };
    await importSqliteSessionRows({
      ...scope,
      entry: { sessionId, updatedAt: 1 },
      readTranscriptEvents: createTranscriptEventReader(filename, sessionId),
    });
    const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    const source = { path: filename, sessionId, originalPath: filename };
    const stored = loadTranscriptEventsSync(scope);
    await write(headingMessage(false));
    const original = fs.readFileSync(filename, "utf8");
    for (const mode of ["ordered", "contained", "appendable"] as const) {
      expect(verifyTranscriptEvents(database.db, source, mode)).toEqual({
        events: 2,
        missingEvents: 0,
        sqliteEvents: 2,
      });
    }
    expect(fs.readFileSync(filename, "utf8")).toBe(original);

    await write(headingMessage(false, "!"));
    expect(verifyTranscriptEvents(database.db, source, "ordered")).toBeUndefined();
    expect(verifyTranscriptEvents(database.db, source, "contained")).toBeUndefined();
    expect(() => verifyTranscriptEvents(database.db, source, "appendable")).toThrow(
      "Legacy event m1 conflicts with the SQLite event of the same identity",
    );
    expect(loadTranscriptEventsSync(scope)).toEqual(stored);
  });
});
