import { describe, expect, it } from "vitest";
import type { WebInboundMsg } from "./types.js";
import { isBotMentionedFromTargets, resolveMentionTargets } from "./mentions.js";

const makeMsg = (overrides: Partial<WebInboundMsg>): WebInboundMsg =>
  ({
    id: "m1",
    from: "[redacted-email]",
    conversationId: "[redacted-email]",
    to: "[redacted-email]",
    accountId: "default",
    body: "",
    chatType: "group",
    chatId: "[redacted-email]",
    sendComposing: async () => {},
    reply: async () => {},
    sendMedia: async () => {},
    ...overrides,
  }) as WebInboundMsg;

describe("isBotMentionedFromTargets", () => {
  const mentionCfg = { mentionRegexes: [/\bopenclaw\b/i] };

  it("ignores regex matches when other mentions are present", () => {
    const msg = makeMsg({
      body: "@OpenClaw please help",
      mentionedJids: ["[redacted-email]"],
      selfE164: "+15551234567",
      selfJid: "[redacted-email]",
    });
    const targets = resolveMentionTargets(msg);
    expect(isBotMentionedFromTargets(msg, mentionCfg, targets)).toBe(false);
  });

  it("matches explicit self mentions", () => {
    const msg = makeMsg({
      body: "hey",
      mentionedJids: ["[redacted-email]"],
      selfE164: "+15551234567",
      selfJid: "[redacted-email]",
    });
    const targets = resolveMentionTargets(msg);
    expect(isBotMentionedFromTargets(msg, mentionCfg, targets)).toBe(true);
  });

  it("falls back to regex when no mentions are present", () => {
    const msg = makeMsg({
      body: "openclaw can you help?",
      selfE164: "+15551234567",
      selfJid: "[redacted-email]",
    });
    const targets = resolveMentionTargets(msg);
    expect(isBotMentionedFromTargets(msg, mentionCfg, targets)).toBe(true);
  });
});
