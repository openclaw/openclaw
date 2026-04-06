import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  resolveConfiguredReplyToMode,
  resolveReplyToMode,
  resolveReplyToModeWithThreading,
} from "./reply-threading.js";

const emptyCfg = {} as OpenClawConfig;

describe("resolveReplyToMode", () => {
  it("falls back to configured channel defaults when channel threading plugins are unavailable", () => {
    const configuredCfg = {
      channels: {
        telegram: { replyToMode: "all" },
        discord: { replyToMode: "first" },
        slack: { replyToMode: "all" },
      },
    } as OpenClawConfig;
    const chatTypeCfg = {
      channels: {
        slack: {
          replyToMode: "off",
          replyToModeByChatType: { direct: "all", group: "first" },
        },
      },
    } as OpenClawConfig;
    const topLevelFallbackCfg = {
      channels: {
        slack: {
          replyToMode: "first",
        },
      },
    } as OpenClawConfig;
    const legacyDmCfg = {
      channels: {
        slack: {
          replyToMode: "off",
          dm: { replyToMode: "all" },
        },
      },
    } as OpenClawConfig;

    const cases: Array<{
      cfg: OpenClawConfig;
      channel?: "telegram" | "discord" | "slack";
      chatType?: "direct" | "group" | "channel";
      expected: "off" | "all" | "first";
    }> = [
      { cfg: emptyCfg, channel: "telegram", expected: "all" },
      { cfg: emptyCfg, channel: "discord", expected: "all" },
      { cfg: emptyCfg, channel: "slack", expected: "all" },
      { cfg: emptyCfg, channel: undefined, expected: "all" },
      { cfg: configuredCfg, channel: "telegram", expected: "all" },
      { cfg: configuredCfg, channel: "discord", expected: "first" },
      { cfg: configuredCfg, channel: "slack", expected: "all" },
      { cfg: chatTypeCfg, channel: "slack", chatType: "direct", expected: "all" },
      { cfg: chatTypeCfg, channel: "slack", chatType: "group", expected: "first" },
      { cfg: chatTypeCfg, channel: "slack", chatType: "channel", expected: "off" },
      { cfg: chatTypeCfg, channel: "slack", chatType: undefined, expected: "off" },
      { cfg: topLevelFallbackCfg, channel: "slack", chatType: "direct", expected: "first" },
      { cfg: topLevelFallbackCfg, channel: "slack", chatType: "channel", expected: "first" },
      { cfg: legacyDmCfg, channel: "slack", chatType: "direct", expected: "all" },
      { cfg: legacyDmCfg, channel: "slack", chatType: "channel", expected: "off" },
    ];
    for (const testCase of cases) {
      expect(resolveReplyToMode(testCase.cfg, testCase.channel, null, testCase.chatType)).toBe(
        testCase.expected,
      );
    }
  });

  it("prefers plugin threading adapters over config fallback when available", () => {
    expect(
      resolveReplyToModeWithThreading(
        {
          channels: {
            slack: {
              replyToMode: "off",
            },
          },
        } as OpenClawConfig,
        {
          resolveReplyToMode: () => "first",
        },
        {
          channel: "slack",
          accountId: "acct-1",
          chatType: "direct",
        },
      ),
    ).toBe("first");
  });
});

describe("resolveConfiguredReplyToMode", () => {
  it("handles top-level, chat-type, and legacy DM fallback without plugin registry access", () => {
    const cfg = {
      channels: {
        slack: {
          replyToMode: "off",
          replyToModeByChatType: { direct: "all", group: "first" },
          dm: { replyToMode: "all" },
        },
      },
    } as OpenClawConfig;

    expect(resolveConfiguredReplyToMode(cfg, "slack", "direct")).toBe("all");
    expect(resolveConfiguredReplyToMode(cfg, "slack", "group")).toBe("first");
    expect(resolveConfiguredReplyToMode(cfg, "slack", "channel")).toBe("off");
    expect(resolveConfiguredReplyToMode(cfg, "slack", undefined)).toBe("off");
  });
});
