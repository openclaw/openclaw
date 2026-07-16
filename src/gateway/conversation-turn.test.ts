import { describe, expect, it, vi } from "vitest";
import type { ConversationDeliveryRecord } from "../config/sessions/conversation-delivery-store.js";
import type { MessageActionRunResult } from "../infra/outbound/message-action-runner.js";
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
  const operations = new Map<string, ConversationDeliveryRecord>();
  const update = (
    operationId: string,
    patch: Partial<ConversationDeliveryRecord>,
  ): ConversationDeliveryRecord => {
    const current = operations.get(operationId);
    if (!current) {
      throw new Error(`missing operation: ${operationId}`);
    }
    const next = { ...current, ...patch, updatedAt: current.updatedAt + 1 };
    operations.set(operationId, next);
    return next;
  };
  return {
    beginOperation: vi.fn(
      (
        _scope: unknown,
        params: {
          operationId: string;
          conversationRef: string;
          message: string;
          preparedMessageId?: string;
        },
      ) => {
        const existing = operations.get(params.operationId);
        if (existing) {
          return { created: false, record: existing };
        }
        const record: ConversationDeliveryRecord = {
          operationId: params.operationId,
          conversationRef: params.conversationRef,
          messageHash: params.message,
          status: "created",
          ...(params.preparedMessageId ? { preparedMessageId: params.preparedMessageId } : {}),
          createdAt: 100,
          updatedAt: 100,
        };
        operations.set(params.operationId, record);
        return { created: true, record };
      },
    ),
    getOperation: vi.fn((_scope: unknown, operationId: string) => operations.get(operationId)),
    markQueued: vi.fn((_scope: unknown, operationId: string, queueId: string) =>
      update(operationId, { status: "queued", queueId }),
    ),
    markSent: vi.fn((_scope: unknown, operationId: string, platformMessageId?: string) =>
      update(operationId, {
        status: "sent",
        ...(platformMessageId ? { platformMessageId } : {}),
      }),
    ),
    markSuppressed: vi.fn((_scope: unknown, operationId: string) =>
      update(operationId, { status: "suppressed" }),
    ),
    markUnknown: vi.fn((_scope: unknown, operationId: string) =>
      update(operationId, { status: "unknown" }),
    ),
    registerPendingConversationTurn: vi.fn(registerPendingConversationTurn),
    resolveConversation: vi.fn(() => conversation),
    resolveOutboundChannelPlugin: vi.fn(
      () =>
        ({
          outbound: { prepareConversationTurnMessageId: () => "reef-outbound-1" },
        }) as never,
    ),
    runMessageAction: vi.fn(async () => sentResult()) as never,
    operations,
    update,
  };
}

function persistIntent(input: Record<string, unknown>): void {
  const onDeliveryIntent = input.onDeliveryIntent as (intent: {
    id: string;
    channel: string;
    to: string;
    durability: "required";
  }) => void;
  onDeliveryIntent({
    id: "queue-1",
    channel: "reef",
    to: "molty",
    durability: "required",
  });
}

describe("runGatewayConversationTurn", () => {
  it("registers correlation before durable delivery and consumes a fast reply inline", async () => {
    const deps = createDeps();
    let capture: Promise<void> | undefined;
    deps.runMessageAction = vi.fn(async (input: Record<string, unknown>) => {
      expect(input).toMatchObject({
        preparedMessageId: "reef-outbound-1",
        gatewayOwnedDelivery: true,
        forceCoreDelivery: true,
        requireQueuePersistence: true,
        suppressTranscriptMirror: true,
      });
      persistIntent(input);
      capture = claimPendingConversationTurnReply({
        conversationRef: conversation.conversationRef,
        sessionId: conversation.sessionId,
        messageId: "reef-inbound-1",
        replyToId: "reef-outbound-1",
        text: "hello clawd",
        timestamp: 300,
      }).then((claim) => claim?.complete());
      return sentResult();
    }) as never;

    const result = await runGatewayConversationTurn(
      {
        config: {},
        agentId: "main",
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
      (deps.runMessageAction as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY,
    );
  });

  it("returns a prior durable reply without sending again", async () => {
    const deps = createDeps();
    deps.operations.set("turn-replied", {
      operationId: "turn-replied",
      conversationRef: conversation.conversationRef,
      messageHash: "hello",
      status: "replied",
      preparedMessageId: "reef-outbound-1",
      platformMessageId: "reef-outbound-1",
      reply: { messageId: "reply-1", replyToId: "reef-outbound-1", text: "ack", timestamp: 300 },
      createdAt: 100,
      updatedAt: 300,
    });

    await expect(
      runGatewayConversationTurn(
        {
          config: {},
          agentId: "main",
          turnId: "turn-replied",
          conversationRef: conversation.conversationRef,
          message: "hello",
          timeoutMs: 1_000,
        },
        deps,
      ),
    ).resolves.toMatchObject({ status: "replied", reply: { text: "ack" } });
    expect(deps.runMessageAction).not.toHaveBeenCalled();
    expect(deps.resolveOutboundChannelPlugin).not.toHaveBeenCalled();
  });

  it("returns queued state without retrying recipient-visible I/O", async () => {
    const deps = createDeps();
    deps.operations.set("turn-queued", {
      operationId: "turn-queued",
      conversationRef: conversation.conversationRef,
      messageHash: "hello",
      status: "queued",
      preparedMessageId: "reef-outbound-1",
      queueId: "queue-existing",
      createdAt: 100,
      updatedAt: 200,
    });

    await expect(
      runGatewayConversationTurn(
        {
          config: {},
          agentId: "main",
          turnId: "turn-queued",
          conversationRef: conversation.conversationRef,
          message: "hello",
          timeoutMs: 1_000,
        },
        deps,
      ),
    ).resolves.toMatchObject({ status: "queued", messageId: "reef-outbound-1" });
    expect(deps.runMessageAction).not.toHaveBeenCalled();
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

  it("disables inline correlation when delivery changes the reserved id", async () => {
    const deps = createDeps();
    deps.runMessageAction = vi.fn(async (input: Record<string, unknown>) => {
      persistIntent(input);
      return sentResult("reef-different-id");
    }) as never;

    await expect(
      runGatewayConversationTurn(
        {
          config: {},
          agentId: "main",
          turnId: "turn-wrong-id",
          conversationRef: conversation.conversationRef,
          message: "hello",
          timeoutMs: 1_000,
        },
        deps,
      ),
    ).resolves.toMatchObject({
      status: "sent",
      messageId: "reef-different-id",
      error: expect.stringContaining("did not preserve its prepared message id"),
    });
  });

  it("returns suppression without promoting it to sent", async () => {
    const deps = createDeps();
    deps.runMessageAction = vi.fn(async (input: Record<string, unknown>) => {
      const onDeliveryIntent = input.onDeliveryIntent as (intent: {
        id: string;
        channel: string;
        to: string;
        durability: "required";
      }) => void;
      onDeliveryIntent({
        id: "queue-suppressed",
        channel: "reef",
        to: "molty",
        durability: "required",
      });
      return {
        ...sentResult(),
        sendResult: { ...sentResult().sendResult, deliveryStatus: "suppressed" as const },
      };
    }) as never;

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
    ).resolves.toMatchObject({ status: "suppressed", correlationPersisted: false });
  });
});
