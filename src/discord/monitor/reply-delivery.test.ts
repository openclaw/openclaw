import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../../runtime.js";
import { deliverDiscordReply } from "./reply-delivery.js";

const sendMessageDiscordMock = vi.hoisted(() => vi.fn());
const sendVoiceMessageDiscordMock = vi.hoisted(() => vi.fn());

vi.mock("../send.js", () => ({
  sendMessageDiscord: (...args: unknown[]) => sendMessageDiscordMock(...args),
  sendVoiceMessageDiscord: (...args: unknown[]) => sendVoiceMessageDiscordMock(...args),
}));

const renderTableImageMock = vi.hoisted(() => vi.fn());

vi.mock("../../media/table-image.js", () => ({
  renderTableImage: (...args: unknown[]) => renderTableImageMock(...args),
}));

describe("deliverDiscordReply", () => {
  const runtime = {} as RuntimeEnv;
  const mockRest = {
    post: vi.fn().mockResolvedValue({ id: "msg-file", channel_id: "channel-1" }),
  };

  beforeEach(() => {
    sendMessageDiscordMock.mockReset().mockResolvedValue({ messageId: "msg-1", channelId: "c-1" });
    sendVoiceMessageDiscordMock
      .mockReset()
      .mockResolvedValue({ messageId: "v-1", channelId: "c-1" });
    renderTableImageMock.mockReset().mockResolvedValue(null);
    mockRest.post.mockReset().mockResolvedValue({ id: "msg-file", channel_id: "channel-1" });
  });

  it("routes audioAsVoice payloads through voice API and sends text separately", async () => {
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
    expect(sendMessageDiscordMock).toHaveBeenCalledTimes(2); // text + extra media
  });

  describe("image table mode", () => {
    const TABLE_MD = "Here is a table:\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nDone.";

    it("renders tables as PNG when tableMode=image", async () => {
      renderTableImageMock.mockResolvedValue(Buffer.from("fake-png"));

      await deliverDiscordReply({
        replies: [{ text: TABLE_MD }],
        target: "channel:100",
        token: "token",
        runtime,
        rest: mockRest as never,
        textLimit: 2000,
        tableMode: "image",
      });

      expect(sendMessageDiscordMock).toHaveBeenCalled(); // text segments
      expect(mockRest.post).toHaveBeenCalledTimes(1); // table image
      expect(renderTableImageMock).toHaveBeenCalledWith(expect.stringContaining("| A | B |"));
    });

    it("falls back to text when renderer returns null", async () => {
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

      expect(mockRest.post).not.toHaveBeenCalled();
      expect(sendMessageDiscordMock).toHaveBeenCalled();
    });

    it("uses standard text path when no tables present", async () => {
      await deliverDiscordReply({
        replies: [{ text: "No tables here" }],
        target: "channel:100",
        token: "token",
        runtime,
        rest: mockRest as never,
        textLimit: 2000,
        tableMode: "image",
      });

      expect(renderTableImageMock).not.toHaveBeenCalled();
      expect(sendMessageDiscordMock).toHaveBeenCalledTimes(1);
    });
  });
});
