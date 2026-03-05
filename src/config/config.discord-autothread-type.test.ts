import { describe, expect, it } from "vitest";
import type { DiscordGuildChannelConfig } from "./types.discord.js";

describe("discord guild channel type", () => {
  it("includes autoThread in DiscordGuildChannelConfig", () => {
    const channel: DiscordGuildChannelConfig = {
      requireMention: true,
      autoThread: true,
    };

    expect(channel.autoThread).toBe(true);
  });
});
