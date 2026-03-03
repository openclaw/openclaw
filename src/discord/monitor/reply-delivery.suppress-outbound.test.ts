import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { RuntimeEnv } from "../../runtime.js";
import { deliverDiscordReply } from "./reply-delivery.js";

const sendMessageDiscordMock = vi.hoisted(() => vi.fn());
const sendVoiceMessageDiscordMock = vi.hoisted(() => vi.fn());
const sendWebhookMessageDiscordMock = vi.hoisted(() => vi.fn());

vi.mock("../send.js", () => ({
  sendMessageDiscord: (...args: unknown[]) => sendMessageDiscordMock(...args),
  sendVoiceMessageDiscord: (...args: unknown[]) => sendVoiceMessageDiscordMock(...args),
  sendWebhookMessageDiscord: (...args: unknown[]) => sendWebhookMessageDiscordMock(...args),
}));

// Pairing-preflight suppress behavior is covered by integration tests;
// this file focuses on the outbound guard in deliverDiscordReply.

describe("deliverDiscordReply — suppressOutbound", () => {
  const runtime = {} as RuntimeEnv;

  it("blocks delivery when suppressOutbound is true", async () => {
    await deliverDiscordReply({
      replies: [{ text: "hello" }],
      target: "channel:123",
      token: "token",
      accountId: "default",
      runtime,
      textLimit: 2000,
      cfg: { channels: { discord: { suppressOutbound: true } } } as OpenClawConfig,
    });

    expect(sendMessageDiscordMock).not.toHaveBeenCalled();
    expect(sendVoiceMessageDiscordMock).not.toHaveBeenCalled();
    expect(sendWebhookMessageDiscordMock).not.toHaveBeenCalled();
  });

  it("allows delivery when suppressOutbound is false", async () => {
    sendMessageDiscordMock.mockResolvedValue({ messageId: "msg-1", channelId: "123" });

    await deliverDiscordReply({
      replies: [{ text: "hello" }],
      target: "channel:123",
      token: "token",
      accountId: "default",
      runtime,
      textLimit: 2000,
      cfg: { channels: { discord: {} } } as OpenClawConfig,
    });

    expect(sendMessageDiscordMock).toHaveBeenCalled();
  });
});
