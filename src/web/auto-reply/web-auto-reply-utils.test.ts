import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { WebInboundMsg } from "./types.js";
import { saveSessionStore } from "../../config/sessions.js";
import { isBotMentionedFromTargets, resolveMentionTargets } from "./mentions.js";
import { getSessionSnapshot } from "./session-snapshot.js";
import { elide, isLikelyWhatsAppCryptoError } from "./util.js";

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

describe("getSessionSnapshot", () => {
  it("uses channel reset overrides when configured", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 18, 5, 0, 0));
    try {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-snapshot-"));
      const storePath = path.join(root, "sessions.json");
      const sessionKey = "agent:main:whatsapp:dm:s1";

      await saveSessionStore(storePath, {
        [sessionKey]: {
          sessionId: "snapshot-session",
          updatedAt: new Date(2026, 0, 18, 3, 30, 0).getTime(),
          lastChannel: "whatsapp",
        },
      });

      const cfg = {
        session: {
          store: storePath,
          reset: { mode: "daily", atHour: 4, idleMinutes: 240 },
          resetByChannel: {
            whatsapp: { mode: "idle", idleMinutes: 360 },
          },
        },
      } as Parameters<typeof getSessionSnapshot>[0];

      const snapshot = getSessionSnapshot(cfg, "whatsapp:+15550001111", true, {
        sessionKey,
      });

      expect(snapshot.resetPolicy.mode).toBe("idle");
      expect(snapshot.resetPolicy.idleMinutes).toBe(360);
      expect(snapshot.fresh).toBe(true);
      expect(snapshot.dailyResetAt).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("web auto-reply util", () => {
  describe("elide", () => {
    it("returns undefined for undefined input", () => {
      expect(elide(undefined)).toBe(undefined);
    });

    it("returns input when under limit", () => {
      expect(elide("hi", 10)).toBe("hi");
    });

    it("truncates and annotates when over limit", () => {
      expect(elide("abcdef", 3)).toBe("abc… (truncated 3 chars)");
    });
  });

  describe("isLikelyWhatsAppCryptoError", () => {
    it("returns false for non-matching reasons", () => {
      expect(isLikelyWhatsAppCryptoError(new Error("boom"))).toBe(false);
      expect(isLikelyWhatsAppCryptoError("boom")).toBe(false);
      expect(isLikelyWhatsAppCryptoError({ message: "bad mac" })).toBe(false);
    });

    it("matches known Baileys crypto auth errors (string)", () => {
      expect(
        isLikelyWhatsAppCryptoError(
          "baileys: unsupported state or unable to authenticate data (noise-handler)",
        ),
      ).toBe(true);
      expect(isLikelyWhatsAppCryptoError("bad mac in aesDecryptGCM (baileys)")).toBe(true);
    });

    it("matches known Baileys crypto auth errors (Error)", () => {
      const err = new Error("bad mac");
      err.stack = "at something\nat @whiskeysockets/baileys/noise-handler\n";
      expect(isLikelyWhatsAppCryptoError(err)).toBe(true);
    });

    it("does not throw on circular objects", () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      expect(isLikelyWhatsAppCryptoError(circular)).toBe(false);
    });

    it("handles non-string reasons without throwing", () => {
      expect(isLikelyWhatsAppCryptoError(null)).toBe(false);
      expect(isLikelyWhatsAppCryptoError(123)).toBe(false);
      expect(isLikelyWhatsAppCryptoError(true)).toBe(false);
      expect(isLikelyWhatsAppCryptoError(123n)).toBe(false);
      expect(isLikelyWhatsAppCryptoError(Symbol("bad mac"))).toBe(false);
      expect(isLikelyWhatsAppCryptoError(function namedFn() {})).toBe(false);
    });
  });
});
