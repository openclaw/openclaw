import { describe, expect, it, vi } from "vitest";
import type { BotConfig } from "../../config/config.js";
import { handleWhatsAppAction } from "./whatsapp-actions.js";

const sendReactionWhatsApp = vi.fn(async () => undefined);
const sendPollWhatsApp = vi.fn(async () => ({ messageId: "poll-1", toJid: "jid-1" }));

vi.mock("../../web/outbound.js", () => ({
  sendReactionWhatsApp: (...args: Parameters<typeof sendReactionWhatsApp>) =>
    sendReactionWhatsApp(...args),
  sendPollWhatsApp: (...args: Parameters<typeof sendPollWhatsApp>) => sendPollWhatsApp(...args),
}));

// Stub outbound-target resolution so the test can verify handleWhatsAppAction
// wiring without needing full account/allowFrom config.
vi.mock("./whatsapp-target-auth.js", () => ({
  resolveAuthorizedWhatsAppOutboundTarget: (p: { chatJid: string; accountId?: string }) => ({
    to: p.chatJid,
    accountId: p.accountId,
  }),
}));

const enabledConfig = {
  channels: { whatsapp: { actions: { reactions: true } } },
} as BotConfig;

describe("handleWhatsAppAction", () => {
  it("adds reactions", async () => {
    await handleWhatsAppAction(
      {
        action: "react",
        chatJid: "123@s.whatsapp.net",
        messageId: "msg1",
        emoji: "✅",
      },
      enabledConfig,
    );
    expect(sendReactionWhatsApp).toHaveBeenCalledWith("123@s.whatsapp.net", "msg1", "✅", {
      verbose: false,
      fromMe: undefined,
      participant: undefined,
      accountId: undefined,
    });
  });

  it("removes reactions on empty emoji", async () => {
    await handleWhatsAppAction(
      {
        action: "react",
        chatJid: "123@s.whatsapp.net",
        messageId: "msg1",
        emoji: "",
      },
      enabledConfig,
    );
    expect(sendReactionWhatsApp).toHaveBeenCalledWith("123@s.whatsapp.net", "msg1", "", {
      verbose: false,
      fromMe: undefined,
      participant: undefined,
      accountId: undefined,
    });
  });

  it("removes reactions when remove flag set", async () => {
    await handleWhatsAppAction(
      {
        action: "react",
        chatJid: "123@s.whatsapp.net",
        messageId: "msg1",
        emoji: "✅",
        remove: true,
      },
      enabledConfig,
    );
    expect(sendReactionWhatsApp).toHaveBeenCalledWith("123@s.whatsapp.net", "msg1", "", {
      verbose: false,
      fromMe: undefined,
      participant: undefined,
      accountId: undefined,
    });
  });

  it("passes account scope and sender flags", async () => {
    await handleWhatsAppAction(
      {
        action: "react",
        chatJid: "123@s.whatsapp.net",
        messageId: "msg1",
        emoji: "🎉",
        accountId: "work",
        fromMe: true,
        participant: "999@s.whatsapp.net",
      },
      enabledConfig,
    );
    expect(sendReactionWhatsApp).toHaveBeenCalledWith("123@s.whatsapp.net", "msg1", "🎉", {
      verbose: false,
      fromMe: true,
      participant: "999@s.whatsapp.net",
      accountId: "work",
    });
  });

  it("respects reaction gating", async () => {
    const cfg = {
      channels: { whatsapp: { actions: { reactions: false } } },
    } as BotConfig;
    await expect(
      handleWhatsAppAction(
        {
          action: "react",
          chatJid: "123@s.whatsapp.net",
          messageId: "msg1",
          emoji: "✅",
        },
        cfg,
      ),
    ).rejects.toThrow(/WhatsApp reactions are disabled/);
  });
});
