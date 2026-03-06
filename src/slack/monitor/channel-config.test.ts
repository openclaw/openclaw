import { describe, expect, it } from "vitest";
import { SlackChannelSchema } from "../../config/zod-schema.providers-core.js";
import { resolveSlackChannelConfig } from "./channel-config.js";

describe("resolveSlackChannelConfig replyToMode fields", () => {
  it("returns replyToMode from exact channel match", () => {
    const result = resolveSlackChannelConfig({
      channelId: "C123",
      channels: { C123: { allow: true, replyToMode: "all" } },
    });
    expect(result?.replyToMode).toBe("all");
  });

  it("uses wildcard replyToMode as fallback", () => {
    const result = resolveSlackChannelConfig({
      channelId: "C999",
      channels: { "*": { allow: true, replyToMode: "first" } },
    });
    expect(result?.replyToMode).toBe("first");
  });

  it("channel-specific replyToMode overrides wildcard", () => {
    const result = resolveSlackChannelConfig({
      channelId: "C123",
      channels: {
        "*": { allow: true, replyToMode: "first" },
        C123: { allow: true, replyToMode: "all" },
      },
    });
    expect(result?.replyToMode).toBe("all");
  });

  it("returns undefined when replyToMode is not set", () => {
    const result = resolveSlackChannelConfig({
      channelId: "C123",
      channels: { C123: { allow: true } },
    });
    expect(result?.replyToMode).toBeUndefined();
  });
});

describe("SlackChannelSchema replyToMode field", () => {
  it("accepts valid replyToMode values", () => {
    for (const value of ["off", "first", "all"] as const) {
      const result = SlackChannelSchema.safeParse({ replyToMode: value });
      expect(result.success, `expected "${value}" to be valid`).toBe(true);
    }
  });

  it("rejects invalid replyToMode values", () => {
    for (const value of ["invalid", true, 123]) {
      const result = SlackChannelSchema.safeParse({ replyToMode: value });
      expect(result.success, `expected ${JSON.stringify(value)} to be invalid`).toBe(false);
    }
  });
});
