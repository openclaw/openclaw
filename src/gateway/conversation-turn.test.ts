import { describe, expect, it, vi } from "vitest";
import { runAgentHarnessBeforeMessageWriteHook } from "../agents/harness/hook-helpers.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { appendAssistantMessageToSessionTranscript } from "../config/sessions/transcript.js";
import {
  runMessageAction,
  type MessageActionRunResult,
} from "../infra/outbound/message-action-runner.js";
import {
  claimPendingConversationTurnReply,
  registerPendingConversationTurn,
} from "../sessions/conversation-turns.js";
import { ConversationTurnInputError, runGatewayConversationTurn } from "./conversation-turn.js";

const conversation = {
  conversationRef: "conv_0123456789abcdef0123456789abcdef",
  channel: "reef",
  accountId: "default",
  kind: "direct" as const,
  target: "reef:molty",
  sessionId: "reef-session",
  sessionKey: "agent:main:reef:direct:molty",
  role: "participant" as const,
  firstSeenAt: 100,
  lastSeenAt: 200,
};

function sentResult(
  messageId = "reef-outbound-1",
): Extract<MessageActionRunResult, { kind: "send" }> {
  return {
    kind: "send",
    channel: "reef",
    action: "send",
    to: conversation.target,
    handledBy: "core",
    payload: {},
    deliveredText: "hello molty",
    sendResult: {
      channel: "reef",
      to: conversation.target,
      via: "direct",
      mediaUrl: null,
      result: { messageId },
      deliveryStatus: "sent",
    },
    dryRun: false,
  };
}

function createDeps() {
  return {
    appendAssistantMessage: vi.fn<typeof appendAssistantMessageToSessionTranscript>(async () => ({
      ok: true,
      sessionFile: "sqlite:main:reef-session",
      messageId: "transcript-outbound-1",
    })),
    beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
    loadSessionEntry: vi.fn<typeof loadSessionEntry>(() => undefined),
    registerPendingConversationTurn: vi.fn(registerPendingConversationTurn),
    resolveConversation: vi.fn(() => conversation),
    resolveOutboundChannelPlugin: vi.fn(
      () =>
        ({
          outbound: {
            prepareConversationTurnMessageId: () => "reef-outbound-1",
          },
        }) as never,
    ),
    runMessageAction: vi.fn<typeof runMessageAction>(async () => sentResult()),
  };
}

describe("runGatewayConversationTurn", () => {
  it("registers correlation before Gateway-owned delivery and consumes a fast reply inline", async () => {
    const deps = createDeps();
    let capture: Promise<void> | undefined;
    deps.runMessageAction.mockImplementationOnce(async (params) => {
      capture = claimPendingConversationTurnReply({
        conversationRef: conversation.conversationRef,
        sessionId: conversation.sessionId,
        messageId: "reef-inbound-1",
        replyToId: "reef-outbound-1",
        text: "hello clawd",
        timestamp: 300,
      }).then((claim) => claim?.complete());
      expect(params).toMatchObject({
        preparedMessageId: "reef-outbound-1",
        gatewayOwnedDelivery: true,
      });
      return sentResult();
    });

    const result = await runGatewayConversationTurn(
      {
        config: {},
        agentId: "main",
        sourceSessionId: "operator-session",
        sourceSessionKey: "agent:main:telegram:direct:operator",
        turnId: "turn-fast-reply",
        conversationRef: conversation.conversationRef,
        message: "hello molty",
        timeoutMs: 1_000,
      },
      deps,
    );
    await capture;

    expect(result).toMatchObject({
      status: "replied",
      messageId: "reef-outbound-1",
      reply: { text: "hello clawd", replyToId: "reef-outbound-1" },
    });
    expect(deps.registerPendingConversationTurn.mock.invocationCallOrder[0]).toBeLessThan(
      deps.appendAssistantMessage.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(deps.appendAssistantMessage.mock.invocationCallOrder[0]).toBeLessThan(
      deps.runMessageAction.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(deps.runMessageAction.mock.invocationCallOrder[0]).toBeLessThan(
      deps.appendAssistantMessage.mock.invocationCallOrder[1] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("rejects unsupported channels before registering or sending", async () => {
    const deps = createDeps();
    deps.resolveOutboundChannelPlugin.mockReturnValueOnce({ outbound: {} } as never);

    await expect(
      runGatewayConversationTurn(
        {
          config: {},
          agentId: "main",
          turnId: "turn-unsupported",
          conversationRef: conversation.conversationRef,
          message: "hello",
          timeoutMs: 1_000,
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(ConversationTurnInputError);
    expect(deps.registerPendingConversationTurn).not.toHaveBeenCalled();
    expect(deps.runMessageAction).not.toHaveBeenCalled();
  });

  it("resolves a source session alias before choosing transcript replay behavior", async () => {
    const deps = createDeps();
    deps.loadSessionEntry.mockReturnValueOnce({ sessionId: conversation.sessionId } as never);

    const result = await runGatewayConversationTurn(
      {
        config: {},
        agentId: "main",
        sourceSessionKey: "agent:main:reef:direct:molty-alias",
        turnId: "turn-source-alias",
        conversationRef: conversation.conversationRef,
        message: "hello",
        timeoutMs: 1,
      },
      deps,
    );

    expect(result.status).toBe("timeout");
    expect(deps.loadSessionEntry).toHaveBeenCalledWith({
      agentId: "main",
      sessionKey: "agent:main:reef:direct:molty-alias",
      readConsistency: "latest",
    });
    expect(deps.registerPendingConversationTurn).toHaveBeenCalledWith(
      expect.objectContaining({ sourceSessionId: conversation.sessionId }),
    );
    expect(deps.appendAssistantMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryMirror: expect.not.objectContaining({ replay: "backing-session" }),
      }),
    );
  });

  it("disables correlation when delivery does not preserve the reserved id", async () => {
    const deps = createDeps();
    deps.runMessageAction.mockResolvedValueOnce(sentResult("reef-different-id"));

    const result = await runGatewayConversationTurn(
      {
        config: {},
        agentId: "main",
        turnId: "turn-wrong-id",
        conversationRef: conversation.conversationRef,
        message: "hello",
        timeoutMs: 1_000,
      },
      deps,
    );

    expect(result).toMatchObject({
      status: "sent",
      messageId: "reef-different-id",
      correlationPersisted: true,
      error: expect.stringContaining("did not preserve its prepared message id"),
    });
  });

  it("cancels correlation without promoting a suppressed send", async () => {
    const deps = createDeps();
    deps.runMessageAction.mockResolvedValueOnce({
      ...sentResult(),
      deliveredText: undefined,
      sendResult: {
        channel: "reef",
        to: conversation.target,
        via: "direct",
        mediaUrl: null,
        deliveryStatus: "suppressed",
      },
    });

    await expect(
      runGatewayConversationTurn(
        {
          config: {},
          agentId: "main",
          turnId: "turn-suppressed",
          conversationRef: conversation.conversationRef,
          message: "hello",
          timeoutMs: 1_000,
        },
        deps,
      ),
    ).rejects.toThrow("Conversation delivery was suppressed");

    expect(deps.appendAssistantMessage).toHaveBeenCalledTimes(1);
    expect(deps.appendAssistantMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryMirror: expect.objectContaining({ status: "pending" }),
      }),
    );
  });
});
