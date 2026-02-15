import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

  it("falls back to regex when no mentions are present", () => {
    const msg = makeMsg({
      body: "openclaw can you help?",
      selfE164: "+15551234567",
      selfJid: "15551234567@s.whatsapp.net",
    });
    const targets = resolveMentionTargets(msg);
    expect(isBotMentionedFromTargets(msg, mentionCfg, targets)).toBe(true);
  });

  it("ignores JID mentions in self-chat mode", () => {
    const cfg = { mentionRegexes: [/\bopenclaw\b/i], allowFrom: ["+999"] };
    const msg = makeMsg({
      body: "@owner ping",
      mentionedJids: ["999@s.whatsapp.net"],
      selfE164: "+999",
      selfJid: "999@s.whatsapp.net",
    });
    const targets = resolveMentionTargets(msg);
    expect(isBotMentionedFromTargets(msg, cfg, targets)).toBe(false);

    const msgTextMention = makeMsg({
      body: "openclaw ping",
      selfE164: "+999",
      selfJid: "999@s.whatsapp.net",
    });
    const targetsText = resolveMentionTargets(msgTextMention);
    expect(isBotMentionedFromTargets(msgTextMention, cfg, targetsText)).toBe(true);
  });
});

describe("resolveMentionTargets with @lid mapping", () => {
  it("resolves mentionedJids via lid reverse mapping in authDir", async () => {
    const authDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lid-mapping-"));
    try {
      await fs.writeFile(
        path.join(authDir, "lid-mapping-777_reverse.json"),
        JSON.stringify("+1777"),
      );
      const msg = makeMsg({
        body: "ping",
        mentionedJids: ["777@lid"],
        selfE164: "+15551234567",
        selfJid: "15551234567@s.whatsapp.net",
      });
      const targets = resolveMentionTargets(msg, authDir);
      expect(targets.normalizedMentions).toContain("+1777");
    } finally {
      await fs.rm(authDir, { recursive: true, force: true });
    }
  });

  it("derives selfE164 from selfJid when selfJid is @lid and mapping exists", async () => {
    const authDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lid-mapping-"));
    try {
      await fs.writeFile(
        path.join(authDir, "lid-mapping-777_reverse.json"),
        JSON.stringify("+1777"),
      );
      const msg = makeMsg({
        body: "ping",
        selfJid: "777@lid",
      });
      const targets = resolveMentionTargets(msg, authDir);
      expect(targets.selfE164).toBe("+1777");
    } finally {
      await fs.rm(authDir, { recursive: true, force: true });
    }
  });
});
