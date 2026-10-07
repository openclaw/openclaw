import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { createMessageReceiptFromOutboundResults } from "../../channels/message/receipt.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import { createReplyToDeliveryPolicy } from "../../infra/outbound/reply-policy.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { applyReplyThreading } from "./reply-payloads-base.js";
import { routeReply } from "./route-reply.js";

const { sendDurableMessageBatchCore, sendStructuredDurableMessageBatchCore } = vi.hoisted(() => ({
  sendDurableMessageBatchCore:
    vi.fn<typeof import("../../channels/message/runtime.js").sendDurableMessageBatchCore>(),
  sendStructuredDurableMessageBatchCore:
    vi.fn<
      typeof import("../../channels/message/runtime.js").sendStructuredDurableMessageBatchCore
    >(),
}));

// Exercise the real router and registered plugin without sending native messages.
vi.mock("../../channels/message/runtime.js", () => ({
  sendDurableMessageBatchCore,
  sendStructuredDurableMessageBatchCore,
  durableMessageBatchMayHaveReachedRecipient: () => false,
}));

const { imessagePlugin } = await loadBundledPluginFacade<{ imessagePlugin: ChannelPlugin }>({
  pluginId: "imessage",
  artifactBasename: "channel-plugin-api.ts",
});

const cfg: OpenClawConfig = {
  channels: { imessage: { enabled: true, actions: { reply: true } } },
};

type RouteReplyParams = Parameters<typeof routeReply>[0];

async function route(
  payload: RouteReplyParams["payload"],
  currentMessageId?: string,
  overrides: Partial<RouteReplyParams> = {},
) {
  const result = await routeReply({
    cfg,
    payload,
    currentMessageId,
    channel: "imessage",
    accountId: "default",
    to: "chat_id:123",
    agentId: "main",
    replyKind: "final",
    mirror: false,
    replyDelivery: { chatType: "direct", replyToMode: "all" },
    ...overrides,
  });
  expect(result).toMatchObject({ ok: true, delivered: true });
  return sendDurableMessageBatchCore.mock.lastCall?.[0];
}

describe("routed iMessage reply threading", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "imessage", plugin: imessagePlugin, source: "test" }]),
    );
    sendDurableMessageBatchCore.mockReset();
    const results = [{ channel: "imessage", messageId: "sent-message" }];
    sendDurableMessageBatchCore.mockResolvedValue({
      status: "sent",
      results,
      receipt: createMessageReceiptFromOutboundResults({ results }),
    });
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry());
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
    expect(sendDurableMessageBatchCore).toHaveBeenCalledTimes(2);
    expect(sendDurableMessageBatchCore.mock.calls.map(([send]) => send.replyToId)).toEqual(ids);
    expect(
      sendDurableMessageBatchCore.mock.calls.map(([send]) => send.payloads[0]?.replyToId),
    ).toEqual([ids[0], undefined]);
  });

  it.each([
    { mode: "first", expected: ["question-guid", undefined, undefined] },
    { mode: "all", expected: ["question-guid", "question-guid", "question-guid"] },
  ] as const)(
    "preserves $mode consumption at the delivery boundary",
    async ({ mode, expected }) => {
      const sent = await route({ text: "Answer" }, "question-guid", {
        replyDelivery: { chatType: "direct", replyToMode: mode },
      });
      assert(sent);
      assert(sent.payloads[0]);
      expect(sent.replyToId).toBe("question-guid");
      expect(sent.payloads[0].replyToId).toBeUndefined();
      expect(sent.replyToMode).toBe(mode);
      const policy = createReplyToDeliveryPolicy(sent);
      const resolved = policy.resolveCurrentReplyTo(sent.payloads[0]);
      expect(resolved).toEqual({
        replyToId: "question-guid",
        source: "implicit",
      });
      expect(
        [1, 2, 3].map(
          () =>
            policy.applyReplyToConsumption({
              replyToId: resolved.replyToId,
              replyToIdSource: resolved.source,
            }).replyToId,
        ),
      ).toEqual(expected);
    },
  );
});
