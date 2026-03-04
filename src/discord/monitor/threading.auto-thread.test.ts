import { ChannelType } from "@buape/carbon";
import { describe, it, expect, vi, beforeEach } from "vitest";
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

  it("skips common abbreviations like Dr., Mr., etc.", () => {
    expect(extractFirstSentence("Dr. Smith is here. Call him now.")).toBe("Dr. Smith is here.");
    expect(extractFirstSentence("Mr. Jones and Mrs. Smith went home. They were tired.")).toBe(
      "Mr. Jones and Mrs. Smith went home.",
    );
    expect(
      extractFirstSentence("The U.S. government announced something. More details later."),
    ).toBe("The U.S. government announced something.");
  });

  it("handles punctuation before closing quotes and parens", () => {
    expect(extractFirstSentence('He said "Done." Then left.')).toBe('He said "Done."');
    expect(extractFirstSentence("(That's it.) Moving on.")).toBe("(That's it.)");
  });

  it("handles inline dots in domains and version numbers", () => {
    expect(extractFirstSentence("Check out example.com for details. It's great.")).toBe(
      "Check out example.com for details.",
    );
    expect(extractFirstSentence("Version 2.0 is here. Download now.")).toBe("Version 2.0 is here.");
    expect(extractFirstSentence("See docs.openclaw.io for help. Thanks.")).toBe(
      "See docs.openclaw.io for help.",
    );
  });
});

describe("maybeCreateDiscordAutoThread config integration", () => {
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

  it("applies first-sentence naming strategy when configured", async () => {
    postMock.mockResolvedValueOnce({ id: "thread1" });
    await maybeCreateDiscordAutoThread({
      client: mockClient,
      message: mockMessage,
      messageChannelId: "text1",
      isGuildMessage: true,
      channelConfig: { allowed: true, autoThread: true, autoThreadName: "first-sentence" },
      channelType: ChannelType.GuildText,
      baseText: "Hello world. This is extra text.",
      combinedBody: "",
    });
    expect(postMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ body: expect.objectContaining({ name: "Hello world." }) }),
    );
  });

  it("uses full message text when autoThreadName is 'message'", async () => {
    postMock.mockResolvedValueOnce({ id: "thread1" });
    await maybeCreateDiscordAutoThread({
      client: mockClient,
      message: mockMessage,
      messageChannelId: "text1",
      isGuildMessage: true,
      channelConfig: { allowed: true, autoThread: true, autoThreadName: "message" },
      channelType: ChannelType.GuildText,
      baseText: "Hello world. This is extra text.",
      combinedBody: "",
    });
    expect(postMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: expect.objectContaining({ name: "Hello world. This is extra text." }),
      }),
    );
  });

  it("uses configured autoThreadArchiveMin", async () => {
    postMock.mockResolvedValueOnce({ id: "thread1" });
    await maybeCreateDiscordAutoThread({
      client: mockClient,
      message: mockMessage,
      messageChannelId: "text1",
      isGuildMessage: true,
      channelConfig: { allowed: true, autoThread: true, autoThreadArchiveMin: "10080" },
      channelType: ChannelType.GuildText,
      baseText: "test",
      combinedBody: "test",
    });
    expect(postMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ body: expect.objectContaining({ auto_archive_duration: 10080 }) }),
    );
  });

  it("defaults to 60 minute archive when autoThreadArchiveMin not set", async () => {
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
