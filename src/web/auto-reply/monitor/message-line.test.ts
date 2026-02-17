import { describe, expect, it } from "vitest";
import { buildInboundLine, formatReplyContext } from "./message-line.js";

describe("buildInboundLine", () => {
  it("prefixes group messages with sender", () => {
    const line = buildInboundLine({
      cfg: {
        agents: { defaults: { workspace: "/tmp/openclaw" } },
        channels: { whatsapp: { messagePrefix: "" } },
      } as never,
      agentId: "main",
      msg: {
        from: "123@g.us",
        conversationId: "123@g.us",
        to: "+15550009999",
        accountId: "default",
        body: "ping",
        timestamp: 1700000000000,
        chatType: "group",
        chatId: "123@g.us",
        senderJid: "111@s.whatsapp.net",
        senderE164: "+15550001111",
        senderName: "Bob",
        sendComposing: async () => undefined,
        reply: async () => undefined,
        sendMedia: async () => undefined,
      } as never,
    });

    expect(line).toContain("Bob (+15550001111):");
    expect(line).toContain("ping");
  });

  it("includes reply-to context blocks when replyToBody is present", () => {
    const line = buildInboundLine({
      cfg: {
        agents: { defaults: { workspace: "/tmp/openclaw" } },
        channels: { whatsapp: { messagePrefix: "" } },
      } as never,
      agentId: "main",
      msg: {
        from: "+1555",
        to: "+1555",
        body: "hello",
        chatType: "direct",
        replyToId: "q1",
        replyToBody: "original",
        replyToSender: "+1999",
      } as never,
      envelope: { includeTimestamp: false },
    });

    expect(line).toContain("[Replying to +1999 id:q1]");
    expect(line).toContain("original");
    expect(line).toContain("[/Replying]");
  });

  it("applies the WhatsApp messagePrefix when configured", () => {
    const line = buildInboundLine({
      cfg: {
        agents: { defaults: { workspace: "/tmp/openclaw" } },
        channels: { whatsapp: { messagePrefix: "[PFX]" } },
      } as never,
      agentId: "main",
      msg: {
        from: "+1555",
        to: "+2666",
        body: "ping",
        chatType: "direct",
      } as never,
      envelope: { includeTimestamp: false },
    });

    expect(line).toContain("[PFX] ping");
  });
});

describe("formatReplyContext", () => {
  it("returns null when replyToBody is missing", () => {
    expect(formatReplyContext({} as never)).toBeNull();
  });
});
