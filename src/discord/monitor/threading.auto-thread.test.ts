import { ChannelType } from "@buape/carbon";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { maybeCreateDiscordAutoThread } from "./threading.js";

describe("maybeCreateDiscordAutoThread", () => {
  const postMock = vi.fn();
  const getMock = vi.fn();
  const mockClient = {
    rest: { post: postMock, get: getMock },
  } as unknown as Parameters<typeof maybeCreateDiscordAutoThread>[0]["client"];
  const mockMessage = {
    id: "msg1",
    timestamp: "123",
  } as unknown as Parameters<typeof maybeCreateDiscordAutoThread>[0]["message"];

  it("skips auto-thread if channelType is GuildForum", async () => {
    const result = await maybeCreateDiscordAutoThread({
      client: mockClient,
      message: mockMessage,
      messageChannelId: "forum1",
      isGuildMessage: true,
      channelConfig: { allowed: true, autoThread: true },
      channelType: ChannelType.GuildForum,
      baseText: "test",
      combinedBody: "test",
    });
    expect(result).toBeUndefined();
    expect(postMock).not.toHaveBeenCalled();
  });

  it("skips auto-thread if channelType is GuildMedia", async () => {
    const result = await maybeCreateDiscordAutoThread({
      client: mockClient,
      message: mockMessage,
      messageChannelId: "media1",
      isGuildMessage: true,
      channelConfig: { allowed: true, autoThread: true },
      channelType: ChannelType.GuildMedia,
      baseText: "test",
      combinedBody: "test",
    });
    expect(result).toBeUndefined();
    expect(postMock).not.toHaveBeenCalled();
  });

  it("skips auto-thread if channelType is GuildVoice", async () => {
    const result = await maybeCreateDiscordAutoThread({
      client: mockClient,
      message: mockMessage,
      messageChannelId: "voice1",
      isGuildMessage: true,
      channelConfig: { allowed: true, autoThread: true },
      channelType: ChannelType.GuildVoice,
      baseText: "test",
      combinedBody: "test",
    });
    expect(result).toBeUndefined();
    expect(postMock).not.toHaveBeenCalled();
  });

  it("skips auto-thread if channelType is GuildStageVoice", async () => {
    const result = await maybeCreateDiscordAutoThread({
      client: mockClient,
      message: mockMessage,
      messageChannelId: "stage1",
      isGuildMessage: true,
      channelConfig: { allowed: true, autoThread: true },
      channelType: ChannelType.GuildStageVoice,
      baseText: "test",
      combinedBody: "test",
    });
    expect(result).toBeUndefined();
    expect(postMock).not.toHaveBeenCalled();
  });

  it("creates auto-thread if channelType is GuildText", async () => {
    postMock.mockResolvedValueOnce({ id: "thread1" });
    const result = await maybeCreateDiscordAutoThread({
      client: mockClient,
      message: mockMessage,
      messageChannelId: "text1",
      isGuildMessage: true,
      channelConfig: { allowed: true, autoThread: true },
      channelType: ChannelType.GuildText,
      baseText: "test",
      combinedBody: "test",
    });
    expect(result).toBe("thread1");
    expect(postMock).toHaveBeenCalled();
  });
});

describe("maybeCreateDiscordAutoThread autoArchiveDuration", () => {
  const postMock = vi.fn();
  const getMock = vi.fn();
  const mockClient = {
    rest: { post: postMock, get: getMock },
  } as unknown as Parameters<typeof maybeCreateDiscordAutoThread>[0]["client"];
  const mockMessage = {
    id: "msg1",
    timestamp: "123",
  } as unknown as Parameters<typeof maybeCreateDiscordAutoThread>[0]["message"];

  beforeEach(() => {
    postMock.mockReset();
    getMock.mockReset();
  });

  it("uses configured autoArchiveDuration", async () => {
    postMock.mockResolvedValueOnce({ id: "thread1" });
    await maybeCreateDiscordAutoThread({
      client: mockClient,
      message: mockMessage,
      messageChannelId: "text1",
      isGuildMessage: true,
      channelConfig: { allowed: true, autoThread: true, autoArchiveDuration: "10080" },
      channelType: ChannelType.GuildText,
      baseText: "test",
      combinedBody: "test",
    });
    expect(postMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ body: expect.objectContaining({ auto_archive_duration: 10080 }) }),
    );
  });

  it("accepts numeric autoArchiveDuration", async () => {
    postMock.mockResolvedValueOnce({ id: "thread1" });
    await maybeCreateDiscordAutoThread({
      client: mockClient,
      message: mockMessage,
      messageChannelId: "text1",
      isGuildMessage: true,
      channelConfig: { allowed: true, autoThread: true, autoArchiveDuration: 4320 },
      channelType: ChannelType.GuildText,
      baseText: "test",
      combinedBody: "test",
    });
    expect(postMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ body: expect.objectContaining({ auto_archive_duration: 4320 }) }),
    );
  });

  it("defaults to 60 when autoArchiveDuration not set", async () => {
    postMock.mockResolvedValueOnce({ id: "thread1" });
    await maybeCreateDiscordAutoThread({
      client: mockClient,
      message: mockMessage,
      messageChannelId: "text1",
      isGuildMessage: true,
      channelConfig: { allowed: true, autoThread: true },
      channelType: ChannelType.GuildText,
      baseText: "test",
      combinedBody: "test",
    });
    expect(postMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ body: expect.objectContaining({ auto_archive_duration: 60 }) }),
    );
  });
});
