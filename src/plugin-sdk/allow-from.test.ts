import { describe, expect, it } from "vitest";
import { isAllowedParsedChatSender } from "./allow-from.js";

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
