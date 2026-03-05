import { describe, expect, it } from "vitest";
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
