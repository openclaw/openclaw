import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveOutboundDurableFinalDeliverySupport: vi.fn(),
  sendDurableMessageBatch: vi.fn(),
  sendStructuredDurableMessageBatch: vi.fn(),
}));

vi.mock("../../infra/outbound/deliver.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/outbound/deliver.js")>()),
  resolveOutboundDurableFinalDeliverySupport: mocks.resolveOutboundDurableFinalDeliverySupport,
}));

vi.mock("../message/send.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../message/send.js")>()),
  sendDurableMessageBatchCore: mocks.sendDurableMessageBatch,
  sendStructuredDurableMessageBatchCore: mocks.sendStructuredDurableMessageBatch,
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
    mocks.resolveOutboundDurableFinalDeliverySupport.mockResolvedValue({ ok: true });
    const result = { status: "sent", receipt };
    mocks.sendDurableMessageBatch.mockResolvedValue(result);
    mocks.sendStructuredDurableMessageBatch.mockResolvedValue(result);
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
    expectOnlyCall(mocks.sendStructuredDurableMessageBatch, {
      replyToId: mode === "first" ? null : "hook-target",
    });
  });

  it("preserves explicit null thread targets instead of falling back to context thread", async () => {
    const executionIdentityToken = createExecutionIdentityAdmissionToken("run-exact");
    await deliver({
      executionIdentityToken,
      threadId: null,
      ctxPayload: { ...context, MessageThreadId: "context-thread" },
    });
    expectOnlyCall(mocks.sendDurableMessageBatch, {
      cfg: {},
      channel: "telegram",
      to: "chat-1",
      threadId: null,
      durability: "best_effort",
      gatewayClientScopes: [],
      runId: "run-exact",
      executionIdentityToken,
    });
    expectOnlyCall(mocks.resolveOutboundDurableFinalDeliverySupport, {
      requirements: { text: true, messageSendingHooks: true },
    });
    expect(
      mocks.sendDurableMessageBatch.mock.calls[0]?.[0].requireUnknownSendReconciliation,
    ).toBeUndefined();
    expect(mocks.sendStructuredDurableMessageBatch).not.toHaveBeenCalled();
  });

  it("carries prepared directive literals and explicit fields through the durable sender", async () => {
    const executionIdentityToken = createExecutionIdentityAdmissionToken("run-prepared");
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
    const result = await deliverStructuredInboundReplyWithMessageSendContextCore({
      ...request(),
      plan,
      threadId: null,
      executionIdentityToken,
      ctxPayload: { ...context, MessageThreadId: "context-thread" },
    });
    expect(result.status).toBe("handled_visible");
    expect(mocks.sendDurableMessageBatch).not.toHaveBeenCalled();
    expectOnlyCall(mocks.sendStructuredDurableMessageBatch, {
      plan: [plan],
      channel: "telegram",
      to: "chat-1",
      threadId: null,
      replyToId: "source-message",
      durability: "best_effort",
      runId: "run-prepared",
      executionIdentityToken,
    });
  });

  it("uses required durability when a caller explicitly requires unknown-send reconciliation", async () => {
    const requirements = { text: true, reconcileUnknownSend: true };
    await deliver({ requiredCapabilities: requirements });
    expectOnlyCall(mocks.resolveOutboundDurableFinalDeliverySupport, { requirements });
    expectOnlyCall(mocks.sendDurableMessageBatch, {
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
    mocks.sendDurableMessageBatch.mockResolvedValueOnce({
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
      mocks.sendDurableMessageBatch.mockResolvedValueOnce({ status: "failed", error });
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
