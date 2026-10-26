import { expect, it } from "vitest";
import { prepareChatHistoryResponsePage } from "../chat-history-response-page.js";

it("keeps oversized cursor identities inside the response byte limit", () => {
  const messageId = "x".repeat(1_000_000);
  const page = prepareChatHistoryResponsePage(
    {
      messages: [{ role: "assistant", content: "Visible", __openclaw: { id: messageId, seq: 2 } }],
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
  expect([page.olderCursor, page.newerCursor]).toEqual([undefined, undefined]);
});

it.each([
  ["CLI tail", undefined, false],
  ["CLI anchor", "sibling-1", false],
  ["indivisible row with activity", undefined, true],
] as const)("keeps a fetchable reference for oversized %s", (_name, messageId, withActivity) => {
  const messages = Array.from({ length: withActivity ? 60 : 5 }, (_, index) => ({
    role: withActivity ? "toolResult" : "assistant",
    content: [{ type: "text", text: `sibling-${index}: ${"x".repeat(120_000)}` }],
    __openclaw: { id: `sibling-${index}`, seq: withActivity ? 2 : index + 20 },
  }));
  const activity = withActivity
    ? messages.map((message) => ({ messageId: message["__openclaw"].id, items: [] }))
    : undefined;
  const messageSequences = withActivity
    ? undefined
    : Object.fromEntries(messages.map((message) => [`id:${message["__openclaw"].id}`, 2]));
  const page = prepareChatHistoryResponsePage(
    {
      messages,
      activity,
      pagination: { offset: 1, totalMessages: 3, rawPageMessages: 1, messageSequences },
    },
    { entry: undefined, maxHistoryBytes: 512 * 1024, messageId },
  );
  const id = messageId ?? (withActivity ? "sibling-59" : "sibling-4");
  expect(page.messages).toMatchObject([{ __openclaw: { id, truncated: true } }]);
  expect(page.nextOffset).toBe(2);
  if (withActivity) {
    expect(page.hasMore).toBe(true);
    expect(page.activity).toBeUndefined();
    expect(page.messagesBytes).toBe(Buffer.byteLength(JSON.stringify(page.messages)));
  }
  expect(page.messagesBytes).toBeLessThan(512 * 1024);
});
