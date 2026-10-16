import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConversationListResultSchema,
  ConversationSendResultSchema,
  ConversationTurnResultSchema,
} from "../../../packages/gateway-protocol/src/schema/agent.js";
import {
  DEFAULT_GATEWAY_HTTP_TOOL_DENY,
  GATEWAY_OWNER_ONLY_CORE_TOOLS,
} from "../../security/dangerous-tools.js";
import { compactToolOutputHint } from "../tool-schema-hints.js";
import {
  createConversationsListTool,
  createConversationsSendTool,
  createConversationsTurnTool,
} from "./conversation-tools.js";
import * as gateway from "./in-process-gateway.js";

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

function mockGateway() {
  return vi.spyOn(gateway, "callAgentToolGatewayRequest").mockImplementation(async (input) =>
    input.method === "conversations.list"
      ? {
          conversations: [
            {
              conversationRef: conversation.conversationRef,
              channel: conversation.channel,
              accountId: conversation.accountId,
              kind: conversation.kind,
              target: conversation.target,
              firstSeenAt: conversation.firstSeenAt,
              lastSeenAt: conversation.lastSeenAt,
            },
          ],
        }
      : input.method === "conversations.send"
        ? {
            status: "sent" as const,
            conversationRef: conversation.conversationRef,
            channel: "reef",
            messageId: "reef-outbound-1",
            queueId: "queue-1",
          }
        : {
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
          },
  );
}

describe("conversation tools", () => {
  afterEach(() => vi.restoreAllMocks());
  it("declares exact Gateway output contracts and promotes only bounded complete hints", async () => {
    mockGateway();
    const list = createConversationsListTool({ agentId: "main" });
    const send = createConversationsSendTool({ agentId: "main" });
    const turn = createConversationsTurnTool({ agentId: "main" });
    const listResult = await list.execute("list-contract", {});
    const sendResult = await send.execute("send-contract", {
      conversationRef: conversation.conversationRef,
      message: "hello peer",
    });
    const turnResult = await turn.execute("turn-contract", {
      conversationRef: conversation.conversationRef,
      message: "please acknowledge",
    });

    expect(list.outputSchema).toBe(ConversationListResultSchema);
    expect(send.outputSchema).toBe(ConversationSendResultSchema);
    expect(turn.outputSchema).toBe(ConversationTurnResultSchema);
    expect(Value.Check(list.outputSchema!, listResult.details)).toBe(true);
    expect(Value.Check(send.outputSchema!, sendResult.details)).toBe(true);
    expect(Value.Check(turn.outputSchema!, turnResult.details)).toBe(true);
    expect(compactToolOutputHint(list.outputSchema)).toBe(
      '{ conversations: Array<{ accountId: string; channel: string; conversationRef: string; firstSeenAt: number; kind: "direct" | "group" | "channel"; lastSeenAt: number; target: string; label?: string; threadId?: string }> }',
    );
    expect(compactToolOutputHint(send.outputSchema)).toBe(
      '{ channel: string; conversationRef: string; status: "sent" | "queued" | "suppressed" | "unknown"; messageId?: string; queueId?: string }',
    );
    expect(compactToolOutputHint(turn.outputSchema)).toBe(
      '{ channel: string; conversationRef: string; correlationPersisted: boolean; messageId: string; reply: { conversationRef: string; messageId: string; text: string; timestamp: number; replyToId?: string; threadId?: string; transcriptArtifactId?: string; transcriptMessageId?: string }; status: "replied" } | { channel: string; conversationRef: string; correlationPersisted: boolean; messageId: string; status: "timeout" } | { channel: string; conversationRef: string; correlationPersisted: boolean; error: string; status: "sent" | "queued" | "suppressed" | "unknown"; messageId?: string }',
    );
  });

  it("lists opaque external addresses independently from sessions", async () => {
    const callGateway = mockGateway();
    const result = await createConversationsListTool({ agentId: "main" }).execute("list", {
      channel: "reef",
      query: "@peer-agent",
    });

    expect(callGateway).toHaveBeenCalledWith({
      method: "conversations.list",
      params: { agentId: "main", channel: "reef", query: "@peer-agent", limit: 50 },
    });
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

  it("routes sends through the Gateway with a stable operation id", async () => {
    const callGateway = mockGateway();
    const tool = createConversationsSendTool({
      agentId: "main",
      agentSessionId: "operator-session",
      agentSessionKey: "agent:main:telegram:direct:operator",
      config: {},
    });
    const args = {
      conversationRef: conversation.conversationRef,
      message: "hello peer",
    };

    const firstResult = await tool.execute("tool-call-1", args);
    const secondResult = await tool.execute("tool-call-1", args);
    const first = callGateway.mock.calls[0]![0];
    const second = callGateway.mock.calls[1]![0];

    expect(first).toMatchObject({
      method: "conversations.send",
      params: {
        agentId: "main",
        sourceSessionKey: "agent:main:telegram:direct:operator",
        conversationRef: conversation.conversationRef,
        message: "hello peer",
      },
      config: {},
    });
    expect(first.params).toMatchObject({
      operationId: expect.stringMatching(/^convop_[a-f0-9]{32}$/u),
    });
    expect(second.params).toEqual(first.params);
    expect(firstResult.details).toEqual(secondResult.details);
    expect(firstResult.details).toMatchObject({
      status: "sent",
      messageId: "reef-outbound-1",
      queueId: "queue-1",
    });
  });

  it("reports Gateway suppression without claiming delivery", async () => {
    const callGateway = mockGateway();
    callGateway.mockResolvedValueOnce({
      status: "suppressed",
      conversationRef: conversation.conversationRef,
      channel: "reef",
      queueId: "queue-suppressed",
    });

    const result = await createConversationsSendTool({ agentId: "main", config: {} }).execute(
      "suppressed-call",
      {
        conversationRef: conversation.conversationRef,
        message: "suppressed hello",
      },
    );

    expect(result.details).toEqual({
      status: "suppressed",
      conversationRef: conversation.conversationRef,
      channel: "reef",
      queueId: "queue-suppressed",
    });
  });

  it("keeps a transient Gateway send failure retryable under the stable tool call id", async () => {
    const callGateway = mockGateway();
    callGateway.mockRejectedValueOnce(new Error("gateway unavailable"));
    const tool = createConversationsSendTool({ agentId: "main", config: {} });
    const args = {
      conversationRef: conversation.conversationRef,
      message: "retry me",
    };

    await expect(tool.execute("retryable-call", args)).rejects.toThrow("gateway unavailable");
    await expect(tool.execute("retryable-call", args)).resolves.toMatchObject({
      details: { status: "sent", messageId: "reef-outbound-1" },
    });
    const first = callGateway.mock.calls[0]![0];
    const second = callGateway.mock.calls[1]![0];
    expect(second.params).toEqual(first.params);
  });

  it("uses a stable operation id for correlated turns and cancels on abort", async () => {
    const callGateway = mockGateway();
    const tool = createConversationsTurnTool({
      agentId: "main",
      agentSessionId: "operator-session",
      agentSessionKey: "agent:main:telegram:direct:operator",
      config: {},
    });
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

    const first = callGateway.mock.calls[0]![0];
    const second = callGateway.mock.calls[1]![0];
    expect(first.params).toMatchObject({ turnId: expect.stringMatching(/^convop_[a-f0-9]{32}$/u) });
    expect(second.params).toEqual(first.params);
    const request = vi.fn().mockResolvedValue({ cancelled: true });
    await first.onSignalAbort?.(request);
    expect(request).toHaveBeenCalledWith(
      "conversations.turn.cancel",
      { agentId: "main", turnId: expect.any(String) },
      { timeoutMs: 5_000 },
    );
    expect(first.params).toMatchObject(request.mock.calls[0]?.[1]);
  });

  it("validates references and owner access before Gateway delivery", async () => {
    const callGateway = mockGateway();
    await expect(
      createConversationsSendTool({ agentId: "main", config: {} }).execute("send", {
        conversationRef: "not-a-conversation",
        message: "hello",
      }),
    ).rejects.toThrow("Invalid conversationRef");

    for (const createTool of [
      createConversationsListTool,
      createConversationsSendTool,
      createConversationsTurnTool,
    ]) {
      const tool = createTool({ agentId: "main", senderIsOwner: false, config: {} });
      await expect(
        tool.execute("blocked", {
          conversationRef: conversation.conversationRef,
          message: "blocked",
        }),
      ).rejects.toThrow("require owner access");
    }
    expect(callGateway).not.toHaveBeenCalled();
    for (const name of ["conversations_list", "conversations_send", "conversations_turn"]) {
      expect(GATEWAY_OWNER_ONLY_CORE_TOOLS).toContain(name);
      expect(DEFAULT_GATEWAY_HTTP_TOOL_DENY).toContain(name);
    }
  });
});
