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
    { mode: "first", explicit: false, expected: ["question-guid", undefined, undefined] },
    { mode: "all", explicit: false, expected: ["question-guid", "question-guid", "question-guid"] },
    { mode: "off", explicit: true, expected: ["question-guid", "question-guid", "question-guid"] },
  ] as const)(
    "preserves $mode consumption at the delivery boundary (explicit=$explicit)",
    async ({ mode, explicit, expected }) => {
      const sent = await route(
        { text: "Answer", ...(explicit ? { replyToCurrent: true } : {}) },
        "question-guid",
        { replyDelivery: { chatType: "direct", replyToMode: mode } },
      );
      assert(sent);
      assert(sent.payloads[0]);
      expect(sent.replyToId).toBe("question-guid");
      expect(sent.payloads[0].replyToId).toBe(explicit ? "question-guid" : undefined);
      if (!explicit) {
        expect(sent.replyToMode).toBe(mode);
      }
      const policy = createReplyToDeliveryPolicy(sent);
      const resolved = policy.resolveCurrentReplyTo(sent.payloads[0]);
      expect(resolved).toEqual({
        replyToId: "question-guid",
        source: explicit ? "explicit" : "implicit",
      });
      expect(
        [1, 2, 3].map(
          () =>
            policy.applyReplyToConsumption(
              { replyToId: resolved.replyToId, replyToIdSource: resolved.source },
              { consumeImplicitReply: resolved.source === "implicit" },
            ).replyToId,
        ),
      ).toEqual(expected);
    },
  );

  type TargetCase = {
    name: string;
    payload?: RouteReplyParams["payload"];
    current?: string | null;
    overrides?: Partial<RouteReplyParams>;
    target?: string;
    payloadTarget?: string;
  };
  const accountConfig = (
    imessage: NonNullable<OpenClawConfig["channels"]>["imessage"],
  ): Partial<RouteReplyParams> => ({ cfg: { channels: { imessage } }, accountId: "secondary" });
  const modeOff: Partial<RouteReplyParams> = {
    replyDelivery: { chatType: "direct", replyToMode: "off" },
  };
  const targets: TargetCase[] = [
    {
      name: "explicit target with mode off",
      payload: { replyToId: "  chosen-message  ", replyToCurrent: false },
      overrides: modeOff,
      target: "chosen-message",
      payloadTarget: "chosen-message",
    },
    {
      name: "missing current ID",
      payload: { text: "Notification" },
      current: null,
      overrides: { threadId: "ambient-thread" },
    },
    { name: "explicit opt-out", payload: { replyToCurrent: false } },
    { name: "implicit mode off", overrides: modeOff },
    {
      name: "channel disablement",
      payload: { replyToId: "chosen-message" },
      overrides: accountConfig({ actions: { reply: false } }),
    },
    {
      name: "account disablement",
      payload: { replyToId: "chosen-message" },
      overrides: accountConfig({
        actions: { reply: true },
        accounts: { secondary: { actions: { reply: false } } },
      }),
    },
    {
      name: "blank explicit target",
      payload: { replyToId: "   " },
      current: "  question-guid  ",
      target: "question-guid",
    },
    {
      name: "blank targets with ambient thread",
      payload: { text: "Notice", replyToId: "   " },
      current: " ",
      overrides: { threadId: "ambient-thread" },
    },
    {
      name: "account enablement",
      current: "question-guid",
      overrides: accountConfig({
        actions: { reply: false },
        accounts: { secondary: { actions: { reply: true } } },
      }),
      target: "question-guid",
    },
    {
      name: "inherited disablement",
      current: "question-guid",
      overrides: accountConfig({
        actions: { reply: false },
        accounts: { secondary: { enabled: true } },
      }),
    },
  ];
  it.each(targets)(
    "selects the reply target for $name",
    async ({ payload, current = "current-message", overrides = {}, target, payloadTarget }) => {
      const sent = await route({ text: "Answer", ...payload }, current ?? undefined, overrides);
      expect(sent?.replyToId).toBe(target ?? null);
      expect(sent?.payloads).toMatchObject([{ replyToId: payloadTarget }]);
      expect(sent?.accountId).toBe(overrides.accountId ?? "default");
      expect(sent?.threadId).toBe(overrides.threadId ?? null);
    },
  );

  it("retains captionless media and its originating message", async () => {
    const sent = await route(
      { text: "", mediaUrl: "https://example.com/forecast.png" },
      "weather-question",
    );
    expect(sent).toMatchObject({
      replyToId: "weather-question",
      payloads: [{ text: "", mediaUrl: "https://example.com/forecast.png" }],
    });
  });

  it("preserves recipient, account, sender and session identity while selecting the target", async () => {
    const sent = await route({ text: "Answer" }, "question-guid", {
      to: "chat_id:456",
      accountId: "secondary",
      sessionKey: "agent:main:imessage:direct:fixture",
      requesterSenderId: "fixture-sender",
      requesterSenderName: "Fixture Sender",
      runId: "fixture-run",
    });
    expect(sent).toMatchObject({
      channel: "imessage",
      to: "chat_id:456",
      accountId: "secondary",
      replyToId: "question-guid",
      session: {
        key: "agent:main:imessage:direct:fixture",
        requesterSenderId: "fixture-sender",
        requesterSenderName: "Fixture Sender",
      },
      replyPayloadSendingHook: {
        context: { senderId: "fixture-sender", runId: "fixture-run", accountId: "secondary" },
      },
    });
  });
});
