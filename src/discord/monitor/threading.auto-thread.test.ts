import { ChannelType } from "@buape/carbon";
import { describe, it, expect, vi } from "vitest";
import { maybeCreateDiscordAutoThread, extractFirstSentence } from "./threading.js";

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

describe("extractFirstSentence", () => {
  it("extracts first sentence ending with period", () => {
    expect(extractFirstSentence("Hello world. This is more text.")).toBe("Hello world.");
  });

  it("extracts first sentence ending with question mark", () => {
    expect(extractFirstSentence("Is this working? I hope so.")).toBe("Is this working?");
  });

  it("extracts first sentence ending with exclamation mark", () => {
    expect(extractFirstSentence("Hello! How are you?")).toBe("Hello!");
  });

  it("returns full text if no sentence ending found and under 50 chars", () => {
    expect(extractFirstSentence("Short text without ending")).toBe("Short text without ending");
  });

  it("truncates at word boundary if no sentence ending and over 50 chars", () => {
    const longText =
      "This is a very long piece of text that does not have any sentence ending punctuation";
    const result = extractFirstSentence(longText);
    expect(result.length).toBeLessThanOrEqual(50);
    expect(longText.startsWith(result)).toBe(true);
  });

  it("handles empty string", () => {
    expect(extractFirstSentence("")).toBe("");
  });

  it("handles whitespace-only string", () => {
    expect(extractFirstSentence("   ")).toBe("");
  });
});
