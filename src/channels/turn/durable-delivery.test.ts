import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
describe("durable inbound reply delivery", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.support.mockResolvedValue({ ok: true });
    const result = { status: "sent", receipt };
    mocks.send.mockResolvedValue(result);
    mocks.sendPrepared.mockResolvedValue(result);
  });

  it.each([
    { mode: "first", raw: true },
    { mode: "off", raw: false },
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
    const hooked = expectDefined(
      await runReplyPayloadSendingHook(
        {
          payload,
          kind: "final",
          channel: "telegram",
          context: { channelId: "telegram", conversationId: "chat-1" },
        },
        createHookRunner(registry),
      ),
      "admitted hook payload",
    );
    const plans = raw
      ? createOutboundPayloadPlan([hooked])
      : createStructuredOutboundPayloadPlan([hooked]);
    await deliverStructuredInboundReplyWithMessageSendContextCore({
      ...request(),
      plan: expectDefined(plans[0], "sendable reply plan"),
      replyToMode: mode,
      ctxPayload: { ...context, ReplyToId: "ambient-target" },
    });
    expect(mocks.sendPrepared.mock.calls[0]?.[0].replyToId).toBe(
      mode === "first" ? null : "hook-target",
    );
  });

  it("preserves explicit null threads and run identity", async () => {
    const executionIdentityToken = createExecutionIdentityAdmissionToken("run-exact");
    await deliver({
      threadId: null,
      executionIdentityToken,
      ctxPayload: { ...context, MessageThreadId: "context-thread" },
    });
    expect(mocks.send.mock.calls[0]?.[0]).toMatchObject({
      threadId: null,
      runId: "run-exact",
      executionIdentityToken,
      durability: "best_effort",
    });
    expect(mocks.send.mock.calls[0]?.[0].requireUnknownSendReconciliation).toBeUndefined();
  });

  it("uses required durability when a caller explicitly requires unknown-send reconciliation", async () => {
    const requirements = { text: true, reconcileUnknownSend: true };
    await deliver({ requiredCapabilities: requirements });
    expect(mocks.support.mock.calls[0]?.[0].requirements).toEqual(requirements);
    expect(mocks.send.mock.calls[0]?.[0]).toMatchObject({
      durability: "required",
      requireUnknownSendReconciliation: true,
    });
  });

  it("carries accepted text and routing into the partial-delivery error", async () => {
    const error = new Error("later chunk failed");
    mocks.send.mockResolvedValueOnce({
      status: "partial_failed",
      error,
      receipt,
      results: [{ messageId: "m1", meta: { visibleText: "accepted prefix" } }],
      deliveryIntent: { id: "queue-1", queuePolicy: "best_effort" },
    });
    const result = await deliver({ replyToId: "source-1", threadId: "thread-1" });
    expect(result).toMatchObject({
      status: "failed",
      sentBeforeError: true,
      error: {
        code: "CHANNEL_PARTIAL_DELIVERY",
        cause: error,
        deliveryResult: {
          content: "accepted prefix",
          replyToId: "source-1",
          threadId: "thread-1",
          deliveryIntent: { id: "queue-1", kind: "outbound_queue", queuePolicy: "best_effort" },
        },
      },
    });
    expect(error).not.toHaveProperty("sentBeforeError");
  });

  it.each([
    [new PlatformMessageNotDispatchedError("offline", { cause: new Error("offline") }), false],
    [new Error("socket closed"), undefined],
  ] as const)("keeps first-send failure non-visible (%s)", async (error, sentBeforeError) => {
    mocks.send.mockResolvedValueOnce({ status: "failed", error });
    const result = await deliver();
    expect(result).toEqual({
      status: "failed",
      error,
      ...(sentBeforeError === false ? { sentBeforeError } : {}),
    });
    expect(error).not.toHaveProperty("visibleReplySent");
    expect(error).not.toHaveProperty("sentBeforeError");
  });
});
