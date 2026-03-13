import { ChannelType } from "@buape/carbon";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { maybeCreateDiscordAutoThread } from "./threading.js";

const postMock = vi.fn();
const getMock = vi.fn();
const mockClient = {
  rest: { post: postMock, get: getMock },
} as unknown as Parameters<typeof maybeCreateDiscordAutoThread>[0]["client"];
const mockMessage = {
  id: "msg1",
  timestamp: "123",
} as unknown as Parameters<typeof maybeCreateDiscordAutoThread>[0]["message"];

async function runAutoThread(
  overrides: Partial<Parameters<typeof maybeCreateDiscordAutoThread>[0]> = {},
) {
  return maybeCreateDiscordAutoThread({
    client: mockClient,
    message: mockMessage,
    messageChannelId: "text1",
    isGuildMessage: true,
    channelConfig: { allowed: true, autoThread: true },
    channelType: ChannelType.GuildText,
    baseText: "test",
    combinedBody: "test",
    ...overrides,
  });
}

function expectAutoArchiveDuration(autoArchiveDuration: number) {
  expect(postMock).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      body: expect.objectContaining({ auto_archive_duration: autoArchiveDuration }),
    }),
  );
}

describe("maybeCreateDiscordAutoThread", () => {
  beforeEach(() => {
    postMock.mockReset();
    getMock.mockReset();
  });

  it("skips auto-thread if channelType is GuildForum", async () => {
    const result = await runAutoThread({
      messageChannelId: "forum1",
      channelType: ChannelType.GuildForum,
    });
    expect(result).toBeUndefined();
    expect(postMock).not.toHaveBeenCalled();
  });

  it("skips auto-thread if channelType is GuildMedia", async () => {
    const result = await runAutoThread({
      messageChannelId: "media1",
      channelType: ChannelType.GuildMedia,
    });
    expect(result).toBeUndefined();
    expect(postMock).not.toHaveBeenCalled();
  });

  it("skips auto-thread if channelType is GuildVoice", async () => {
    const result = await runAutoThread({
      messageChannelId: "voice1",
      channelType: ChannelType.GuildVoice,
    });
    expect(result).toBeUndefined();
    expect(postMock).not.toHaveBeenCalled();
  });

  it("skips auto-thread if channelType is GuildStageVoice", async () => {
    const result = await runAutoThread({
      messageChannelId: "stage1",
      channelType: ChannelType.GuildStageVoice,
    });
    expect(result).toBeUndefined();
    expect(postMock).not.toHaveBeenCalled();
  });

  it("creates auto-thread if channelType is GuildText", async () => {
    postMock.mockResolvedValueOnce({ id: "thread1" });
    const result = await runAutoThread();
    expect(result).toBe("thread1");
    expect(postMock).toHaveBeenCalled();
  });
});

describe("maybeCreateDiscordAutoThread autoArchiveDuration", () => {
  beforeEach(() => {
    postMock.mockReset();
    getMock.mockReset();
  });

  it("uses configured autoArchiveDuration", async () => {
    postMock.mockResolvedValueOnce({ id: "thread1" });
    await runAutoThread({
      channelConfig: { allowed: true, autoThread: true, autoArchiveDuration: "10080" },
    });
    expectAutoArchiveDuration(10080);
  });

  it("accepts numeric autoArchiveDuration", async () => {
    postMock.mockResolvedValueOnce({ id: "thread1" });
    await runAutoThread({
      channelConfig: { allowed: true, autoThread: true, autoArchiveDuration: 4320 },
    });
    expectAutoArchiveDuration(4320);
  });

  it("defaults to 60 when autoArchiveDuration not set", async () => {
    postMock.mockResolvedValueOnce({ id: "thread1" });
    await runAutoThread();
    expectAutoArchiveDuration(60);
  });
});
