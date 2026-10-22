import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const mocks = vi.hoisted(() => ({
  support: vi.fn(),
  send: vi.fn(),
  sendPrepared: vi.fn(),
}));

vi.mock("../../infra/outbound/deliver.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/outbound/deliver.js")>()),
  resolveOutboundDurableFinalDeliverySupport: mocks.support,
}));

vi.mock("../message/send.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../message/send.js")>()),
  sendDurableMessageBatchCore: mocks.send,
  sendStructuredDurableMessageBatchCore: mocks.sendPrepared,
}));

import { createExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import { runReplyPayloadSendingHook } from "../../auto-reply/reply/reply-payload-sending-hook.js";
import { createReplyToModeFilterForChannel } from "../../auto-reply/reply/reply-threading.js";
import type { FinalizedMsgContext } from "../../auto-reply/templating.js";
import { PlatformMessageNotDispatchedError } from "../../infra/outbound/deliver-types.js";
import {
  createOutboundPayloadPlan,
  createStructuredOutboundPayloadPlan,
} from "../../infra/outbound/payloads.js";
import type { PluginHookReplyPayloadSendingEvent } from "../../plugins/hook-types.js";
import { createHookRunner } from "../../plugins/hooks.js";
import { addTestHook } from "../../plugins/hooks.test-fixtures.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import {
  deliverInboundReplyWithMessageSendContextCore,
  deliverStructuredInboundReplyWithMessageSendContextCore,
  throwIfDurableInboundReplyDeliveryFailed,
  type DurableInboundReplyDeliveryParams,
} from "./durable-delivery.js";

const context: FinalizedMsgContext = {
  CommandAuthorized: true,
  CommandTurn: { kind: "normal", source: "message", authorized: false },
  OriginatingTo: "chat-1",
};

function request(
  overrides: Partial<DurableInboundReplyDeliveryParams> = {},
): DurableInboundReplyDeliveryParams {
  return {
    cfg: {},
    channel: "telegram",
    agentId: "main",
    info: { kind: "final" },
    payload: { text: "final" },
    ctxPayload: { ...context },
    ...overrides,
  };
}
const deliver = (overrides: Partial<DurableInboundReplyDeliveryParams> = {}) =>
  deliverInboundReplyWithMessageSendContextCore(request(overrides));

const receipt = {
  primaryPlatformMessageId: "m1",
  platformMessageIds: ["m1"],
  parts: [{ platformMessageId: "m1", kind: "text", index: 0 }],
  sentAt: 1,
};
function expectOnlyCall(mock: Mock, fields: object) {
  expect(mock).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(fields));
}

describe("durable inbound reply delivery", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.support.mockResolvedValue({ ok: true });
    const result = { status: "sent", receipt };
    mocks.send.mockResolvedValue(result);
    mocks.sendPrepared.mockResolvedValue(result);
  });

  it.each([
    { mode: "first", raw: false },
    { mode: "first", raw: true },
    { mode: "off", raw: false },
    { mode: "off", raw: true },
  ] as const)("preserves $mode policy through a public hook (raw=$raw)", async ({ mode, raw }) => {
    const filter = createReplyToModeFilterForChannel(mode, "telegram");
    filter({ text: "First reply", replyToId: "source-message" });
    const payload = filter({ text: "Later reply", replyToId: "source-message" });
    const registry = createEmptyPluginRegistry();
    addTestHook({
      registry,
      pluginId: "explicit-target",
      hookName: "reply_payload_sending",
      handler: (event: PluginHookReplyPayloadSendingEvent) => ({
        payload: raw
          ? { ...event.payload, text: "[[reply_to:hook-target]]Later reply" }
          : { ...event.payload, replyToId: "hook-target", replyToTag: true },
      }),
    });
    const hooked = await runReplyPayloadSendingHook(
      {
        payload,
        kind: "final",
        channel: "telegram",
        context: { channelId: "telegram", conversationId: "chat-1" },
      },
      createHookRunner(registry),
    );
    if (!hooked) {
      throw new Error("Expected an admitted hook payload");
    }
    const [plan] = raw
      ? createOutboundPayloadPlan([hooked])
      : createStructuredOutboundPayloadPlan([hooked]);
    if (!plan) {
      throw new Error("Expected a sendable reply plan");
    }
    await deliverStructuredInboundReplyWithMessageSendContextCore({
      ...request(),
      plan,
      replyToMode: mode,
      ctxPayload: { ...context, ReplyToId: "ambient-target" },
    });
    expectOnlyCall(mocks.sendPrepared, {
      replyToId: mode === "first" ? null : "hook-target",
    });
  });

  it.each([false, true])(
    "preserves null threads and run identity (prepared=%s)",
    async (prepared) => {
      const runId = prepared ? "run-prepared" : "run-exact";
      const executionIdentityToken = createExecutionIdentityAdmissionToken(runId);
      const [entry] = createStructuredOutboundPayloadPlan([
        {
          text: "[[reply_to:literal]] [[audio_as_voice]]",
          mediaUrl: "https://example.invalid/audio.ogg",
          replyToId: "source-message",
        },
      ]);
      if (!entry) {
        throw new Error("expected a sendable prepared plan");
      }
      const plan = { ...entry, sourceIndex: 3 };
      const params = request({
        threadId: null,
        executionIdentityToken,
        ctxPayload: { ...context, MessageThreadId: "context-thread" },
      });
      const result = await (prepared
        ? deliverStructuredInboundReplyWithMessageSendContextCore({ ...params, plan })
        : deliverInboundReplyWithMessageSendContextCore(params));
      expect(result.status).toBe("handled_visible");
      const send = prepared ? mocks.sendPrepared : mocks.send;
      const unused = prepared ? mocks.send : mocks.sendPrepared;
      expect(unused).not.toHaveBeenCalled();
      expectOnlyCall(send, {
        ...(prepared
          ? { plan: [plan], replyToId: "source-message" }
          : { cfg: {}, gatewayClientScopes: [] }),
        channel: "telegram",
        to: "chat-1",
        threadId: null,
        durability: "best_effort",
        runId,
        executionIdentityToken,
      });
      if (!prepared) {
        expectOnlyCall(mocks.support, {
          requirements: { text: true, messageSendingHooks: true },
        });
        expect(send.mock.calls[0]?.[0].requireUnknownSendReconciliation).toBeUndefined();
      }
    },
  );

  it("uses required durability when a caller explicitly requires unknown-send reconciliation", async () => {
    const requirements = { text: true, reconcileUnknownSend: true };
    await deliver({ requiredCapabilities: requirements });
    expectOnlyCall(mocks.support, { requirements });
    expectOnlyCall(mocks.send, {
      durability: "required",
      requireUnknownSendReconciliation: true,
    });
  });

  it.each([
    new Error("second chunk failed"),
    new PlatformMessageNotDispatchedError("second chunk rejected before dispatch", {
      cause: new Error("local preflight rejected"),
      retryable: false,
    }),
  ])("reports durable partial send failures as failed delivery (%s)", async (error) => {
    mocks.send.mockResolvedValueOnce({
      status: "partial_failed",
      results: [{ channel: "telegram", messageId: "m1", meta: { visibleText: "accepted prefix" } }],
      receipt,
      error,
      sentBeforeError: true,
      deliveryIntent: {
        id: "queue-1",
        channel: "telegram",
        to: "chat-1",
        queuePolicy: "best_effort",
      },
    });
    const result = await deliver({ replyToId: "source-1", threadId: "thread-1" });
    expect(result).toMatchObject({
      status: "failed",
      sentBeforeError: true,
      error: {
        code: "CHANNEL_PARTIAL_DELIVERY",
        cause: error,
        sentBeforeError: true,
        visibleReplySent: true,
        deliveryResult: {
          messageIds: ["m1"],
          receipt: expect.objectContaining({ primaryPlatformMessageId: "m1" }),
          visibleReplySent: true,
          content: "accepted prefix",
          replyToId: "source-1",
          threadId: "thread-1",
          deliveryIntent: {
            id: "queue-1",
            kind: "outbound_queue",
            queuePolicy: "best_effort",
          },
        },
      },
    });
    expect(() => throwIfDurableInboundReplyDeliveryFailed(result)).toThrow(
      expect.objectContaining({ code: "CHANNEL_PARTIAL_DELIVERY" }),
    );
    expect(error).not.toHaveProperty("sentBeforeError");
  });

  it.each([
    {
      label: "proven no-dispatch",
      error: new PlatformMessageNotDispatchedError("offline before dispatch", {
        cause: new Error("offline"),
      }),
      sentBeforeError: false,
    },
    {
      label: "ambiguous first-send",
      error: new Error("socket closed"),
      sentBeforeError: undefined,
    },
  ])(
    "keeps a $label failure non-visible and preserves its retry contract",
    async ({ error, sentBeforeError }) => {
      mocks.send.mockResolvedValueOnce({ status: "failed", error });
      const result = await deliver();
      expect(result).toEqual({
        status: "failed",
        error,
        ...(sentBeforeError === false ? { sentBeforeError } : {}),
      });
      expect(error).not.toHaveProperty("visibleReplySent");
      expect(error).not.toHaveProperty("sentBeforeError");
    },
  );
});
