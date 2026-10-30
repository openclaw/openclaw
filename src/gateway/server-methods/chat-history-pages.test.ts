import { expect, it } from "vitest";
import type { ChatHistoryPageParams } from "../../config/sessions/session-history-types.js";
import {
  encodeChatHistoryResponsePage,
  prepareChatHistoryResponsePage,
} from "../chat-history-response-page.js";

it("serializes message content once for budgeting and encoding, fresh on each request", () => {
  let reads = 0;
  let text = "tool output 漢字🦞";
  const message = {
    role: "toolResult",
    get content() {
      reads++;
      return text;
    },
    __openclaw: { id: "result", seq: 1 },
  };
  const params: ChatHistoryPageParams = {
    encodeResponse: true,
    entry: undefined,
    provider: undefined,
    sessionId: "session",
    storePath: undefined,
    sessionAgentId: "main",
    canonicalKey: "agent:main:session",
    max: 100,
    maxHistoryBytes: 512 * 1024,
    effectiveMaxChars: 8000,
    offset: undefined,
    messageId: undefined,
  };
  for (const content of [text, "updated tool output"]) {
    text = content;
    reads = 0;
    const response = encodeChatHistoryResponsePage(
      { messages: [message] },
      params,
    ).encodedResponse!;
    expect(reads).toBe(1);
    expect(Buffer.from(response.messages).toString()).toBe(
      JSON.stringify([{ role: "toolResult", content, __openclaw: { id: "result", seq: 1 } }]),
    );
    expect(response.messagesBytes).toBe(response.messages.byteLength);
  }
});

it("reuses a history page when budgeting does not replace or omit messages", () => {
  const messages = [
    { role: "assistant", content: "Calling read", __openclaw: { id: "call", seq: 1 } },
    { role: "toolResult", content: "File contents", __openclaw: { id: "result", seq: 2 } },
  ];
  Object.freeze(messages);
  const page = prepareChatHistoryResponsePage(
    { messages, pagination: { offset: 0, totalMessages: 2, rawPageMessages: 2 } },
    { entry: undefined, maxHistoryBytes: 512 * 1024, messageId: undefined },
  );
  expect(page.messages).toBe(messages);
  expect(page.messagesBytes).toBe(Buffer.byteLength(JSON.stringify(messages)));
  expect(page.omission).toBeUndefined();
  expect(page.hasMore).toBe(false);
});

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
