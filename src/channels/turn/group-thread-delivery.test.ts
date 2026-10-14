import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import { createReplyTurnLedger } from "../../auto-reply/reply/dispatch-from-config.turn-ledger.js";
import { resetDiagnosticEventsForTest } from "../../infra/diagnostic-events.js";
import { createStructuredOutboundPayloadPlan } from "../../infra/outbound/payloads.js";
import { outboundMessageIdentities } from "../message/outbound-echo-state.js";
import { dispatchRoutedChannelTurn } from "./lifecycle.js";
import { createCtx, expectDispatched } from "./run-channel-turn.delivery.test-helpers.js";

const getGlobalHookRunner = vi.hoisted(() => vi.fn());
const sendStructuredDurableMessageBatch = vi.hoisted(() =>
  vi.fn<typeof import("../message/send.js").sendStructuredDurableMessageBatchCore>(),
);
const resolveOutboundDurableFinalDeliverySupport = vi.hoisted(() => vi.fn());

vi.mock("../../infra/outbound/deliver.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/outbound/deliver.js")>();
  return { ...actual, resolveOutboundDurableFinalDeliverySupport };
});

vi.mock("../message/send.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../message/send.js")>();
  return {
    ...actual,
    sendDurableMessageBatchCore: vi.fn(),
    sendStructuredDurableMessageBatchCore: sendStructuredDurableMessageBatch,
  };
});

vi.mock("../session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session.js")>();
  return { ...actual, recordInboundSession: vi.fn(async () => undefined) };
});

vi.mock("../../plugins/hook-runner-global.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../plugins/hook-runner-global.js")>();
  return { ...actual, getGlobalHookRunner };
});

vi.mock("../../config/sessions/transcript.js", () => ({
  readRecentUserAssistantTextForSession: vi.fn(async () => []),
}));

describe("group thread channel delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    outboundMessageIdentities.clear();
    resetDiagnosticEventsForTest();
    resolveOutboundDurableFinalDeliverySupport.mockResolvedValue({ ok: true });
  });

  it.each([
    { lane: "deferred direct", prepared: false },
    { lane: "durable", prepared: true },
  ])(
    "attributes group $lane delivery to each participant (prepared: $prepared)",
    async ({ lane, prepared }) => {
      const runMessageSending = vi.fn(async () => undefined);
      const runMessageSent = vi.fn(async () => undefined);
      getGlobalHookRunner.mockReturnValue({
        hasHooks: (name: string) => name === "message_sending" || name === "message_sent",
        runMessageSending,
        runMessageSent,
      });
      const token = createExecutionIdentityAdmissionToken("run-alice");
      if (lane === "durable") {
        sendStructuredDurableMessageBatch.mockImplementation(async ({ plan, channel }) => {
          const messageId = `sent-${plan[0]?.payload.text}`;
          return {
            status: "sent",
            results: [{ channel, messageId }],
            receipt: { platformMessageIds: [messageId], parts: [], sentAt: 1 },
          };
        });
      }
      const deliver = async (payload: ReplyPayload) => ({
        visibleReplySent: false,
        finalization: Promise.resolve({
          visibleReplySent: true,
          content: payload.text,
          messageIds: [`sent-${payload.text}`],
        }),
      });
      const result = await dispatchRoutedChannelTurn({
        cfg: {
          agents: { entries: { alice: {}, bob: {} } },
          broadcast: { "telegram:chat-1": ["alice", "bob"] },
        },
        channel: "telegram",
        accountId: "acct",
        route: { agentId: "main", sessionKey: "agent:main:telegram:group:chat-1" },
        ctxPayload: createCtx({
          Provider: "telegram",
          Surface: "telegram",
          ChatType: "group",
          From: "chat-1",
          OriginatingTo: "chat-1",
          NativeChannelId: "chat-1",
          AccountId: "acct",
          ReplyToId: "source-1",
          MessageSid: "source-1",
          MessageThreadId: 42,
        }),
        dispatchReplyFromConfig: async ({ ctx, dispatcher, replyOptions }) => {
          replyOptions?.onAgentRunStart?.(
            `run-${ctx.AgentId}`,
            ctx.AgentId === "alice" ? token : undefined,
          );
          const payload = { text: `${ctx.AgentId} answer` };
          const queuedFinal = prepared
            ? createReplyTurnLedger(dispatcher).sendPreparedQueued(
                "final",
                expectDefined(
                  createStructuredOutboundPayloadPlan([payload])[0],
                  "expected final plan",
                ),
              ).queued
            : dispatcher.sendFinalReply(payload);
          return {
            queuedFinal,
            counts: dispatcher.getQueuedCounts(),
          };
        },
        delivery: {
          observeMessageSent: true,
          ...(lane === "durable" ? { durable: { to: "chat-1" } } : {}),
          deliver,
          deliverPrepared: (plan) => deliver(plan.payload),
        },
      });

      expectDispatched(result);
      if (lane === "durable") {
        const durableRequests = sendStructuredDurableMessageBatch.mock.calls.map(
          ([request]) => request,
        );
        expect(durableRequests).toHaveLength(2);
        for (const agentId of ["alice", "bob"]) {
          const request = durableRequests.find((entry) => entry.session?.agentId === agentId);
          expect(request).toMatchObject({
            channel: "telegram",
            accountId: "acct",
            to: "chat-1",
            replyToId: "source-1",
            threadId: 42,
            runId: `run-${agentId}`,
            session: {
              agentId,
              key: `agent:${agentId}:telegram:group:chat-1:thread:telegram-account-acct:thread:42`,
            },
          });
          expect(request?.executionIdentityToken).toBe(agentId === "alice" ? token : undefined);
        }
        expect(runMessageSent).not.toHaveBeenCalled();
        return;
      }
      expect(runMessageSending).toHaveBeenCalledTimes(2);
      expect(runMessageSent).toHaveBeenCalledTimes(2);
      for (const agentId of ["alice", "bob"]) {
        const context = expect.objectContaining({
          channelId: "telegram",
          accountId: "acct",
          conversationId: "chat-1",
          sessionKey: `agent:${agentId}:telegram:group:chat-1:thread:telegram-account-acct:thread:42`,
          runId: `run-${agentId}`,
        });
        expect(runMessageSending).toHaveBeenCalledWith(
          expect.objectContaining({
            to: "chat-1",
            content: `${agentId} answer`,
            replyToId: "source-1",
            threadId: 42,
          }),
          context,
        );
        expect(runMessageSent).toHaveBeenCalledWith(
          expect.objectContaining({ to: "chat-1", content: `${agentId} answer`, success: true }),
          context,
        );
      }
    },
  );
});
