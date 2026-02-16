import { describe, it, expect, vi } from "vitest";
import { ChannelType } from "@buape/carbon";
import { maybeCreateDiscordAutoThread } from "./threading.js";

describe("maybeCreateDiscordAutoThread", () => {
  const mockClient = { rest: { post: vi.fn(), get: vi.fn() } } as any;
  const mockMessage = { id: "msg1", timestamp: "123" } as any;

  it("skips auto-thread if channelType is GuildForum", async () => {
    const result = await maybeCreateDiscordAutoThread({
      client: mockClient,
      message: mockMessage,
      messageChannelId: "forum1",
      isGuildMessage: true,
      channelConfig: { autoThread: true },
      channelType: ChannelType.GuildForum,
      baseText: "test",
      combinedBody: "test",
    });
    expect(result).toBeUndefined();
    expect(mockClient.rest.post).not.toHaveBeenCalled();
  });

  it("skips auto-thread if channelType is GuildMedia", async () => {
    const result = await maybeCreateDiscordAutoThread({
      client: mockClient,
      message: mockMessage,
      messageChannelId: "media1",
      isGuildMessage: true,
      channelConfig: { autoThread: true },
      channelType: ChannelType.GuildMedia,
      baseText: "test",
      combinedBody: "test",
    });
    expect(result).toBeUndefined();
    expect(mockClient.rest.post).not.toHaveBeenCalled();
  });

  it("creates auto-thread if channelType is GuildText", async () => {
    mockClient.rest.post.mockResolvedValueOnce({ id: "thread1" });
    const result = await maybeCreateDiscordAutoThread({
      client: mockClient,
      message: mockMessage,
      messageChannelId: "text1",
      isGuildMessage: true,
      channelConfig: { autoThread: true },
      channelType: ChannelType.GuildText,
      baseText: "test",
      combinedBody: "test",
    });
    expect(result).toBe("thread1");
    expect(mockClient.rest.post).toHaveBeenCalled();
  });
});
