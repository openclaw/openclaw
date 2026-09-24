import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import { createCodexDynamicToolBridge } from "../extensions/codex/test-api.js";
import type {
  ConversationSendResult,
  ConversationTurnResult,
} from "../packages/gateway-protocol/src/schema/agent.js";
import {
  createConversationsSendTool,
  createConversationsTurnTool,
} from "../src/agents/tools/conversation-tools.js";
import { callAgentToolGatewayRequest } from "../src/agents/tools/in-process-gateway.js";
import { resolveConversation } from "../src/config/sessions/conversation-registry.js";

const conversationRef = "conv_0123456789abcdef0123456789abcdef";
const destination = { conversationRef, channel: "qa-channel" };

describe("Codex core conversation delivery", () => {
  it.each([
    {
      name: "sent without a platform ID",
      toolName: "conversations_send",
      receipt: { ...destination, status: "sent" },
      delivered: true,
      success: true,
    },
    ...(["sent", "queued", "suppressed", "unknown"] as const).map((status) => ({
      name: `send ${status} with a platform ID`,
      toolName: "conversations_send" as const,
      receipt: { ...destination, status, messageId: "outbound-1" },
      delivered: status === "sent",
      success: true,
    })),
    {
      name: "replied",
      toolName: "conversations_turn",
      receipt: {
        ...destination,
        status: "replied",
        messageId: "outbound-1",
        correlationPersisted: true,
        reply: { conversationRef, messageId: "inbound-1", text: "Received", timestamp: 1 },
      },
      delivered: true,
      success: true,
    },
    {
      name: "peer reply timeout after send",
      toolName: "conversations_turn",
      receipt: {
        ...destination,
        status: "timeout",
        messageId: "outbound-1",
        correlationPersisted: true,
      },
      delivered: true,
      success: false,
    },
    ...(["sent", "queued", "suppressed", "unknown"] as const).map((status) => ({
      name: `turn ${status} with a correlation error`,
      toolName: "conversations_turn" as const,
      receipt: {
        ...destination,
        status,
        messageId: "outbound-1",
        correlationPersisted: status === "sent" || status === "queued",
        error: "No process-local reply waiter remains.",
      },
      delivered: status === "sent",
      success: false,
    })),
  ] satisfies Array<{
    name: string;
    toolName: "conversations_send" | "conversations_turn";
    receipt: ConversationSendResult | ConversationTurnResult;
    delivered: boolean;
    success: boolean;
  }>)("records $name without changing the Gateway result", async (testCase) => {
    const deps = { callGateway: callAgentToolGatewayRequest, resolveConversation };
    const callGateway = vi.spyOn(deps, "callGateway").mockResolvedValue(testCase.receipt);
    const createTool =
      testCase.toolName === "conversations_send"
        ? createConversationsSendTool
        : createConversationsTurnTool;
    const tool = createTool({ agentId: "main" }, deps);
    const bridge = createCodexDynamicToolBridge({
      tools: [tool],
      signal: new AbortController().signal,
    });
    const onAgentToolResult = vi.fn();
    const response = await bridge.handleToolCall(
      {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "conversation-call",
        namespace: null,
        tool: tool.name,
        arguments: { conversationRef, message: "Synthetic external message" },
      },
      { onAgentToolResult },
    );

    expect(callGateway).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        method: testCase.toolName.replace("_", "."),
        params: expect.objectContaining({ conversationRef, message: "Synthetic external message" }),
      }),
    );
    const observed = onAgentToolResult.mock.calls[0]?.[0];
    expect(observed?.result.details).toEqual(testCase.receipt);
    expect(Value.Check(tool.outputSchema!, observed?.result.details)).toBe(true);
    expect(response.success).toBe(testCase.success);
    expect(response.terminate).toBeUndefined();
    expect(bridge.telemetry.didSendViaMessagingTool).toBe(testCase.delivered);
    expect(bridge.telemetry.messagingToolSentTexts).toEqual(
      testCase.delivered ? ["Synthetic external message"] : [],
    );
    expect(bridge.telemetry.messagingToolSentTargets).toEqual(
      testCase.delivered
        ? [
            expect.objectContaining({
              tool: tool.name,
              provider: "conversation",
              to: conversationRef,
            }),
          ]
        : [],
    );
  });
});
