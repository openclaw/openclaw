import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import { createReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.js";
import type { FinalizedMsgContext } from "../../auto-reply/templating.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  OutboundDeliveryError,
  PlatformMessageNotDispatchedError,
} from "../../infra/outbound/deliver-types.js";
import { settleDurableDelivery } from "../../infra/outbound/delivery-completion.js";
import { createStructuredOutboundPayloadPlan } from "../../infra/outbound/payloads.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { dispatchRoutedChannelTurn } from "./lifecycle.js";

const dispatchReplyWithRoutedChannelDispatcherCore = vi.hoisted(() => vi.fn());
const sendRecoveryNotice = vi.hoisted(() => vi.fn());
const appendAssistantMessageToSessionTranscript = vi.hoisted(() => vi.fn());
const recordInboundSessionCore = vi.hoisted(() => vi.fn(async () => undefined));
const withDurableDeliveryRuntime = vi.hoisted(() => vi.fn());

vi.mock("../../auto-reply/dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../auto-reply/dispatch.js")>();
  return {
    ...actual,
    dispatchInboundMessageWithRoutedChannelDispatcher: dispatchReplyWithRoutedChannelDispatcherCore,
  };
});
vi.mock("../session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session.js")>();
  return { ...actual, recordInboundSession: recordInboundSessionCore };
});
vi.mock("../../gateway/server-recovery-runtime-context.js", () => ({
  getGatewayRecoveryRuntime: () => ({ sendRecoveryNotice }),
}));
vi.mock("./durable-delivery-runtime.js", () => ({ withDurableDeliveryRuntime }));
vi.mock("../../config/sessions/transcript.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/sessions/transcript.js")>();
  return {
    ...actual,
    appendAssistantMessageToSessionTranscript,
    readRecentUserAssistantTextForSession: vi.fn(async () => []),
  };
});

function createCtx(overrides: Partial<FinalizedMsgContext> = {}): FinalizedMsgContext {
  return {
    Body: "hello",
    RawBody: "hello",
    CommandBody: "hello",
    CommandAuthorized: false,
    From: "sender",
    To: "chat-1",
    SessionKey: "agent:main:telegram:direct:chat-1",
    Provider: "telegram",
    Surface: "telegram",
    ...overrides,
  };
}

// Injected ambiguous final-send trace: turn 1 fails after the pre-I/O claim and
// must persist owed notice debt; turn 2 on the same route must deliver exactly
// one uncertainty notice and acknowledge the debt. Store, settlement, and turn
// lifecycle are real; only transport ends are stubbed.
describe("pending delivery notice end to end", () => {
  const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-notice-e2e-");
  let storePath: string;
  let cfg: OpenClawConfig;
  const sessionKey = "agent:main:telegram:direct:chat-1";
  const context = { channel: "telegram", to: "chat-1", accountId: "default" };
  const completion = {
    deliveryId: "delivery-e2e",
    intentId: "intent-e2e",
    sessionId: "session-e2e",
    sessionKey,
    storePath: "",
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    sendRecoveryNotice.mockResolvedValue({ suppressed: false });
    appendAssistantMessageToSessionTranscript.mockResolvedValue({ ok: true });
    storePath = path.join(sessionDirs.make(), "sessions.json");
    completion.storePath = storePath;
    cfg = { session: { store: storePath } } as OpenClawConfig;
    await replaceSessionEntry(
      { sessionKey, storePath },
      {
        sessionId: completion.sessionId,
        status: "done",
        updatedAt: Date.now(),
        delivery: {
          kind: "external",
          route: { channel: "telegram", accountId: "default" },
          context,
          origin: {},
        },
        pendingFinalDelivery: {
          kind: "replayable",
          text: "the final answer",
          createdAt: Date.now(),
          context,
          intentId: completion.intentId,
          deliveries: [{ id: completion.deliveryId, state: "prepared" }],
        },
      },
    );
  });

  const runTurn = (
    deliver: () => Promise<{ visibleReplySent: boolean }>,
    options?: { bindCustody?: boolean },
  ) => {
    dispatchReplyWithRoutedChannelDispatcherCore.mockImplementationOnce(async (params) => {
      const payload =
        options?.bindCustody === false
          ? { text: "the final answer" }
          : setReplyPayloadMetadata(
              { text: "the final answer" },
              { pendingFinalDeliveryCompletion: completion },
            );
      await params.dispatcherOptions.deliver(payload, { kind: "final" });
      return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
    });
    return dispatchRoutedChannelTurn({
      cfg,
      channel: "telegram",
      accountId: "default",
      route: { agentId: "main", sessionKey },
      ctxPayload: createCtx({ OriginatingTo: "chat-1" }),
      delivery: { deliver },
    });
  };

  it.each([
    { failure: "rejected", operation: "raw", state: "suppressed" },
    { failure: "rejected", operation: "prepared", state: "suppressed" },
    { failure: "retryable", operation: "raw", state: "prepared" },
    { failure: "retryable", operation: "prepared", state: "prepared" },
    { failure: "queue-owned", operation: "raw", state: "queued" },
    { failure: "queue-owned", operation: "prepared", state: "queued" },
  ] as const)(
    "does not owe a notice after $failure durable $operation delivery",
    async ({ failure, operation, state }) => {
      const notDispatched = new PlatformMessageNotDispatchedError("sender preflight failed", {
        cause: undefined,
        retryable: failure !== "rejected",
      });
      const error =
        failure === "queue-owned"
          ? Object.assign(
              new OutboundDeliveryError(notDispatched.message, { cause: notDispatched }),
              {
                queueCustody: "held",
              },
            )
          : notDispatched;
      withDurableDeliveryRuntime.mockImplementationOnce(() => {
        throw error;
      });
      dispatchReplyWithRoutedChannelDispatcherCore.mockImplementationOnce(async (params) => {
        const payload = setReplyPayloadMetadata(
          { text: "the final answer" },
          { pendingFinalDeliveryCompletion: completion },
        );
        const dispatcher = createReplyDispatcher(params.dispatcherOptions);
        if (operation === "prepared") {
          const [plan] = createStructuredOutboundPayloadPlan([payload]);
          if (!plan) {
            throw new Error("expected prepared final");
          }
          dispatcher.sendPreparedReply("final", plan);
        } else {
          dispatcher.sendFinalReply(payload);
        }
        dispatcher.markComplete();
        const settledReceipt = await dispatcher.waitForIdle();
        return { queuedFinal: true, counts: dispatcher.getQueuedCounts(), settledReceipt };
      });
      const deliver = vi.fn(async () => ({ visibleReplySent: true }));
      const onError = vi.fn();
      await dispatchRoutedChannelTurn({
        cfg,
        channel: "telegram",
        accountId: "default",
        route: { agentId: "main", sessionKey },
        ctxPayload: createCtx({ OriginatingTo: "chat-1" }),
        delivery: { deliver, durable: {}, onError },
      });

      const entry = loadSessionEntry({ sessionKey, storePath });
      expect(entry?.pendingFinalDelivery?.deliveries).toEqual([
        { id: completion.deliveryId, state },
      ]);
      expect(entry?.pendingDeliveryNotice).toBeUndefined();
      expect(deliver).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledExactlyOnceWith(error, { kind: "final" });

      await runTurn(async () => ({ visibleReplySent: true }), { bindCustody: false });
      expect(sendRecoveryNotice).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "keeps a settled notice final when suppression is %s",
    async (suppressed) => {
      sendRecoveryNotice.mockResolvedValue({ suppressed });
      const ambiguous = new Error("socket closed before response");
      await expect(
        runTurn(async () => {
          throw ambiguous;
        }),
      ).rejects.toBe(ambiguous);

      const afterLoss = loadSessionEntry({ sessionKey, storePath });
      expect(afterLoss?.pendingFinalDelivery?.deliveries).toEqual([
        { id: completion.deliveryId, state: "unknown" },
      ]);
      expect(afterLoss?.pendingDeliveryNotice).toMatchObject({
        intentId: completion.intentId,
        state: "owed",
      });
      expect(sendRecoveryNotice).not.toHaveBeenCalled();

      // The next turn carries its own fresh custody; the stale intent stays put.
      await runTurn(async () => ({ visibleReplySent: true }), { bindCustody: false });

      expect(sendRecoveryNotice).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          channel: "telegram",
          to: "chat-1",
          text: expect.stringContaining("couldn’t confirm"),
        }),
      );
      expect(loadSessionEntry({ sessionKey, storePath })?.pendingDeliveryNotice?.state).toBe(
        suppressed ? "unresolved" : "acknowledged",
      );

      // Reopen the canonical store so normalization must preserve the terminal fact.
      await closeOpenClawAgentDatabasesAsync(path.dirname(storePath));
      closeOpenClawAgentDatabasesForTest(path.dirname(storePath));
      // A queue restart can repeat owner settlement after its first write committed.
      await settleDurableDelivery(
        { kind: "pending-final", ...completion },
        { platformSendStarted: true },
      );
      await runTurn(async () => ({ visibleReplySent: true }), { bindCustody: false });
      expect(sendRecoveryNotice).toHaveBeenCalledTimes(1);
      expect(loadSessionEntry({ sessionKey, storePath })?.pendingDeliveryNotice?.state).toBe(
        suppressed ? "unresolved" : "acknowledged",
      );
    },
  );
});
