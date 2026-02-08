import { describe, expect, it } from "vitest";
import type { WebInboundMsg } from "./types.js";
import { isBotMentionedFromTargets, resolveMentionTargets } from "./mentions.js";

const makeMsg = (overrides: Partial<WebInboundMsg>): WebInboundMsg =>
  ({
    id: "m1",
    from: "120363401234567890@g.us",
    conversationId: "120363401234567890@g.us",
    to: "15551234567@s.whatsapp.net",
    accountId: "default",
    body: "",
    chatType: "group",
    chatId: "120363401234567890@g.us",
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
      mentionedJids: ["19998887777@s.whatsapp.net"],
      selfE164: "+15551234567",
      selfJid: "15551234567@s.whatsapp.net",
    });
    const targets = resolveMentionTargets(msg);
    expect(isBotMentionedFromTargets(msg, mentionCfg, targets)).toBe(false);
  });

  it("matches explicit self mentions", () => {
    const msg = makeMsg({
      body: "hey",
      mentionedJids: ["15551234567@s.whatsapp.net"],
      selfE164: "+15551234567",
      selfJid: "15551234567@s.whatsapp.net",
    });
    const targets = resolveMentionTargets(msg);
    expect(isBotMentionedFromTargets(msg, mentionCfg, targets)).toBe(true);
  });

  it("detects LID mention from external sender in self-chat mode (#8487)", () => {
    // When the bot's own number is in allowFrom, isSelfChatMode returns true.
    // An external user (senderE164 !== selfE164) @mentions the bot via LID.
    // normalizedMentions correctly resolves the LID to the bot's E164.
    const selfChatCfg = { mentionRegexes: [/\bopenclaw\b/i], allowFrom: ["+15551234567"] };
    const msg = makeMsg({
      body: "@181891881787642 you look more beautiful to me now",
      mentionedJids: ["181891881787642@lid"],
      senderE164: "+6591596604",
      selfE164: "+15551234567",
      selfJid: "15551234567:1@s.whatsapp.net",
    });
    const targets = {
      normalizedMentions: ["+15551234567"],
      selfE164: "+15551234567",
      selfJid: "15551234567",
    };
    expect(isBotMentionedFromTargets(msg, selfChatCfg, targets)).toBe(true);
  });

  it("ignores JID mention when sender IS the owner in self-chat mode", () => {
    // WhatsApp auto-includes the owner's JID in mentionedJids — suppress this.
    const selfChatCfg = { mentionRegexes: [/\bopenclaw\b/i], allowFrom: ["+15551234567"] };
    const msg = makeMsg({
      body: "@owner ping",
      mentionedJids: ["15551234567@s.whatsapp.net"],
      senderE164: "+15551234567",
      selfE164: "+15551234567",
      selfJid: "15551234567@s.whatsapp.net",
    });
    const targets = {
      normalizedMentions: ["+15551234567"],
      selfE164: "+15551234567",
      selfJid: "15551234567",
    };
    expect(isBotMentionedFromTargets(msg, selfChatCfg, targets)).toBe(false);
  });

  it("does not trigger on other users' LID mentions in self-chat mode", () => {
    // In self-chat mode, a mention of someone OTHER than the bot should not trigger.
    const selfChatCfg = { mentionRegexes: [/\bopenclaw\b/i], allowFrom: ["+15551234567"] };
    const msg = makeMsg({
      body: "@999888777666 hi there",
      mentionedJids: ["999888777666@lid"],
      senderE164: "+6591596604",
      selfE164: "+15551234567",
      selfJid: "15551234567:1@s.whatsapp.net",
    });
    const targets = {
      normalizedMentions: ["+19998887777"],
      selfE164: "+15551234567",
      selfJid: "15551234567",
    };
    expect(isBotMentionedFromTargets(msg, selfChatCfg, targets)).toBe(false);
  });

  it("falls back to regex when no mentions are present", () => {
    const msg = makeMsg({
      body: "openclaw can you help?",
      selfE164: "+15551234567",
      selfJid: "15551234567@s.whatsapp.net",
    });
    const targets = resolveMentionTargets(msg);
    expect(isBotMentionedFromTargets(msg, mentionCfg, targets)).toBe(true);
  });
});
