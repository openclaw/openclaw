import { describe, expect, it } from "vitest";
import { enrichChatHistoryCompactionMarkers } from "./chat-history-page-kernel.js";
import { prepareChatHistoryResponsePage } from "./chat-history-response-page.js";

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

describe("chat history source-row byte limits", () => {
  it("keeps oversized cursor identities inside the response byte limit", () => {
    const messageId = "x".repeat(1_000_000);
    const page = prepareChatHistoryResponsePage(
      {
        messages: [
          { role: "assistant", content: "Visible", __openclaw: { id: messageId, seq: 2 } },
        ],
        anchor: {
          sessionId: "bounded-cursor",
          source: "source",
          hasOlder: true,
          hasNewer: true,
          oldestMessageId: messageId,
          newestMessageId: messageId,
        },
      },
      { entry: undefined, maxHistoryBytes: 512 * 1024, messageId },
    );
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(1_000_000);
    expect(page.olderCursor).toBeUndefined();
    expect(page.newerCursor).toBeUndefined();
  });

  it.each([undefined, "sibling-1"])(
    "keeps a fetchable reference for oversized CLI siblings (anchor=%s)",
    (messageId) => {
      const messages = Array.from({ length: 5 }, (_, index) => ({
        role: "assistant",
        content: [{ type: "text", text: `sibling-${index}: ${"x".repeat(120_000)}` }],
        __openclaw: { id: `sibling-${index}`, seq: index + 20 },
      }));
      const page = prepareChatHistoryResponsePage(
        {
          messages,
          pagination: {
            offset: 1,
            totalMessages: 3,
            rawPageMessages: 1,
            messageSequences: Object.fromEntries(
              messages.map((message) => [`id:${message["__openclaw"].id}`, 2]),
            ),
          },
        },
        { entry: undefined, maxHistoryBytes: 512 * 1024, messageId },
      );
      expect(page.messages).toHaveLength(1);
      expect(page.messages[0]).toMatchObject({
        __openclaw: { id: messageId ?? "sibling-4", truncated: true },
      });
      expect(page.nextOffset).toBe(2);
      expect(page.messagesBytes).toBeLessThan(512 * 1024);
    },
  );

  it("bounds an oversized indivisible source row and its activity by reference", () => {
    const messages = Array.from({ length: 60 }, (_, index) => ({
      role: "toolResult",
      content: [{ type: "text", text: `sibling-${index}: ${"x".repeat(120_000)}` }],
      __openclaw: { id: `sibling-${index}`, seq: 2 },
    }));
    const page = prepareChatHistoryResponsePage(
      {
        messages,
        activity: messages.map((message) => ({ messageId: message["__openclaw"].id, items: [] })),
        pagination: { offset: 1, totalMessages: 3, rawPageMessages: 1 },
      },
      { entry: undefined, maxHistoryBytes: 512 * 1024, messageId: undefined },
    );
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]).toMatchObject({ __openclaw: { id: "sibling-59", truncated: true } });
    const bytes =
      Buffer.byteLength(JSON.stringify(page.messages)) +
      (page.activity ? Buffer.byteLength(JSON.stringify({ activity: page.activity })) - 1 : 0);
    expect(bytes).toBeLessThanOrEqual(512 * 1024);
    expect(page.messagesBytes).toBe(bytes);
    expect(page.activity).toBeUndefined();
    expect(page.nextOffset).toBe(2);
    expect(page.hasMore).toBe(true);
  });
});
