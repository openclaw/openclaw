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

const { sendDurableMessageBatchCore } = vi.hoisted(() => ({
  sendDurableMessageBatchCore:
    vi.fn<typeof import("../../channels/message/runtime.js").sendDurableMessageBatchCore>(),
}));

// Exercise the real router and registered plugin without sending native messages.
vi.mock("../../channels/message/runtime.js", () => ({
  sendDurableMessageBatchCore,
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
    const ids = ["weather-question", "mets-question", "yankees-question", "travel-question"];
    const [initial] = applyReplyThreading({
      payloads: [{ text: "Weather answer" }],
      currentMessageId: ids[0],
      replyToMode: "all",
      replyToChannel: "imessage",
    });
    assert(initial);
    await route(initial, ids[0]);
    await route({ text: "Mets answer" }, ids[1]);
    await route({ text: "Yankees answer" }, ids[2]);
    await route({ text: "Travel answer" }, ids[3]);

    expect(sendDurableMessageBatchCore).toHaveBeenCalledTimes(4);
    expect(sendDurableMessageBatchCore.mock.calls.map(([send]) => send.replyToId)).toEqual(ids);
    expect(
      sendDurableMessageBatchCore.mock.calls.map(([send]) => send.payloads[0]?.replyToId),
    ).toEqual([ids[0], undefined, undefined, undefined]);
  });

  it.each([
    { mode: "first", expected: ["question-guid", undefined, undefined] },
    { mode: "all", expected: ["question-guid", "question-guid", "question-guid"] },
  ] as const)(
    "preserves implicit $mode consumption at the delivery boundary",
    async ({ mode, expected }) => {
      const sent = await route({ text: "Answer" }, "question-guid", {
        replyDelivery: { chatType: "direct", replyToMode: mode },
      });
      assert(sent);
      expect(sent.replyToMode).toBe(mode);
      expect(sent.payloads[0]?.replyToId).toBeUndefined();
      assert(sent.payloads[0]);
      const policy = createReplyToDeliveryPolicy(sent);
      const resolved = policy.resolveCurrentReplyTo(sent.payloads[0]);
      expect(resolved).toEqual({ replyToId: "question-guid", source: "implicit" });
      const chunks = [1, 2, 3].map(
        () =>
          policy.applyReplyToConsumption(
            { replyToId: resolved.replyToId, replyToIdSource: resolved.source },
            { consumeImplicitReply: resolved.source === "implicit" },
          ).replyToId,
      );
      expect(chunks).toEqual(expected);
    },
  );

  it.each(["off", "first"] as const)(
    "preserves an explicit current-message request with reply mode %s",
    async (replyToMode) => {
      const sent = await route({ text: "Answer", replyToCurrent: true }, "question-guid", {
        replyDelivery: { chatType: "direct", replyToMode },
      });
      assert(sent);
      assert(sent.payloads[0]);
      expect(sent.replyToId).toBe("question-guid");
      expect(sent.payloads[0].replyToId).toBe("question-guid");
      const policy = createReplyToDeliveryPolicy(sent);
      const resolved = policy.resolveCurrentReplyTo(sent.payloads[0]);
      expect(resolved).toEqual({ replyToId: "question-guid", source: "explicit" });
      expect(
        [1, 2, 3].map(
          () =>
            policy.applyReplyToConsumption(
              { replyToId: resolved.replyToId, replyToIdSource: resolved.source },
              { consumeImplicitReply: resolved.source === "implicit" },
            ).replyToId,
        ),
      ).toEqual(["question-guid", "question-guid", "question-guid"]);
    },
  );

  it.each(["all", "off", "first"] as const)(
    "preserves an explicit reply target with reply mode %s",
    async (replyToMode) => {
      const sent = await route(
        { text: "Answer", replyToId: "  chosen-message  ", replyToCurrent: false },
        "current-message",
        {
          replyDelivery: { chatType: "direct", replyToMode },
        },
      );
      expect(sent?.replyToId).toBe("chosen-message");
      expect(sent?.payloads[0]?.replyToId).toBe("chosen-message");
    },
  );

  it.each(["Forecast", ""])(
    "retains media and its originating message with caption %j",
    async (text) => {
      const sent = await route(
        { text, mediaUrl: "https://example.com/forecast.png" },
        "weather-question",
      );
      expect(sent).toMatchObject({
        replyToId: "weather-question",
        payloads: [{ text, mediaUrl: "https://example.com/forecast.png" }],
      });
    },
  );

  it.each([undefined, "   "])("does not invent a reply target from current ID %j", async (id) => {
    const sent = await route({ text: "Notification" }, id, { threadId: "ambient-thread" });
    expect(sent).toMatchObject({ replyToId: null, threadId: "ambient-thread" });
  });

  it("honors a payload that explicitly opts out of replying to the current message", async () => {
    const sent = await route({ text: "Answer", replyToCurrent: false }, "current-message");
    expect(sent?.replyToId).toBeNull();
  });

  it("does not infer a reply target when delivery reply mode is off", async () => {
    const sent = await route({ text: "Answer" }, "current-message", {
      replyDelivery: { chatType: "direct", replyToMode: "off" },
    });
    expect(sent?.replyToId).toBeNull();
  });

  it.each([
    { actions: { reply: false } },
    { actions: { reply: true }, accounts: { secondary: { actions: { reply: false } } } },
  ])("honors channel and account reply disablement: %j", async (imessage) => {
    const sent = await route({ text: "Answer", replyToId: "chosen-message" }, "current-message", {
      cfg: { channels: { imessage } },
      accountId: "secondary",
    });
    expect(sent?.replyToId).toBeNull();
    expect(sent?.payloads[0]?.replyToId).toBeUndefined();
  });
  it("normalizes blank explicit targets before choosing a trimmed current message", async () => {
    const sent = await route({ text: "Answer", replyToId: "   " }, "  question-guid  ");
    expect(sent?.replyToId).toBe("question-guid");
    expect(sent?.payloads[0]?.replyToId).toBeUndefined();
  });

  it("clears a blank explicit target without inventing one from the ambient thread", async () => {
    const sent = await route({ text: "Notice", replyToId: "   " }, " ", {
      threadId: "ambient-thread",
    });
    expect(sent).toMatchObject({ replyToId: null, threadId: "ambient-thread" });
    expect(sent?.payloads[0]?.replyToId).toBeUndefined();
  });

  it("allows an account override to enable replies over the channel default", async () => {
    const sent = await route({ text: "Answer" }, "question-guid", {
      cfg: {
        channels: {
          imessage: {
            actions: { reply: false },
            accounts: { secondary: { actions: { reply: true } } },
          },
        },
      },
      accountId: "secondary",
    });
    expect(sent).toMatchObject({
      accountId: "secondary",
      replyToId: "question-guid",
      payloads: [{ replyToId: undefined }],
    });
  });

  it("inherits reply disablement when the account does not override actions", async () => {
    const sent = await route({ text: "Answer" }, "question-guid", {
      cfg: {
        channels: {
          imessage: {
            actions: { reply: false },
            accounts: { secondary: { enabled: true } },
          },
        },
      },
      accountId: "secondary",
    });
    expect(sent?.replyToId).toBeNull();
    expect(sent?.payloads[0]?.replyToId).toBeUndefined();
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

  it("does not send when routing is already cancelled", async () => {
    const result = await routeReply({
      cfg,
      payload: { text: "Answer" },
      currentMessageId: "question-guid",
      channel: "imessage",
      to: "chat_id:123",
      replyKind: "final",
      abortSignal: AbortSignal.abort(),
    });
    expect(result).toMatchObject({ ok: false, delivered: false, error: "Reply routing aborted" });
    expect(sendDurableMessageBatchCore).not.toHaveBeenCalled();
  });
});
