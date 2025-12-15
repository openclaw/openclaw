import { Routes } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { sendMessageDiscord } from "./send.js";

vi.mock("../web/media.js", () => ({
  loadWebMedia: vi.fn().mockResolvedValue({
    buffer: Buffer.from("img"),
    fileName: "photo.jpg",
    contentType: "image/jpeg",
    kind: "image",
  }),
}));

const makeRest = () => {
  const postMock = vi.fn();
  return {
    rest: {
      post: postMock,
    } as unknown as import("discord.js").REST,
    postMock,
  };
};

describe("sendMessageDiscord", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends basic channel messages", async () => {
    const { rest, postMock } = makeRest();
    postMock.mockResolvedValue({
      id: "msg1",
      channel_id: "789",
    });
    const res = await sendMessageDiscord("channel:789", "hello world", {
      rest,
      token: "t",
    });
    expect(res).toEqual({ messageId: "msg1", channelId: "789" });
    expect(postMock).toHaveBeenCalledWith(
      Routes.channelMessages("789"),
      expect.objectContaining({ body: { content: "hello world" } }),
    );
  });

  it("starts DM when recipient is a user", async () => {
    const { rest, postMock } = makeRest();
    postMock
      .mockResolvedValueOnce({ id: "chan1" })
      .mockResolvedValueOnce({ id: "msg1", channel_id: "chan1" });
    const res = await sendMessageDiscord("user:123", "hiya", {
      rest,
      token: "t",
    });
    expect(postMock).toHaveBeenNthCalledWith(
      1,
      Routes.userChannels(),
      expect.objectContaining({ body: { recipient_id: "123" } }),
    );
    expect(postMock).toHaveBeenNthCalledWith(
      2,
      Routes.channelMessages("chan1"),
      expect.objectContaining({ body: { content: "hiya" } }),
    );
    expect(res.channelId).toBe("chan1");
  });

  it("uploads media attachments", async () => {
    const { rest, postMock } = makeRest();
    postMock.mockResolvedValue({ id: "msg", channel_id: "789" });
    const res = await sendMessageDiscord("channel:789", "photo", {
      rest,
      token: "t",
      mediaUrl: "file:///tmp/photo.jpg",
    });
    expect(res.messageId).toBe("msg");
    expect(postMock).toHaveBeenCalledWith(
      Routes.channelMessages("789"),
      expect.objectContaining({
        files: [expect.objectContaining({ name: "photo.jpg" })],
      }),
    );
  });
});
