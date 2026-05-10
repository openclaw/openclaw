import { describe, expect, test } from "vitest";
import { CURRENT_SESSION_VERSION } from "../../../agents/transcript/session-transcript-format.js";
import type {
  SessionEntry,
  SessionHeader,
  TranscriptEntry,
} from "../../../agents/transcript/session-transcript-types.js";
import { migrateLegacyTranscriptEntries } from "./session-transcript.js";

describe("legacy session transcript migration", () => {
  test("upgrades legacy transcript entries to the current SQLite import schema", () => {
    const entries: TranscriptEntry[] = [
      {
        type: "session",
        id: "session-1",
        timestamp: "2026-05-06T00:00:00.000Z",
        cwd: "/tmp/work",
      } as SessionHeader,
      {
        type: "message",
        timestamp: "2026-05-06T00:00:01.000Z",
        message: { role: "user", content: "hello", timestamp: 1 },
      } as SessionEntry,
      {
        type: "message",
        timestamp: "2026-05-06T00:00:02.000Z",
        message: { role: "hookMessage", content: "legacy", timestamp: 2 },
      } as unknown as SessionEntry,
      {
        type: "compaction",
        timestamp: "2026-05-06T00:00:03.000Z",
        summary: "summary",
        firstKeptEntryIndex: 1,
        tokensBefore: 100,
      } as unknown as SessionEntry,
    ];

    migrateLegacyTranscriptEntries(entries);

    const header = entries[0] as SessionHeader;
    const [first, second, compaction] = entries.slice(1) as SessionEntry[];
    expect(header.version).toBe(CURRENT_SESSION_VERSION);
    expect(first.id).toEqual(expect.any(String));
    expect(first.parentId).toBeNull();
    expect(second.parentId).toBe(first.id);
    expect(second.type).toBe("message");
    if (second.type !== "message") {
      throw new Error("expected migrated message entry");
    }
    expect(second.message.role).toBe("custom");
    expect(compaction.parentId).toBe(second.id);
    expect(compaction.type).toBe("compaction");
    if (compaction.type !== "compaction") {
      throw new Error("expected migrated compaction entry");
    }
    expect(compaction.firstKeptEntryId).toBe(first.id);
    expect(compaction).not.toHaveProperty("firstKeptEntryIndex");
  });

  test("normalizes v3 JSONL headers to the fresh SQLite transcript version", () => {
    const entries: TranscriptEntry[] = [
      {
        type: "session",
        version: 3,
        id: "session-1",
        timestamp: "2026-05-06T00:00:00.000Z",
        cwd: "/tmp/work",
      },
      {
        type: "message",
        id: "entry-1",
        parentId: null,
        timestamp: "2026-05-06T00:00:01.000Z",
        message: { role: "user", content: "hello", timestamp: 1 },
      },
    ];

    migrateLegacyTranscriptEntries(entries);

    expect((entries[0] as SessionHeader).version).toBe(CURRENT_SESSION_VERSION);
    expect(entries[1]).toMatchObject({ id: "entry-1", parentId: null });
  });
});
