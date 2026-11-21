import { describe, expect, it } from "vitest";
import {
  createAllowedChatSenderMatcher,
  isAllowedParsedChatSender,
  type ParsedChatAllowTarget,
} from "./chat-target-prefixes.js";

function normalizeSender(sender: string): string {
  return sender.trim().toLowerCase();
}

function parseAllowTarget(entry: string): ParsedChatAllowTarget {
  const trimmed = entry.trim();
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("chat_id:")) {
    return { kind: "chat_id", chatId: Number.parseInt(trimmed.slice("chat_id:".length), 10) };
  }
  if (lower.startsWith("chat_guid:")) {
    return { kind: "chat_guid", chatGuid: trimmed.slice("chat_guid:".length).trim() };
  }
  if (lower.startsWith("chat_identifier:")) {
    return {
      kind: "chat_identifier",
      chatIdentifier: trimmed.slice("chat_identifier:".length).trim(),
    };
  }
  return { kind: "handle", handle: normalizeSender(trimmed) };
}

const parsers = { normalizeSender, parseAllowTarget };
const conversation = {
  sender: "other@example.com",
  chatId: 123,
  chatGuid: "thread-123",
  chatIdentifier: "team",
};
const conversationEntries = ["chat_id:123", "chat_guid:thread-123", "chat_identifier:team"];

describe("isAllowedParsedChatSender", () => {
  it("matches wildcard and normalized sender handles", () => {
    expect(
      isAllowedParsedChatSender({
        allowFrom: ["owner@example.com"],
        sender: "Owner@Example.com",
        ...parsers,
      }),
    ).toBe(true);

    expect(
      isAllowedParsedChatSender({
        allowFrom: ["*"],
        sender: "other@example.com",
        ...parsers,
      }),
    ).toBe(true);
  });

  it("does not match conversation targets unless explicitly enabled", () => {
    for (const entry of conversationEntries) {
      const params = { ...conversation, ...parsers, allowFrom: [entry] };
      expect(isAllowedParsedChatSender(params)).toBe(false);
      expect(isAllowedParsedChatSender({ ...params, allowConversationTargets: true })).toBe(true);
    }
  });
});

describe("createAllowedChatSenderMatcher", () => {
  it.each([undefined, true])(
    "conversation targets require opt-in: %s",
    (allowConversationTargets) => {
      const matcher = createAllowedChatSenderMatcher({
        ...parsers,
        allowConversationTargets,
      });

      for (const entry of conversationEntries) {
        expect(matcher({ ...conversation, allowFrom: [entry] })).toBe(
          allowConversationTargets === true,
        );
      }
    },
  );
});
