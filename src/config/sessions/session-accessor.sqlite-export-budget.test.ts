import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Message } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { replaceSessionEntry } from "./session-accessor.js";
import {
  loadTranscriptEventsSync,
  readTranscriptStatsSync,
} from "./session-accessor.sqlite-read.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.js";

vi.mock("../config.js", async () => ({
  ...(await vi.importActual<typeof import("../config.js")>("../config.js")),
  getRuntimeConfig: vi.fn().mockReturnValue({}),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("SQLite transcript reader byte budget", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = tempDirs.make("openclaw-transcript-byte-");
    storePath = path.join(tempDir, "sessions.json");
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  function userMessage(content: string): Message {
    return { role: "user", content, timestamp: 1 };
  }

  it("counts JSONL row separators in the transcript byte budget", async () => {
    const sessionId = "session-transcript-separator";
    const sessionKey = "agent:main:session-transcript-separator";
    await replaceTranscriptEvents({ agentId: "main", sessionId, sessionKey, storePath }, [
      {
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: "2026-04-01T05:46:39.000Z",
        cwd: tempDir,
      },
      {
        type: "message",
        id: "entry-separator-0",
        parentId: null,
        timestamp: "2026-04-01T05:46:40.000Z",
        message: userMessage("separator-row-0"),
      },
      {
        type: "message",
        id: "entry-separator-1",
        parentId: null,
        timestamp: "2026-04-01T05:46:41.000Z",
        message: userMessage("separator-row-1"),
      },
    ]);
    const stats = readTranscriptStatsSync({
      agentId: "main",
      sessionId,
      sessionKey,
      storePath,
    });
    expect(() =>
      loadTranscriptEventsSync({
        agentId: "main",
        sessionId,
        sessionKey,
        storePath,
        maxEventBytes: stats.sizeBytes - 1,
      }),
    ).toThrow(/transcript store is too large to export/u);
    expect(
      loadTranscriptEventsSync({
        agentId: "main",
        sessionId,
        sessionKey,
        storePath,
        maxEventBytes: stats.sizeBytes,
      }).length,
    ).toBe(3);
  });

  // OCTET_LENGTH measures the database encoding, so a UTF-16 store would otherwise
  // reject an ASCII transcript near half the documented UTF-8 cap and undercount
  // CJK-heavy text. Admission must measure the UTF-8 byte budget across encodings.
  it.each([
    { encoding: "UTF-8" as const, payload: "a".repeat(200), label: "ascii" },
    { encoding: "UTF-16le" as const, payload: "a".repeat(200), label: "ascii" },
    { encoding: "UTF-16be" as const, payload: "a".repeat(200), label: "ascii" },
    { encoding: "UTF-8" as const, payload: "日本語🦞".repeat(40), label: "cjk" },
    { encoding: "UTF-16le" as const, payload: "日本語🦞".repeat(40), label: "cjk" },
    { encoding: "UTF-16be" as const, payload: "日本語🦞".repeat(40), label: "cjk" },
  ])(
    "measures the UTF-8 byte budget in $encoding for $label payloads",
    async ({ encoding, payload, label }) => {
      const sessionId = `session-transcript-${encoding}-${label}`;
      const sessionKey = `agent:main:${sessionId}`;
      if (encoding !== "UTF-8") {
        storePath = path.join(tempDir, `${encoding}.sqlite`);
        const seed = new DatabaseSync(storePath);
        try {
          seed.exec(
            `PRAGMA encoding = '${encoding}'; CREATE TABLE encoding_seed (id INTEGER); DROP TABLE encoding_seed;`,
          );
        } finally {
          seed.close();
        }
        await replaceSessionEntry(
          { agentId: "main", sessionKey, storePath },
          { sessionId, updatedAt: 10 },
        );
      }
      const events = [
        {
          type: "session",
          version: 3,
          id: sessionId,
          timestamp: "2026-04-01T05:46:39.000Z",
          cwd: tempDir,
        },
        {
          type: "message",
          id: "entry-utf16-0",
          parentId: null,
          timestamp: "2026-04-01T05:46:40.000Z",
          message: userMessage(payload),
        },
        {
          type: "message",
          id: "entry-utf16-1",
          parentId: null,
          timestamp: "2026-04-01T05:46:41.000Z",
          message: userMessage(payload),
        },
      ];
      await replaceTranscriptEvents({ agentId: "main", sessionId, sessionKey, storePath }, events);
      const jsonlSize = events.reduce(
        (total, event, index) =>
          total + Buffer.byteLength(JSON.stringify(event), "utf8") + (index > 0 ? 1 : 0),
        0,
      );
      // Budget equals the true UTF-8 size: admission must accept it in every encoding.
      expect(
        loadTranscriptEventsSync({
          agentId: "main",
          sessionId,
          sessionKey,
          storePath,
          maxEventBytes: jsonlSize,
        }).length,
      ).toBe(events.length);
      // One byte below the UTF-8 size must reject in every encoding.
      expect(() =>
        loadTranscriptEventsSync({
          agentId: "main",
          sessionId,
          sessionKey,
          storePath,
          maxEventBytes: jsonlSize - 1,
        }),
      ).toThrow(/transcript store is too large to export/u);
      if (encoding !== "UTF-8") {
        // Exact UTF-8 metadata must not inherit the legacy identities' native-byte conversion.
        const { db } = openOpenClawAgentDatabase({ agentId: "main", path: storePath });
        db.prepare(
          "UPDATE transcript_events SET event_utf8_bytes = ? WHERE session_id = ? AND seq = 2",
        ).run(Buffer.byteLength(JSON.stringify(events[2]), "utf8"), sessionId);
        const mixed = { agentId: "main", sessionId, sessionKey, storePath };
        expect(loadTranscriptEventsSync({ ...mixed, maxEventBytes: jsonlSize })).toEqual(events);
        expect(() => loadTranscriptEventsSync({ ...mixed, maxEventBytes: jsonlSize - 1 })).toThrow(
          /transcript store is too large to export/u,
        );
      }
    },
  );
});
