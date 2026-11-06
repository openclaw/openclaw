import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { createMessageReceiptFromOutboundResults } from "../../channels/message/receipt.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import { createReplyToDeliveryPolicy } from "../../infra/outbound/reply-policy.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { applyReplyThreading } from "./reply-payloads-base.js";
import {
  createReplyToModeFilterForChannel,
  resolveReplyDeliveryAccountId,
  resolveReplyToMode,
} from "./reply-threading.js";
import { routeReply } from "./route-reply.js";

const emptyCfg: OpenClawConfig = {};
const resetRegistry = () => setActivePluginRegistry(createTestRegistry());
beforeEach(resetRegistry);
afterEach(resetPluginRuntimeStateForTest);
function register(plugin: ChannelPlugin) {
  setActivePluginRegistry(createTestRegistry([{ pluginId: plugin.id, source: "test", plugin }]));
}

describe("resolveReplyToMode", () => {
  it("falls back to configured channel defaults when channel threading plugins are unavailable", () => {
    const configuredCfg: OpenClawConfig = { channels: { discord: { replyToMode: "first" } } };
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
      [emptyCfg, undefined, undefined, "all"],
      [configuredCfg, "discord", undefined, "first"],
      [chatTypeCfg, "slack", "direct", "all"],
      [chatTypeCfg, "slack", "group", "first"],
      [chatTypeCfg, "slack", "channel", "off"],
      [chatTypeCfg, "slack", undefined, "off"],
      [topLevelFallbackCfg, "slack", "direct", "first"],
    ] as const) {
      expect(resolveReplyToMode(cfg, channel, null, chatType)).toBe(expected);
    }
  });

  it("uses registered channel threading adapters for runtime reply-mode resolution", () => {
    register({
      ...createChannelTestPluginBase({ id: "whatsapp" }),
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

const { sendDurableMessageBatchCore, sendStructuredDurableMessageBatchCore } = vi.hoisted(() => ({
  sendDurableMessageBatchCore:
    vi.fn<typeof import("../../channels/message/runtime.js").sendDurableMessageBatchCore>(),
  sendStructuredDurableMessageBatchCore:
    vi.fn<
      typeof import("../../channels/message/runtime.js").sendStructuredDurableMessageBatchCore
    >(),
}));

vi.mock("../../channels/message/runtime.js", () => ({
  sendDurableMessageBatchCore,
  sendStructuredDurableMessageBatchCore,
  durableMessageBatchMayHaveReachedRecipient: () => false,
}));

const { imessagePlugin } = await loadBundledPluginFacade<{ imessagePlugin: ChannelPlugin }>({
  pluginId: "imessage",
  artifactBasename: "channel-plugin-api.ts",
});

type RouteReplyParams = Parameters<typeof routeReply>[0];

async function route(
  payload: RouteReplyParams["payload"],
  currentMessageId?: string,
  replyToMode: "first" | "all" = "all",
) {
  const result = await routeReply({
    cfg: { channels: { imessage: { enabled: true, actions: { reply: true } } } },
    payload,
    currentMessageId,
    channel: "imessage",
    accountId: "default",
    to: "chat_id:123",
    agentId: "main",
    replyKind: "final",
    mirror: false,
    replyDelivery: { chatType: "direct", replyToMode },
  });
  expect(result).toMatchObject({ ok: true, delivered: true });
  return sendDurableMessageBatchCore.mock.lastCall?.[0];
}

describe("routed iMessage reply threading", () => {
  beforeEach(() => {
    register(imessagePlugin);
    sendDurableMessageBatchCore.mockReset();
    const results = [{ channel: "imessage", messageId: "sent-message" }];
    sendDurableMessageBatchCore.mockResolvedValue({
      status: "sent",
      results,
      receipt: createMessageReceiptFromOutboundResults({ results }),
    });
  });

  it("keeps the initial answer and queued answers attached to their own questions", async () => {
    const ids = ["weather-question", "mets-question"];
    const [initial] = applyReplyThreading({
      payloads: [{ text: "Weather answer" }],
      currentMessageId: ids[0],
      replyToMode: "all",
      replyToChannel: "imessage",
    });
    assert(initial);
    await route(initial, ids[0]);
    await route({ text: "Mets answer" }, ids[1]);
    expect(sendDurableMessageBatchCore.mock.calls.map(([send]) => send.replyToId)).toEqual(ids);
    expect(
      sendDurableMessageBatchCore.mock.calls.map(([send]) => send.payloads[0]?.replyToId),
    ).toEqual([ids[0], undefined]);
  });

  it.each(["first", "all"] as const)(
    "preserves %s policy at the delivery boundary",
    async (mode) => {
      const sent = await route({ text: "Answer" }, "question-guid", mode);
      assert(sent);
      expect(sent).toMatchObject({
        replyToId: "question-guid",
        replyToMode: mode,
        payloads: [{ replyToId: undefined }],
      });
      const policy = createReplyToDeliveryPolicy(sent);
      const resolved = policy.resolveCurrentReplyTo(sent.payloads[0]!);
      expect(resolved).toEqual({ replyToId: "question-guid", source: "implicit" });
      const target = { replyToId: resolved.replyToId, replyToIdSource: resolved.source };
      expect([1, 2, 3].map(() => policy.applyReplyToConsumption(target).replyToId)).toEqual(
        mode === "all" ? Array(3).fill("question-guid") : ["question-guid", undefined, undefined],
      );
    },
  );
});
