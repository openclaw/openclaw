import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, expect, it, vi } from "vitest";
import { createExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import { createReplyTurnLedger } from "../../auto-reply/reply/dispatch-from-config.turn-ledger.js";
import { resetDiagnosticEventsForTest } from "../../infra/diagnostic-events.js";
import { createStructuredOutboundPayloadPlan } from "../../infra/outbound/payloads.js";
import { outboundMessageIdentities } from "../message/outbound-echo-state.js";
import { dispatchRoutedChannelTurn } from "./lifecycle.js";
import { createCtx, expectDispatched } from "./run-channel-turn.delivery.test-helpers.js";

const getGlobalHookRunner = vi.hoisted(() => vi.fn());
const sendBatch = vi.hoisted(() =>
  vi.fn<typeof import("../message/send.js").sendStructuredDurableMessageBatchCore>(),
);
const resolveOutboundDurableFinalDeliverySupport = vi.hoisted(() => vi.fn());

vi.mock("../../infra/outbound/deliver.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/outbound/deliver.js")>()),
  resolveOutboundDurableFinalDeliverySupport,
}));

vi.mock("../message/send.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../message/send.js")>()),
  sendDurableMessageBatchCore: vi.fn(),
  sendStructuredDurableMessageBatchCore: sendBatch,
}));

vi.mock("../session.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session.js")>()),
  recordInboundSession: vi.fn(async () => undefined),
}));

vi.mock("../../plugins/hook-runner-global.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/hook-runner-global.js")>()),
  getGlobalHookRunner,
}));

vi.mock("../../config/sessions/transcript.js", () => ({
  readRecentUserAssistantTextForSession: vi.fn(async () => []),
}));

beforeEach(() => {
  vi.clearAllMocks();
  outboundMessageIdentities.clear();
  resetDiagnosticEventsForTest();
  resolveOutboundDurableFinalDeliverySupport.mockResolvedValue({ ok: true });
});

it.each([false, true])(
  "attributes group delivery to each participant (durable/prepared: %s)",
  async (prepared) => {
    const runMessageSending = vi.fn(async () => undefined);
    const runMessageSent = vi.fn(async () => undefined);
    getGlobalHookRunner.mockReturnValue({
      hasHooks: (name: string) => name === "message_sending" || name === "message_sent",
      runMessageSending,
      runMessageSent,
    });
    const token = createExecutionIdentityAdmissionToken("run-alice");
    const route = { channel: "telegram", accountId: "acct" };
    const target = { to: "chat-1", replyToId: "source-1", threadId: 42 };
    const sessionKey = (agentId: string) =>
      `agent:${agentId}:telegram:group:chat-1:thread:telegram-account-acct:thread:42`;
    if (prepared) {
      sendBatch.mockImplementation(async ({ plan, channel }) => {
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
      ...route,
      route: { agentId: "main", sessionKey: "agent:main:telegram:group:chat-1" },
      ctxPayload: createCtx({
        Provider: "telegram",
        Surface: "telegram",
        ChatType: "group",
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
        const plan = prepared
          ? expectDefined(createStructuredOutboundPayloadPlan([payload])[0], "expected final plan")
          : undefined;
        const queuedFinal = plan
          ? createReplyTurnLedger(dispatcher).sendPreparedQueued("final", plan).queued
          : dispatcher.sendFinalReply(payload);
        return { queuedFinal, counts: dispatcher.getQueuedCounts() };
      },
      delivery: {
        observeMessageSent: true,
        ...(prepared ? { durable: { to: "chat-1" } } : {}),
        deliver,
        deliverPrepared: (plan) => deliver(plan.payload),
      },
    });
    expectDispatched(result);
    if (prepared) {
      const requests = sendBatch.mock.calls.map(([request]) => request);
      expect(requests).toHaveLength(2);
      for (const agentId of ["alice", "bob"]) {
        const request = requests.find((entry) => entry.session?.agentId === agentId);
        expect(request).toMatchObject({
          ...route,
          ...target,
          runId: `run-${agentId}`,
          session: { agentId, key: sessionKey(agentId) },
        });
        expect(request?.executionIdentityToken).toBe(agentId === "alice" ? token : undefined);
      }
      expect(runMessageSent).not.toHaveBeenCalled();
      return;
    }
    for (const [hook, event] of [
      [runMessageSending, target],
      [runMessageSent, { to: "chat-1", success: true }],
    ] as const) {
      expect(hook).toHaveBeenCalledTimes(2);
      for (const agentId of ["alice", "bob"]) {
        expect(hook).toHaveBeenCalledWith(
          expect.objectContaining({ ...event, content: `${agentId} answer` }),
          expect.objectContaining({
            channelId: route.channel,
            accountId: route.accountId,
            conversationId: "chat-1",
            sessionKey: sessionKey(agentId),
            runId: `run-${agentId}`,
          }),
        );
      }
    }
  },
);
