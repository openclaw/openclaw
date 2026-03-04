import { Routes } from "discord-api-types/v10";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetDiscordDirectoryCacheForTest } from "./directory-cache.js";
import { sendMessageDiscord } from "./send.js";
import { makeDiscordRest } from "./send.test-harness.js";

vi.mock("../web/media.js", async () => {
  const { discordWebMediaMockFactory } = await import("./send.test-harness.js");
  return discordWebMediaMockFactory();
});

describe("sendMessageDiscord DM fallback on Unknown Channel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetDiscordDirectoryCacheForTest();
  });

  function unknownChannelError() {
    const err: Record<string, unknown> = new Error("Unknown Channel");
    err.code = 10003;
    return err;
  }

  it("retries as DM when channel:userId returns Unknown Channel (text)", async () => {
    const { rest, postMock } = makeDiscordRest();
    const userId = "111222333444555666";
    const dmChannelId = "dm-999888777";

    postMock
      .mockRejectedValueOnce(unknownChannelError())
      .mockResolvedValueOnce({ id: dmChannelId })
      .mockResolvedValueOnce({ id: "msg-1", channel_id: dmChannelId });

    const result = await sendMessageDiscord(`channel:${userId}`, "hello", {
      rest,
      token: "t",
    });

    expect(result.messageId).toBe("msg-1");
    expect(result.channelId).toBe(dmChannelId);

    expect(postMock).toHaveBeenCalledTimes(3);
    expect(postMock.mock.calls[0][0]).toBe(Routes.channelMessages(userId));
    expect(postMock.mock.calls[1][0]).toBe(Routes.userChannels());
    expect(
      (postMock.mock.calls[1][1] as { body: { recipient_id: string } }).body.recipient_id,
    ).toBe(userId);
    expect(postMock.mock.calls[2][0]).toBe(Routes.channelMessages(dmChannelId));
  });

  it("retries as DM when channel:userId returns Unknown Channel (media)", async () => {
    const { rest, postMock } = makeDiscordRest();
    const userId = "111222333444555666";
    const dmChannelId = "dm-999888777";

    postMock
      .mockRejectedValueOnce(unknownChannelError())
      .mockResolvedValueOnce({ id: dmChannelId })
      .mockResolvedValueOnce({ id: "msg-2", channel_id: dmChannelId });

    const result = await sendMessageDiscord(`channel:${userId}`, "file here", {
      rest,
      token: "t",
      mediaUrl: "https://example.com/test.pdf",
    });

    expect(result.messageId).toBe("msg-2");
    expect(result.channelId).toBe(dmChannelId);
    expect(postMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry when error is not Unknown Channel", async () => {
    const { rest, postMock } = makeDiscordRest();
    const permErr: Record<string, unknown> = new Error("Missing Permissions");
    permErr.code = 50013;

    postMock.mockRejectedValueOnce(permErr);

    await expect(
      sendMessageDiscord("channel:789", "hello", { rest, token: "t" }),
    ).rejects.toThrow();

    expect(postMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry for user: targets (already resolved)", async () => {
    const { rest, postMock } = makeDiscordRest();
    const dmChannelId = "dm-123";

    postMock
      .mockResolvedValueOnce({ id: dmChannelId })
      .mockResolvedValueOnce({ id: "msg-3", channel_id: dmChannelId });

    const result = await sendMessageDiscord("user:555", "hello", {
      rest,
      token: "t",
    });

    expect(result.messageId).toBe("msg-3");
    expect(postMock).toHaveBeenCalledTimes(2);
    expect(postMock.mock.calls[0][0]).toBe(Routes.userChannels());
  });

  it("does not retry for non-numeric channel IDs", async () => {
    const { rest, postMock } = makeDiscordRest();
    postMock.mockRejectedValueOnce(unknownChannelError());

    await expect(
      sendMessageDiscord("channel:not-numeric", "hello", { rest, token: "t" }),
    ).rejects.toThrow();

    expect(postMock).toHaveBeenCalledTimes(1);
  });
});
