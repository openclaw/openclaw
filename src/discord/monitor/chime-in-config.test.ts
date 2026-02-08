import { describe, expect, it } from "vitest";
import type { DiscordChannelConfigResolved, DiscordGuildEntryResolved } from "./allow-list.js";
import {
  DiscordGuildSchema,
  DiscordGuildChannelSchema,
} from "../../config/zod-schema.providers-core.js";
import { resolveDiscordChimeIn } from "./allow-list.js";

describe("ChimeIn Zod schema validation", () => {
  describe("DiscordGuildSchema", () => {
    it("accepts valid chimeIn config with every", () => {
      const result = DiscordGuildSchema.safeParse({ chimeIn: { every: 5 } });
      expect(result.success).toBe(true);
    });

    it("accepts valid chimeIn with prompt and model", () => {
      const result = DiscordGuildSchema.safeParse({
        chimeIn: { every: 3, prompt: "Should I chime in?", model: "anthropic/haiku" },
      });
      expect(result.success).toBe(true);
    });

    it("accepts chimeIn with every = 2 (minimum)", () => {
      const result = DiscordGuildSchema.safeParse({ chimeIn: { every: 2 } });
      expect(result.success).toBe(true);
    });

    it("rejects every < 2", () => {
      const result = DiscordGuildSchema.safeParse({ chimeIn: { every: 1 } });
      expect(result.success).toBe(false);
    });

    it("rejects every = 0", () => {
      const result = DiscordGuildSchema.safeParse({ chimeIn: { every: 0 } });
      expect(result.success).toBe(false);
    });

    it("rejects non-integer every", () => {
      const result = DiscordGuildSchema.safeParse({ chimeIn: { every: 2.5 } });
      expect(result.success).toBe(false);
    });

    it("rejects negative every", () => {
      const result = DiscordGuildSchema.safeParse({ chimeIn: { every: -1 } });
      expect(result.success).toBe(false);
    });

    it("accepts guild without chimeIn", () => {
      const result = DiscordGuildSchema.safeParse({ requireMention: true });
      expect(result.success).toBe(true);
    });

    it("rejects unknown fields in chimeIn (strict)", () => {
      const result = DiscordGuildSchema.safeParse({
        chimeIn: { every: 5, unknown: true },
      });
      expect(result.success).toBe(false);
    });
  });

  describe("DiscordGuildChannelSchema", () => {
    it("accepts valid chimeIn config", () => {
      const result = DiscordGuildChannelSchema.safeParse({ chimeIn: { every: 4 } });
      expect(result.success).toBe(true);
    });

    it("accepts chimeIn with prompt and model", () => {
      const result = DiscordGuildChannelSchema.safeParse({
        chimeIn: { every: 10, prompt: "custom", model: "openai/gpt-4o-mini" },
      });
      expect(result.success).toBe(true);
    });

    it("rejects every < 2 on channel schema", () => {
      const result = DiscordGuildChannelSchema.safeParse({ chimeIn: { every: 1 } });
      expect(result.success).toBe(false);
    });

    it("rejects non-integer every on channel schema", () => {
      const result = DiscordGuildChannelSchema.safeParse({ chimeIn: { every: 3.7 } });
      expect(result.success).toBe(false);
    });

    it("accepts channel without chimeIn", () => {
      const result = DiscordGuildChannelSchema.safeParse({ allow: true });
      expect(result.success).toBe(true);
    });
  });
});

describe("resolveDiscordChimeIn", () => {
  it("returns null for non-guild messages", () => {
    const result = resolveDiscordChimeIn({
      isGuildMessage: false,
      channelConfig: { allowed: true, chimeIn: { every: 5 } },
      guildInfo: { chimeIn: { every: 10 } },
    });
    expect(result).toBeNull();
  });

  it("returns guild-level config when channel has no chimeIn", () => {
    const guildInfo: DiscordGuildEntryResolved = { chimeIn: { every: 7 } };
    const channelConfig: DiscordChannelConfigResolved = { allowed: true };

    const result = resolveDiscordChimeIn({
      isGuildMessage: true,
      channelConfig,
      guildInfo,
    });
    expect(result).toEqual({ every: 7 });
  });

  it("channel chimeIn overrides guild chimeIn", () => {
    const guildInfo: DiscordGuildEntryResolved = { chimeIn: { every: 10 } };
    const channelConfig: DiscordChannelConfigResolved = {
      allowed: true,
      chimeIn: { every: 3, prompt: "channel-level" },
    };

    const result = resolveDiscordChimeIn({
      isGuildMessage: true,
      channelConfig,
      guildInfo,
    });
    expect(result).toEqual({ every: 3, prompt: "channel-level" });
  });

  it("returns null when neither guild nor channel has chimeIn", () => {
    const result = resolveDiscordChimeIn({
      isGuildMessage: true,
      channelConfig: { allowed: true },
      guildInfo: {},
    });
    expect(result).toBeNull();
  });

  it("returns null when guildInfo is null", () => {
    const result = resolveDiscordChimeIn({
      isGuildMessage: true,
      channelConfig: null,
      guildInfo: null,
    });
    expect(result).toBeNull();
  });

  it("returns guild chimeIn when channelConfig is null", () => {
    const result = resolveDiscordChimeIn({
      isGuildMessage: true,
      channelConfig: null,
      guildInfo: { chimeIn: { every: 5, model: "anthropic/haiku" } },
    });
    expect(result).toEqual({ every: 5, model: "anthropic/haiku" });
  });

  it("returns guild chimeIn when channelConfig is undefined", () => {
    const result = resolveDiscordChimeIn({
      isGuildMessage: true,
      channelConfig: undefined,
      guildInfo: { chimeIn: { every: 4 } },
    });
    expect(result).toEqual({ every: 4 });
  });
});
