import { describe, expect, it, vi } from "vitest";
import type { ConversationDeliveryRecord } from "../../config/sessions/conversation-delivery-store.js";
import type { MessageActionRunResult } from "../../infra/outbound/message-action-runner.js";
import {
  DEFAULT_GATEWAY_HTTP_TOOL_DENY,
  GATEWAY_OWNER_ONLY_CORE_TOOLS,
} from "../../security/dangerous-tools.js";
import {
  createConversationsListTool,
  createConversationsSendTool,
  createConversationsTurnTool,
} from "./conversation-tools.js";

const conversation = {
  conversationRef: "conv_0123456789abcdef0123456789abcdef",
  channel: "reef",
  accountId: "default",
  kind: "direct" as const,
  target: "reef:peer-agent",
  sessionId: "shared-main-session",
  sessionKey: "agent:main:main",
  role: "participant" as const,
  firstSeenAt: 100,
  lastSeenAt: 200,
};

function sentResult(): Extract<MessageActionRunResult, { kind: "send" }> {
  return {
    kind: "send",
    channel: "reef",
    action: "send",
    to: "reef:peer-agent",
    handledBy: "core",
    payload: {},
    sendResult: {
      channel: "reef",
      to: "reef:peer-agent",
      via: "direct",
      mediaUrl: null,
      result: { messageId: "reef-outbound-1" },
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
  const runMessageAction = vi.fn(async (input: Record<string, unknown>) => {
    const onDeliveryIntent = input.onDeliveryIntent as
      | ((intent: { id: string; channel: string; to: string; durability: "required" }) => void)
      | undefined;
    onDeliveryIntent?.({
      id: "queue-1",
      channel: "reef",
      to: "peer-agent",
      durability: "required",
    });
    const onDeliveryResult = input.onDeliveryResult as
      | ((result: { channel: "reef"; messageId: string }) => Promise<void> | void)
      | undefined;
    await onDeliveryResult?.({ channel: "reef", messageId: "reef-outbound-1" });
    return sentResult();
  });
  const callGatewayMock = vi.fn(async (_params: unknown) => ({
    status: "replied" as const,
    conversationRef: conversation.conversationRef,
    channel: "reef",
    messageId: "reef-outbound-1",
    correlationPersisted: true,
    reply: {
      conversationRef: conversation.conversationRef,
      messageId: "reef-inbound-1",
      replyToId: "reef-outbound-1",
      text: "peer acknowledged",
      timestamp: 300,
    },
  }));
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
    callGateway: callGatewayMock as never,
    callGatewayMock,
    listConversations: vi.fn(() => [conversation]),
    resolveConversation: vi.fn((): typeof conversation | undefined => conversation),
    runMessageAction: runMessageAction as never,
    runMessageActionMock: runMessageAction,
    operations,
  };
}

describe("conversation tools", () => {
  it("lists opaque external addresses independently from sessions", async () => {
    const deps = createDeps();
    const result = await createConversationsListTool({ agentId: "main" }, deps).execute("list", {
      channel: "reef",
    });

    expect(deps.listConversations).toHaveBeenCalledWith(
      { agentId: "main" },
      { channel: "reef", limit: 50 },
    );
    expect(result.details).toEqual({
      conversations: [
        {
          conversationRef: conversation.conversationRef,
          channel: "reef",
          accountId: "default",
          kind: "direct",
          target: "reef:peer-agent",
          firstSeenAt: 100,
          lastSeenAt: 200,
        },
      ],
    });
  });

  it("requires a durable core queue and does not re-send a replayed tool call", async () => {
    const deps = createDeps();
    const tool = createConversationsSendTool(
      { agentId: "main", agentSessionKey: "agent:main:telegram:direct:operator", config: {} },
      deps,
    );
    const args = {
      conversationRef: conversation.conversationRef,
      message: "hello peer",
    };

    const first = await tool.execute("tool-call-1", args);
    const second = await tool.execute("tool-call-1", args);

    expect(deps.runMessageActionMock).toHaveBeenCalledOnce();
    expect(deps.runMessageActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "send",
        agentId: "main",
        sessionKey: "agent:main:telegram:direct:operator",
        suppressTranscriptMirror: true,
        forceCoreDelivery: true,
        requireQueuePersistence: true,
        deliveryIntentId: expect.stringMatching(/^convop_[a-f0-9]{32}$/u),
        deliveryCompletion: expect.objectContaining({
          kind: "conversation",
          agentId: "main",
          operationId: expect.stringMatching(/^convop_[a-f0-9]{32}$/u),
        }),
        params: expect.objectContaining({
          channel: "reef",
          to: "reef:peer-agent",
          message: "hello peer",
          idempotencyKey: expect.stringMatching(/^convop_[a-f0-9]{32}$/u),
        }),
      }),
    );
    expect(first.details).toMatchObject({
      status: "sent",
      conversationRef: conversation.conversationRef,
      messageId: "reef-outbound-1",
      queueId: "queue-1",
    });
    expect(second.details).toEqual(first.details);
  });

  it("reports suppression without claiming delivery", async () => {
    const deps = createDeps();
    deps.runMessageActionMock.mockImplementationOnce(async (input: Record<string, unknown>) => {
      const onDeliveryIntent = input.onDeliveryIntent as (intent: {
        id: string;
        channel: string;
        to: string;
        durability: "required";
      }) => void;
      onDeliveryIntent({
        id: "queue-suppressed",
        channel: "reef",
        to: "peer-agent",
        durability: "required",
      });
      const base = sentResult();
      if (!base.sendResult) {
        throw new Error("expected core send result");
      }
      return {
        ...base,
        sendResult: { ...base.sendResult, deliveryStatus: "suppressed" as const },
      };
    });

    const result = await createConversationsSendTool({ agentId: "main", config: {} }, deps).execute(
      "suppressed-call",
      {
        conversationRef: conversation.conversationRef,
        message: "suppressed hello",
      },
    );

    expect(result.details).toMatchObject({
      status: "suppressed",
      conversationRef: conversation.conversationRef,
      queueId: "queue-suppressed",
    });
  });

  it("keeps a proven pre-queue failure retryable under the stable tool call id", async () => {
    const deps = createDeps();
    deps.runMessageActionMock.mockRejectedValueOnce(new Error("queue unavailable"));
    const tool = createConversationsSendTool({ agentId: "main", config: {} }, deps);
    const args = {
      conversationRef: conversation.conversationRef,
      message: "retry me",
    };

    await expect(tool.execute("retryable-call", args)).rejects.toThrow("queue unavailable");
    await expect(tool.execute("retryable-call", args)).resolves.toMatchObject({
      details: { status: "sent", messageId: "reef-outbound-1" },
    });
    expect(deps.runMessageActionMock).toHaveBeenCalledTimes(2);
  });

  it("reports authoritative sent state when post-send cleanup throws", async () => {
    const deps = createDeps();
    deps.runMessageActionMock.mockImplementationOnce(async (input: Record<string, unknown>) => {
      const completion = input.deliveryCompletion as { operationId: string };
      const onDeliveryIntent = input.onDeliveryIntent as (intent: {
        id: string;
        channel: string;
        to: string;
        durability: "required";
      }) => void;
      onDeliveryIntent({
        id: "queue-cleanup-failed",
        channel: "reef",
        to: "peer-agent",
        durability: "required",
      });
      deps.markSent({}, completion.operationId, "reef-outbound-confirmed");
      throw new Error("queue acknowledgement cleanup failed");
    });

    const result = await createConversationsSendTool({ agentId: "main", config: {} }, deps).execute(
      "post-send-cleanup-call",
      {
        conversationRef: conversation.conversationRef,
        message: "confirmed before cleanup",
      },
    );

    expect(result.details).toMatchObject({
      status: "sent",
      messageId: "reef-outbound-confirmed",
      queueId: "queue-cleanup-failed",
    });
  });

  it("uses a stable operation id for correlated turns and cancels on abort", async () => {
    const deps = createDeps();
    const tool = createConversationsTurnTool(
      {
        agentId: "main",
        agentSessionId: "operator-session",
        agentSessionKey: "agent:main:telegram:direct:operator",
        config: {},
      },
      deps,
    );
    await tool.execute("turn-call", {
      conversationRef: conversation.conversationRef,
      message: "please acknowledge",
      timeoutSeconds: 12,
    });
    await tool.execute("turn-call", {
      conversationRef: conversation.conversationRef,
      message: "please acknowledge",
      timeoutSeconds: 12,
    });

    const first = deps.callGatewayMock.mock.calls[0]?.[0] as {
      onSignalAbort?: (
        request: (method: string, params: unknown, options: unknown) => Promise<unknown>,
      ) => Promise<void>;
      params: { turnId: string };
    };
    const second = deps.callGatewayMock.mock.calls[1]?.[0] as { params: { turnId: string } };
    expect(first.params.turnId).toMatch(/^convop_[a-f0-9]{32}$/u);
    expect(second.params.turnId).toBe(first.params.turnId);
    const request = vi.fn(async () => ({ cancelled: true }));
    await first.onSignalAbort?.(request);
    expect(request).toHaveBeenCalledWith(
      "conversations.turn.cancel",
      { turnId: first.params.turnId },
      { timeoutMs: 5_000 },
    );
  });

  it("rejects unknown references and non-owner access before delivery", async () => {
    const deps = createDeps();
    deps.resolveConversation.mockReturnValue(undefined);
    await expect(
      createConversationsSendTool({ agentId: "main", config: {} }, deps).execute("send", {
        conversationRef: "conv_ffffffffffffffffffffffffffffffff",
        message: "hello",
      }),
    ).rejects.toThrow("Conversation not found");

    for (const createTool of [
      createConversationsListTool,
      createConversationsSendTool,
      createConversationsTurnTool,
    ]) {
      const tool = createTool({ agentId: "main", senderIsOwner: false, config: {} } as never, deps);
      await expect(
        tool.execute("blocked", {
          conversationRef: conversation.conversationRef,
          message: "blocked",
        }),
      ).rejects.toThrow("require owner access");
    }
    expect(deps.runMessageActionMock).not.toHaveBeenCalled();
    for (const name of ["conversations_list", "conversations_send", "conversations_turn"]) {
      expect(GATEWAY_OWNER_ONLY_CORE_TOOLS).toContain(name);
      expect(DEFAULT_GATEWAY_HTTP_TOOL_DENY).toContain(name);
    }
  });
});
