import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import type {
  ChatHistoryPage,
  ChatHistoryPageParams,
} from "../config/sessions/session-history-types.js";
import { encodeChatHistoryResponsePage } from "./chat-history-response-page.js";

it("defers only native display pages and keeps their pagination until final encoding", () => {
  const params: ChatHistoryPageParams = {
    encodeResponse: true,
    offset: undefined,
    messageId: undefined,
    entry: undefined,
    provider: undefined,
    sessionId: "slack-proof",
    storePath: undefined,
    sessionAgentId: "main",
    canonicalKey: "agent:main:slack-proof",
    max: 10,
    maxHistoryBytes: 100_000,
    effectiveMaxChars: 20_000,
    toolResultMaxChars: 20_000,
  };
  const message = {
    role: "user",
    content: "<@U1111111111> (Slack Alice)",
    __openclaw: {
      id: "m1",
      seq: 3,
      transport: { channel: "slack", accountId: "work" },
    },
  };
  const page: ChatHistoryPage = {
    messages: [message],
    pagination: { offset: 0, totalMessages: 3, rawPageMessages: 1, messageSequences: { m1: 3 } },
  };
  const before = expectDefined(
    encodeChatHistoryResponsePage(page, params).encodedResponse,
    "encoded baseline",
  );
  expect(before.hasMore).toBe(true);
  const deferred = encodeChatHistoryResponsePage(page, {
    ...params,
    deferChannelUserDisplay: true,
  });
  expect(deferred).toBe(page);
  expect(deferred.pagination).toBe(page.pagination);
  const after = expectDefined(
    encodeChatHistoryResponsePage(
      { ...deferred, messages: [{ ...message, content: "@Gateway Alice" }] },
      params,
    ).encodedResponse,
    "encoded display page",
  );
  expect(new TextDecoder().decode(after.messages)).toContain("@Gateway Alice");
  expect(after.hasMore).toBe(before.hasMore);
  expect(after.nextOffset).toBe(before.nextOffset);
  expect(after.totalMessages).toBe(before.totalMessages);
  const ordinary = encodeChatHistoryResponsePage(
    {
      messages: [
        {
          ...message,
          __openclaw: {
            ...message["__openclaw"],
            transport: { channel: "webchat", accountId: "work" },
          },
        },
      ],
    },
    { ...params, deferChannelUserDisplay: true },
  );
  expect(ordinary.encodedResponse).toBeDefined();
  expect(ordinary.messages).toEqual([]);
});

it("indexes exactly the policy-sensitive top-level assistant tuples while encoding", () => {
  const hidden = { provider: "example", model: "hidden" };
  const rows = [
    { role: "user", ...hidden, content: "雪🦞" },
    { role: "toolResult", ...hidden },
    { role: "assistant", __openclaw: { nested: hidden } },
    { role: "assistant", provider: null, model: null },
    { role: "assistant", provider: "openclaw", model: "delivery-mirror" },
    { role: "assistant", provider: "example", model: "allowed" },
    { role: "assistant", ...hidden },
    { role: "assistant", model: 42 },
    { role: "assistant", provider: null, model: "hidden" },
    { role: "assistant", provider: "example" },
  ];
  const page = encodeChatHistoryResponsePage(
    { messages: rows },
    {
      encodeResponse: true,
      entry: undefined,
      provider: undefined,
      sessionId: "indexed",
      storePath: undefined,
      sessionAgentId: "main",
      canonicalKey: "agent:main:indexed",
      max: 200,
      maxHistoryBytes: 512 * 1024,
      effectiveMaxChars: 20_000,
      offset: undefined,
      messageId: undefined,
    },
  );
  const bytes = expectDefined(page.encodedResponse, "encoded page").messages;
  const index = expectDefined(page.messageModelIndex, "model row index");
  expect(index.rowCount).toBe(10);
  expect(index.byteLength).toBe(bytes.byteLength);
  const indexed = [];
  for (let i = 0; i < index.ranges.length; i += 2) {
    indexed.push(
      JSON.parse(new TextDecoder().decode(bytes.subarray(index.ranges[i], index.ranges[i + 1]))),
    );
  }
  expect(indexed).toEqual(rows.slice(5));
  expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual(rows);
});
