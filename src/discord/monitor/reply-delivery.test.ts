import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../../runtime.js";
import { deliverDiscordReply } from "./reply-delivery.js";

const sendMessageDiscordMock = vi.hoisted(() => vi.fn());
const sendVoiceMessageDiscordMock = vi.hoisted(() => vi.fn());

vi.mock("../send.js", () => ({
  sendMessageDiscord: (...args: unknown[]) => sendMessageDiscordMock(...args),
  sendVoiceMessageDiscord: (...args: unknown[]) => sendVoiceMessageDiscordMock(...args),
}));

describe("deliverDiscordReply", () => {
  const runtime = {} as RuntimeEnv;

  beforeEach(() => {
    sendMessageDiscordMock.mockReset().mockResolvedValue({
      messageId: "msg-1",
      channelId: "channel-1",
    });
    sendVoiceMessageDiscordMock.mockReset().mockResolvedValue({
      messageId: "voice-1",
      channelId: "channel-1",
    });
  });

  it("routes audioAsVoice payloads through the voice API and sends text separately", async () => {
    await deliverDiscordReply({
      replies: [
        {
          text: "Hello there",
          mediaUrls: ["https://example.com/voice.ogg", "https://example.com/extra.mp3"],
          audioAsVoice: true,
        },
      ],
      target: "channel:123",
      token: "token",
      runtime,
      textLimit: 2000,
      replyToId: "reply-1",
    });

    expect(sendVoiceMessageDiscordMock).toHaveBeenCalledTimes(1);
    expect(sendVoiceMessageDiscordMock).toHaveBeenCalledWith(
      "channel:123",
      "https://example.com/voice.ogg",
      expect.objectContaining({ token: "token", replyTo: "reply-1" }),
    );

    expect(sendMessageDiscordMock).toHaveBeenCalledTimes(2);
    expect(sendMessageDiscordMock).toHaveBeenNthCalledWith(
      1,
      "channel:123",
      "Hello there",
      expect.objectContaining({ token: "token", replyTo: "reply-1" }),
    );
    expect(sendMessageDiscordMock).toHaveBeenNthCalledWith(
      2,
      "channel:123",
      "",
      expect.objectContaining({
        token: "token",
        mediaUrl: "https://example.com/extra.mp3",
        replyTo: "reply-1",
      }),
    );
  });

  it("skips follow-up text when the voice payload text is blank", async () => {
    await deliverDiscordReply({
      replies: [
        {
          text: "   ",
          mediaUrl: "https://example.com/voice.ogg",
          audioAsVoice: true,
        },
      ],
      target: "channel:456",
      token: "token",
      runtime,
      textLimit: 2000,
    });

    expect(sendVoiceMessageDiscordMock).toHaveBeenCalledTimes(1);
    expect(sendMessageDiscordMock).not.toHaveBeenCalled();
  });

  it("uses replyToId only for the first chunk when replyToMode is first", async () => {
    await deliverDiscordReply({
      replies: [
        {
          text: "1234567890",
        },
      ],
      target: "channel:789",
      token: "token",
      runtime,
      textLimit: 5,
      replyToId: "reply-1",
      replyToMode: "first",
    });

    expect(sendMessageDiscordMock).toHaveBeenCalledTimes(2);
    expect(sendMessageDiscordMock.mock.calls[0]?.[2]?.replyTo).toBe("reply-1");
    expect(sendMessageDiscordMock.mock.calls[1]?.[2]?.replyTo).toBeUndefined();
  });
});
