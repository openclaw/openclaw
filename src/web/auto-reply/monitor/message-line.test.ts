import { describe, expect, it } from "vitest";
import { buildInboundLine } from "./message-line.js";

describe("buildInboundLine", () => {
  it("prefixes group messages with sender", () => {
    const line = buildInboundLine({
      cfg: {
        agents: { defaults: { workspace: "/tmp/openclaw" } },
        channels: { whatsapp: { messagePrefix: "" } },
      } as never,
      agentId: "main",
      msg: {
        from: "[redacted-email]",
        conversationId: "[redacted-email]",
        to: "+15550009999",
        accountId: "default",
        body: "ping",
        timestamp: 1700000000000,
        chatType: "group",
        chatId: "[redacted-email]",
        senderJid: "[redacted-email]",
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
});
