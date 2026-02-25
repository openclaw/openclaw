import { ChannelType, type Client } from "@buape/carbon";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetDiscordThreadStarterCacheForTest,
  resolveDiscordThreadStarter,
} from "./threading.js";

describe("resolveDiscordThreadStarter", () => {
  beforeEach(() => {
    __resetDiscordThreadStarterCacheForTest();
  });

  it("falls back to joined embed title and description when content is empty", async () => {
    const get = vi.fn().mockResolvedValue({
      content: "   ",
      embeds: [{ title: "Alert", description: "Details" }],
      author: { username: "Alice", discriminator: "0" },
      timestamp: "2026-02-24T12:00:00.000Z",
    });
    const client = { rest: { get } } as unknown as Client;

    const result = await resolveDiscordThreadStarter({
      channel: { id: "thread-1" },
      client,
      parentId: "parent-1",
      parentType: ChannelType.GuildText,
      resolveTimestampMs: () => 123,
    });

    expect(result).toEqual({
      text: "Alert\nDetails",
      author: "Alice",
      timestamp: 123,
    });
  });

  it("prefers starter content over embed fallback text", async () => {
    const get = vi.fn().mockResolvedValue({
      content: "starter content",
      embeds: [{ title: "Alert", description: "Details" }],
      author: { username: "Alice", discriminator: "0" },
    });
    const client = { rest: { get } } as unknown as Client;

    const result = await resolveDiscordThreadStarter({
      channel: { id: "thread-1" },
      client,
      parentId: "parent-1",
      parentType: ChannelType.GuildText,
      resolveTimestampMs: () => undefined,
    });

    expect(result?.text).toBe("starter content");
  });
});
