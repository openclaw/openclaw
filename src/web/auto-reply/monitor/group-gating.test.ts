import { describe, expect, it } from "vitest";
import { applyGroupGating } from "./group-gating.js";

const baseConfig = {
  channels: {
    whatsapp: {
      groupPolicy: "open",
      groups: { "*": { requireMention: true } },
    },
  },
  session: { store: "/tmp/openclaw-sessions.json" },
} as const;

describe("applyGroupGating", () => {
  it("treats reply-to-bot as implicit mention", () => {
    const groupHistories = new Map();
    const result = applyGroupGating({
      cfg: baseConfig as unknown as ReturnType<
        typeof import("../../../config/config.js").loadConfig
      >,
      msg: {
        id: "m1",
        from: "[redacted-email]",
        conversationId: "[redacted-email]",
        to: "+15550000",
        accountId: "default",
        body: "following up",
        timestamp: Date.now(),
        chatType: "group",
        chatId: "[redacted-email]",
        selfJid: "[redacted-email]",
        selfE164: "+15551234567",
        replyToId: "m0",
        replyToBody: "bot said hi",
        replyToSender: "+15551234567",
        replyToSenderJid: "[redacted-email]",
        replyToSenderE164: "+15551234567",
        sendComposing: async () => {},
        reply: async () => {},
        sendMedia: async () => {},
      },
      conversationId: "[redacted-email]",
      groupHistoryKey: "whatsapp:default:group:[redacted-email]",
      agentId: "main",
      sessionKey: "agent:main:whatsapp:group:[redacted-email]",
      baseMentionConfig: { mentionRegexes: [] },
      groupHistories,
      groupHistoryLimit: 10,
      groupMemberNames: new Map(),
      logVerbose: () => {},
      replyLogger: { debug: () => {} },
    });

    expect(result.shouldProcess).toBe(true);
  });
});
