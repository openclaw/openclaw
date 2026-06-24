// Pairing facade tests cover approval notification dispatch choices.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getChannelPlugin: vi.fn(),
  listChannelPlugins: vi.fn(),
  sendMessage: vi.fn(async () => ({
    channel: "whatsapp",
    to: "5511999999999",
    via: "gateway" as const,
    mediaUrl: null,
    result: { messageId: "gw-1" },
  })),
  readChannelAllowFromStore: vi.fn(async () => [] as string[]),
}));

vi.mock("./registry.js", () => ({
  getChannelPlugin: mocks.getChannelPlugin,
  listChannelPlugins: mocks.listChannelPlugins,
}));

vi.mock("../../infra/outbound/message.js", () => ({
  sendMessage: mocks.sendMessage,
}));

vi.mock("../../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: mocks.readChannelAllowFromStore,
}));

import { createChatChannelPlugin } from "../../plugin-sdk/core.js";
import { notifyPairingApproved } from "./pairing.js";

describe("pairing facade", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes outbound-message approval notifications through sendMessage", async () => {
    const plugin = createChatChannelPlugin({
      base: {
        id: "whatsapp",
        meta: { id: "whatsapp", label: "WhatsApp" },
      } as never,
      pairing: {
        text: {
          idLabel: "whatsappSenderId",
          message: "approved",
          delivery: "outbound-message",
        },
      },
    });
    mocks.getChannelPlugin.mockReturnValue(plugin);

    const cfg = { channels: { whatsapp: { enabled: true } } };
    await notifyPairingApproved({
      channelId: "whatsapp",
      id: "5511999999999",
      accountId: "work",
      cfg,
    });

    expect(mocks.readChannelAllowFromStore).toHaveBeenCalledWith("whatsapp", process.env, "work");
    expect(mocks.sendMessage).toHaveBeenCalledWith({
      channel: "whatsapp",
      to: "5511999999999",
      content: "approved",
      cfg,
      accountId: "work",
    });
  });

  it("includes pairing-store approvals in outbound-message notification config", async () => {
    mocks.readChannelAllowFromStore.mockResolvedValue(["5511999999999"]);
    const plugin = createChatChannelPlugin({
      base: {
        id: "whatsapp",
        meta: { id: "whatsapp", label: "WhatsApp" },
      } as never,
      pairing: {
        text: {
          idLabel: "whatsappSenderId",
          message: "approved",
          delivery: "outbound-message",
        },
      },
    });
    mocks.getChannelPlugin.mockReturnValue(plugin);

    const cfg = {
      channels: {
        whatsapp: {
          enabled: true,
          accounts: {
            work: {
              allowFrom: ["5511888888888"],
            },
          },
        },
      },
    };
    await notifyPairingApproved({
      channelId: "whatsapp",
      id: "5511999999999",
      accountId: "work",
      cfg,
    });

    expect(mocks.sendMessage).toHaveBeenCalledWith({
      channel: "whatsapp",
      to: "5511999999999",
      content: "approved",
      cfg: {
        channels: {
          whatsapp: {
            enabled: true,
            accounts: {
              work: {
                allowFrom: ["5511888888888", "5511999999999"],
              },
            },
          },
        },
      },
      accountId: "work",
    });
    expect(cfg.channels.whatsapp.accounts.work.allowFrom).toEqual(["5511888888888"]);
  });
});
