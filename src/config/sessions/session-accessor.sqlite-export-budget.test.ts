import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, expect, it, vi } from "vitest";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { replaceSessionEntry } from "./session-accessor.js";
import { loadTranscriptEventsSync } from "./session-accessor.sqlite-read.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";

vi.mock("../config.js", async () => ({
  ...(await vi.importActual<typeof import("../config.js")>("../config.js")),
  getRuntimeConfig: vi.fn().mockReturnValue({}),
}));

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-transcript-byte-");

// OCTET_LENGTH measures the database encoding, so a UTF-16 store would otherwise
// reject an ASCII transcript near half the documented UTF-8 cap and undercount
// CJK-heavy text. Admission must measure the UTF-8 byte budget across encodings.
it.each([
  { encoding: "UTF-16le" as const, payload: "a".repeat(200), label: "ascii" },
  { encoding: "UTF-8" as const, payload: "日本語🦞".repeat(40), label: "cjk" },
])(
  "measures the UTF-8 byte budget in $encoding for $label payloads",
  async ({ encoding, payload, label }) => {
    const tempDir = sessionDirs.make();
    let storePath = path.join(tempDir, "sessions.json");
    const sessionId = `session-transcript-${encoding}-${label}`;
    const sessionKey = `agent:main:${sessionId}`;
    if (encoding !== "UTF-8") {
      storePath = path.join(tempDir, `${encoding}.sqlite`);
      {
        using seed = new DatabaseSync(storePath);
        seed.exec(
          `PRAGMA encoding = '${encoding}'; CREATE TABLE encoding_seed (id INTEGER); DROP TABLE encoding_seed;`,
        );
      }
      await replaceSessionEntry(
        { agentId: "main", sessionKey, storePath },
        { sessionId, updatedAt: 10 },
      );
    }
    const timestamp = "2026-04-01T05:46:39.000Z";
    const events = [
      { type: "session", version: 3, id: sessionId, timestamp, cwd: tempDir },
      ...[0, 1].map((index) => ({
        type: "message",
        id: `entry-utf16-${index}`,
        parentId: null,
        timestamp,
        message: { role: "user", content: payload, timestamp: 1 },
      })),
    ];
    const scope = { agentId: "main", sessionId, sessionKey, storePath };
    await replaceTranscriptEvents(scope, events);
    const jsonlSize = Buffer.byteLength(events.map((event) => JSON.stringify(event)).join("\n"));
    const expectByteBoundary = () => {
      expect(loadTranscriptEventsSync({ ...scope, maxEventBytes: jsonlSize })).toEqual(events);
      expect(() => loadTranscriptEventsSync({ ...scope, maxEventBytes: jsonlSize - 1 })).toThrow(
        /transcript store is too large to export/u,
      );
    };
    expectByteBoundary();
    if (encoding !== "UTF-8") {
      // Exact UTF-8 metadata must not inherit the legacy identities' native-byte conversion.
      const { db } = openOpenClawAgentDatabase({ agentId: "main", path: storePath });
      db.prepare(
        "UPDATE transcript_events SET event_utf8_bytes = ? WHERE session_id = ? AND seq = 2",
      ).run(Buffer.byteLength(JSON.stringify(events[2]), "utf8"), sessionId);
      expectByteBoundary();
    }
  },
);
