import { describe, expect, it } from "vitest";
import { enrichChatHistoryCompactionMarkers } from "./chat-history-page-kernel.js";

describe("enrichChatHistoryCompactionMarkers", () => {
  it("joins retained legacy token metrics to the matching transcript marker", () => {
    const marker = {
      role: "system",
      __openclaw: { kind: "compaction", id: "compact-entry-1", seq: 4 },
    };
    const entry = {
      sessionId: "session-1",
      updatedAt: 1_000,
      compactionCheckpoints: [
        {
          checkpointId: "checkpoint-1",
          sessionKey: "main",
          sessionId: "session-1",
          createdAt: 1_000,
          reason: "auto-threshold",
          tokensBefore: 900_000,
          tokensAfter: 24_700,
          preCompaction: { sessionId: "session-1" },
          postCompaction: { sessionId: "session-1", entryId: "compact-entry-1" },
        },
      ],
    };

    const result = enrichChatHistoryCompactionMarkers([marker], entry);

    expect(result[0]).toEqual({
      ...marker,
      __openclaw: {
        ...marker["__openclaw"],
        tokensBefore: 900_000,
        tokensAfter: 24_700,
      },
    });
    expect(marker["__openclaw"]).not.toHaveProperty("tokensBefore");
  });

  it("preserves message identity without legacy token metrics", () => {
    const marker = {
      role: "system",
      __openclaw: { kind: "compaction", id: "compact-entry-1" },
    };

    const result = enrichChatHistoryCompactionMarkers([marker], undefined);

    expect(result[0]).toBe(marker);
  });

  it("keeps readable history when legacy checkpoint metadata is malformed", () => {
    const marker = {
      role: "system",
      __openclaw: { kind: "compaction", id: "compact-entry-1" },
    };
    const entry = { sessionId: "session-1", updatedAt: 1_000, compactionCheckpoints: [{}] };
    const messages = [marker];

    expect(enrichChatHistoryCompactionMarkers(messages, entry)).toBe(messages);
  });
});
