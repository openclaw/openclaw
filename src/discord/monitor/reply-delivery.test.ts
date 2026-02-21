import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../../runtime.js";
import { deliverDiscordReply } from "./reply-delivery.js";

const sendMessageDiscordMock = vi.hoisted(() => vi.fn());
const sendVoiceMessageDiscordMock = vi.hoisted(() => vi.fn());

vi.mock("../send.js", () => ({
  sendMessageDiscord: (...args: unknown[]) => sendMessageDiscordMock(...args),
  sendVoiceMessageDiscord: (...args: unknown[]) => sendVoiceMessageDiscordMock(...args),
}));

const isTableImageRendererAvailableMock = vi.hoisted(() => vi.fn());
const renderTableImageMock = vi.hoisted(() => vi.fn());

vi.mock("../../media/table-image.js", () => ({
  isTableImageRendererAvailable: (...args: unknown[]) => isTableImageRendererAvailableMock(...args),
  renderTableImage: (...args: unknown[]) => renderTableImageMock(...args),
}));

describe("deliverDiscordReply", () => {
  const runtime = {} as RuntimeEnv;

  const mockRest = {
    post: vi.fn().mockResolvedValue({ id: "msg-file", channel_id: "channel-1" }),
  };

  beforeEach(() => {
    sendMessageDiscordMock.mockReset().mockResolvedValue({
      messageId: "msg-1",
      channelId: "channel-1",
    });
    sendVoiceMessageDiscordMock.mockReset().mockResolvedValue({
      messageId: "voice-1",
      channelId: "channel-1",
    });
    isTableImageRendererAvailableMock.mockReset().mockResolvedValue(false);
    renderTableImageMock.mockReset().mockResolvedValue(null);
    mockRest.post.mockReset().mockResolvedValue({ id: "msg-file", channel_id: "channel-1" });
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

  describe("image table mode", () => {
    const TABLE_MD = "Here is a table:\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nDone.";

    it("renders tables as PNG when tableMode=image and renderer is available", async () => {
      isTableImageRendererAvailableMock.mockResolvedValue(true);
      renderTableImageMock.mockResolvedValue({
        png: Buffer.from("fake-png"),
        fileName: "table-1.png",
        fallbackMarkdown: "| A | B |\n|---|---|\n| 1 | 2 |",
      });

      await deliverDiscordReply({
        replies: [{ text: TABLE_MD }],
        target: "channel:100",
        token: "token",
        runtime,
        rest: mockRest as never,
        textLimit: 2000,
        tableMode: "image",
      });

      // Text segments sent via sendMessageDiscord
      expect(sendMessageDiscordMock).toHaveBeenCalled();
      // Table image sent via rest.post (file attachment)
      expect(mockRest.post).toHaveBeenCalledTimes(1);
      // renderTableImage was called with the table markdown
      expect(renderTableImageMock).toHaveBeenCalledWith(expect.stringContaining("| A | B |"), 0);
    });

    it("falls back to code tables when renderer is unavailable", async () => {
      isTableImageRendererAvailableMock.mockResolvedValue(false);

      await deliverDiscordReply({
        replies: [{ text: TABLE_MD }],
        target: "channel:100",
        token: "token",
        runtime,
        rest: mockRest as never,
        textLimit: 2000,
        tableMode: "image",
      });

      // Should fall through to standard text delivery (code mode fallback)
      expect(sendMessageDiscordMock).toHaveBeenCalled();
      // No file attachment sent
      expect(mockRest.post).not.toHaveBeenCalled();
    });

    it("falls back to text when renderTableImage returns null", async () => {
      isTableImageRendererAvailableMock.mockResolvedValue(true);
      renderTableImageMock.mockResolvedValue(null);

      await deliverDiscordReply({
        replies: [{ text: TABLE_MD }],
        target: "channel:100",
        token: "token",
        runtime,
        rest: mockRest as never,
        textLimit: 2000,
        tableMode: "image",
      });

      // No file attachment — renderer returned null for the table
      expect(mockRest.post).not.toHaveBeenCalled();
      // Text should still be sent (fallback)
      expect(sendMessageDiscordMock).toHaveBeenCalled();
    });

    it("uses standard text path when text has no tables even in image mode", async () => {
      isTableImageRendererAvailableMock.mockResolvedValue(true);

      await deliverDiscordReply({
        replies: [{ text: "No tables here" }],
        target: "channel:100",
        token: "token",
        runtime,
        rest: mockRest as never,
        textLimit: 2000,
        tableMode: "image",
      });

      // No image rendering attempted
      expect(renderTableImageMock).not.toHaveBeenCalled();
      expect(sendMessageDiscordMock).toHaveBeenCalledTimes(1);
    });
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
});
