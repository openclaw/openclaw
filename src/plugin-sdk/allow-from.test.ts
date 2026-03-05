import { describe, expect, it } from "vitest";
import { isAllowedParsedChatSender, isNormalizedSenderAllowed } from "./allow-from.js";

function parseAllowTarget(
  entry: string,
):
  | { kind: "chat_id"; chatId: number }
  | { kind: "chat_guid"; chatGuid: string }
  | { kind: "chat_identifier"; chatIdentifier: string }
  | { kind: "handle"; handle: string } {
  const trimmed = entry.trim();
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("chat_id:")) {
    return { kind: "chat_id", chatId: Number.parseInt(trimmed.slice("chat_id:".length), 10) };
  }
  if (lower.startsWith("chat_guid:")) {
    return { kind: "chat_guid", chatGuid: trimmed.slice("chat_guid:".length) };
  }
  if (lower.startsWith("chat_identifier:")) {
    return {
      kind: "chat_identifier",
      chatIdentifier: trimmed.slice("chat_identifier:".length),
    };
  }
  return { kind: "handle", handle: lower };
}

describe("isAllowedParsedChatSender", () => {
  it("denies when allowFrom is empty", () => {
    const allowed = isAllowedParsedChatSender({
      allowFrom: [],
      sender: "+15551234567",
      normalizeSender: (sender) => sender,
      parseAllowTarget,
    });

    expect(allowed).toBe(false);
  });

  it("allows wildcard entries", () => {
    const allowed = isAllowedParsedChatSender({
      allowFrom: ["*"],
      sender: "user@example.com",
      normalizeSender: (sender) => sender.toLowerCase(),
      parseAllowTarget,
    });

    expect(allowed).toBe(true);
  });

  it("matches normalized handles", () => {
    const allowed = isAllowedParsedChatSender({
      allowFrom: ["User@Example.com"],
      sender: "user@example.com",
      normalizeSender: (sender) => sender.toLowerCase(),
      parseAllowTarget,
    });

    expect(allowed).toBe(true);
  });

  it("matches chat IDs when provided", () => {
    const allowed = isAllowedParsedChatSender({
      allowFrom: ["chat_id:42"],
      sender: "+15551234567",
      chatId: 42,
      normalizeSender: (sender) => sender,
      parseAllowTarget,
    });

    expect(allowed).toBe(true);
  });
});

describe("isNormalizedSenderAllowed", () => {
  it("allows wildcard", () => {
    expect(
      isNormalizedSenderAllowed({
        senderId: "attacker",
        allowFrom: ["*"],
      }),
    ).toBe(true);
  });

  it("normalizes case and strips prefixes", () => {
    expect(
      isNormalizedSenderAllowed({
        senderId: "12345",
        allowFrom: ["ZALO:12345", "zl:777"],
        stripPrefixRe: /^(zalo|zl):/i,
      }),
    ).toBe(true);
  });

  it("rejects when sender is missing", () => {
    expect(
      isNormalizedSenderAllowed({
        senderId: "999",
        allowFrom: ["zl:12345"],
        stripPrefixRe: /^(zalo|zl):/i,
      }),
    ).toBe(false);
  });
});
