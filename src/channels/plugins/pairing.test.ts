// Pairing facade tests cover approval notification dispatch choices.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "./types.plugin.js";

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
}));

vi.mock("./registry.js", () => ({
  getChannelPlugin: mocks.getChannelPlugin,
  listChannelPlugins: mocks.listChannelPlugins,
}));

vi.mock("../../infra/outbound/message.js", () => ({
  sendMessage: mocks.sendMessage,
}));

import { notifyPairingApproved } from "./pairing.js";

describe("pairing facade", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes outbound-message approval notifications through sendMessage", async () => {
    const notifyApproval = vi.fn();
    mocks.getChannelPlugin.mockReturnValue({
      id: "whatsapp",
      pairing: {
        idLabel: "whatsappSenderId",
        approvalMessage: "approved",
        notifyApprovalDelivery: "outbound-message",
        notifyApproval,
      },
    } satisfies Partial<ChannelPlugin>);

    const cfg = { channels: { whatsapp: { enabled: true } } };
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
      cfg,
      accountId: "work",
    });
    expect(notifyApproval).not.toHaveBeenCalled();
  });
});
