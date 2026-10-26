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
    for (const [cfg, channel, chatType, expected] of [
      [emptyCfg, "telegram", undefined, "all"],
      [emptyCfg, "discord", undefined, "all"],
      [emptyCfg, "slack", undefined, "all"],
      [emptyCfg, undefined, undefined, "all"],
      [configuredCfg, "telegram", undefined, "all"],
      [configuredCfg, "discord", undefined, "first"],
      [configuredCfg, "slack", undefined, "all"],
      [chatTypeCfg, "slack", "direct", "all"],
      [chatTypeCfg, "slack", "group", "first"],
      [chatTypeCfg, "slack", "channel", "off"],
      [chatTypeCfg, "slack", undefined, "off"],
      [topLevelFallbackCfg, "slack", "direct", "first"],
      [topLevelFallbackCfg, "slack", "channel", "first"],
    ] as const) {
      expect(resolveReplyToMode(cfg, channel, null, chatType)).toBe(expected);
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
  it.each(["first", "batched"] as const)(
    "preserves the %s answer target after reasoning only for declared targets",
    (mode) => {
      for (const supportsReasoningPayloads of [true, false, undefined]) {
        register({
          ...createChannelTestPluginBase({ id: "matrix" }),
          outbound: {
            deliveryMode: "direct",
            supportsReasoningPayloads,
          },
        });
        const filter = createReplyToModeFilterForChannel(mode, "matrix");
        const reasoning = { text: "quiet thought", isReasoning: true, replyToId: "parent" };
        expect(filter(reasoning).replyToId).toBe("parent");
        expect(filter({ text: "answer", replyToId: "parent" }).replyToId).toBe(
          supportsReasoningPayloads ? "parent" : undefined,
        );
        expect(filter({ text: "later answer", replyToId: "parent" }).replyToId).toBeUndefined();
      }
    },
  );

  it.each(["off", "all"] as const)(
    "preserves existing %s target and explicit-tag behavior for opted-in reasoning",
    (mode) => {
      register({
        ...createChannelTestPluginBase({ id: "matrix" }),
        outbound: { deliveryMode: "direct", supportsReasoningPayloads: true },
      });
      const filter = createReplyToModeFilterForChannel(mode, "matrix");
      const reason = { text: "thought", isReasoning: true, replyToId: "parent" };
      expect(filter(reason).replyToId).toBe(mode === "all" ? "parent" : undefined);
      expect(filter({ ...reason, replyToTag: true }).replyToId).toBe("parent");
      expect(filter({ text: "answer", replyToId: "parent" }).replyToId).toBe(
        mode === "all" ? "parent" : undefined,
      );
    },
  );

  it("previews batched transport without consuming its single reply slot", () => {
    const filter = createReplyToModeFilterForChannel("batched", "discord");
    expect(filter.preview({ text: "discarded", replyToId: "parent" }).replyToId).toBe("parent");
    expect(filter({ text: "actual", replyToId: "parent" }).replyToId).toBe("parent");
    expect(filter.preview({ text: "later", replyToId: "other" }).replyToId).toBeUndefined();
  });
});
