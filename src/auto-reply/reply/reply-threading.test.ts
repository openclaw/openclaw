import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import {
  createReplyToModeFilterForChannel,
  resolveReplyDeliveryAccountId,
  resolveReplyToMode,
} from "./reply-threading.js";

const emptyCfg: OpenClawConfig = {};
const resetRegistry = () => setActivePluginRegistry(createTestRegistry());
beforeEach(resetRegistry);
afterEach(resetRegistry);
function register(plugin: ChannelPlugin) {
  setActivePluginRegistry(createTestRegistry([{ pluginId: plugin.id, source: "test", plugin }]));
}

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
    const topLevelFallbackCfg: OpenClawConfig = { channels: { slack: { replyToMode: "first" } } };
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
    ];
    for (const testCase of cases) {
      expect(resolveReplyToMode(testCase.cfg, testCase.channel, null, testCase.chatType)).toBe(
        testCase.expected,
      );
    }
  });

  it("uses registered channel threading adapters for runtime reply-mode resolution", () => {
    register({
      ...createChannelTestPluginBase({
        id: "whatsapp",
      }),
      threading: {
        resolveReplyToMode: ({ accountId }) => (accountId === "work" ? "first" : "all"),
      },
    });

    expect(resolveReplyToMode(emptyCfg, "whatsapp", "work", "group")).toBe("first");
    expect(resolveReplyToMode(emptyCfg, "whatsapp", "default", "group")).toBe("all");
  });

  it("resolves the same listed default account used by routed delivery", () => {
    register(
      createChannelTestPluginBase({
        id: "whatsapp",
        config: { listAccountIds: () => ["work"] },
      }),
    );

    expect(resolveReplyDeliveryAccountId(emptyCfg, "whatsapp")).toBe("work");
    expect(resolveReplyDeliveryAccountId(emptyCfg, "whatsapp", "personal")).toBe("personal");
  });

  it("applies canonical account policy before channel-wide threading defaults", () => {
    register(createChannelTestPluginBase({ id: "irc" }));
    const cfg: OpenClawConfig = {
      channels: {
        irc: {
          replyToMode: "off",
          accounts: {
            "Ops Team": { replyToMode: "all" },
            support: { replyToMode: "first" },
          },
        },
      },
    };

    expect(resolveReplyToMode(cfg, "irc", "ops-team", "group")).toBe("all");
    expect(resolveReplyToMode(cfg, "irc", "OPS TEAM", "direct")).toBe("all");
    expect(resolveReplyToMode(cfg, "irc", "support", "group")).toBe("first");
    expect(resolveReplyToMode(cfg, "irc", "unknown", "group")).toBe("off");
    expect(resolveReplyToMode(cfg, "irc", null, "direct")).toBe("off");
  });
});

describe("createReplyToModeFilterForChannel", () => {
  it("previews batched transport without consuming its single reply slot", () => {
    const filter = createReplyToModeFilterForChannel("batched", "discord");
    expect(filter.preview({ text: "discarded", replyToId: "parent" }).replyToId).toBe("parent");
    expect(filter({ text: "actual", replyToId: "parent" }).replyToId).toBe("parent");
    expect(filter.preview({ text: "later", replyToId: "other" }).replyToId).toBeUndefined();
  });
});
