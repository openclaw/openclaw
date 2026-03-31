import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveChannelThinkingOverride } from "./thinking-overrides.js";

describe("resolveChannelThinkingOverride", () => {
  it("returns null when no thinkingByChannel configured", () => {
    const result = resolveChannelThinkingOverride({
      cfg: { channels: {} } as unknown as OpenClawConfig,
      channel: "discord",
      groupId: "123",
    });
    expect(result).toBeNull();
  });

  it("returns null when channel is empty", () => {
    const result = resolveChannelThinkingOverride({
      cfg: {
        channels: {
          thinkingByChannel: { discord: { "123": "off" } },
        },
      } as unknown as OpenClawConfig,
      channel: "",
    });
    expect(result).toBeNull();
  });

  it("returns null when channel provider has no entries", () => {
    const result = resolveChannelThinkingOverride({
      cfg: {
        channels: {
          thinkingByChannel: { telegram: { "123": "off" } },
        },
      } as unknown as OpenClawConfig,
      channel: "discord",
      groupId: "456",
    });
    expect(result).toBeNull();
  });

  it("matches by group id", () => {
    const result = resolveChannelThinkingOverride({
      cfg: {
        channels: {
          thinkingByChannel: {
            discord: { "1488556514485735486": "off", "*": "high" },
          },
        },
      } as unknown as OpenClawConfig,
      channel: "discord",
      groupId: "1488556514485735486",
    });
    expect(result).toEqual({
      channel: "discord",
      thinking: "off",
      matchKey: "1488556514485735486",
      matchSource: "direct",
    });
  });

  it("falls back to wildcard when group id does not match", () => {
    const result = resolveChannelThinkingOverride({
      cfg: {
        channels: {
          thinkingByChannel: {
            discord: { "1488556514485735486": "off", "*": "high" },
          },
        },
      } as unknown as OpenClawConfig,
      channel: "discord",
      groupId: "999999999999999999",
    });
    expect(result).toEqual({
      channel: "discord",
      thinking: "high",
      matchKey: "*",
      matchSource: "wildcard",
    });
  });

  it("returns null when no match and no wildcard", () => {
    const result = resolveChannelThinkingOverride({
      cfg: {
        channels: {
          thinkingByChannel: {
            discord: { "1488556514485735486": "off" },
          },
        },
      } as unknown as OpenClawConfig,
      channel: "discord",
      groupId: "999999999999999999",
    });
    expect(result).toBeNull();
  });

  it("normalizes thinking level values", () => {
    const result = resolveChannelThinkingOverride({
      cfg: {
        channels: {
          thinkingByChannel: {
            discord: { "123": "adaptive" },
          },
        },
      } as unknown as OpenClawConfig,
      channel: "discord",
      groupId: "123",
    });
    expect(result?.thinking).toBe("adaptive");
  });

  it("returns null for invalid thinking level", () => {
    const result = resolveChannelThinkingOverride({
      cfg: {
        channels: {
          thinkingByChannel: {
            discord: { "123": "invalid-level" },
          },
        },
      } as unknown as OpenClawConfig,
      channel: "discord",
      groupId: "123",
    });
    expect(result).toBeNull();
  });

  it.each([
    {
      name: "matches parent group id when topic suffix is present",
      input: {
        cfg: {
          channels: {
            thinkingByChannel: {
              telegram: { "-100123": "low" },
            },
          },
        } as unknown as OpenClawConfig,
        channel: "telegram",
        groupId: "-100123:topic:99",
      },
      expected: { thinking: "low", matchKey: "-100123" },
    },
    {
      name: "prefers topic-specific match over parent group id",
      input: {
        cfg: {
          channels: {
            thinkingByChannel: {
              telegram: {
                "-100123": "low",
                "-100123:topic:99": "high",
              },
            },
          },
        } as unknown as OpenClawConfig,
        channel: "telegram",
        groupId: "-100123:topic:99",
      },
      expected: { thinking: "high", matchKey: "-100123:topic:99" },
    },
  ] as const)("$name", ({ input, expected }) => {
    const resolved = resolveChannelThinkingOverride(input);
    expect(resolved?.thinking).toBe(expected.thinking);
    expect(resolved?.matchKey).toBe(expected.matchKey);
  });
});
