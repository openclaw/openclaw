import { expectDefined } from "@openclaw/normalization-core";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodexDynamicToolBridge } from "../extensions/codex/test-api.js";
import type {
  ConversationSendResult,
  ConversationTurnResult,
} from "../packages/gateway-protocol/src/schema/agent.js";
import { createHostedConversationTools } from "../src/agents/tools/conversation-tools.js";
import * as gateway from "../src/agents/tools/in-process-gateway.js";

const conversationRef = "conv_0123456789abcdef0123456789abcdef";
const destination = { conversationRef, channel: "qa-channel" };
const correlated = { ...destination, messageId: "outbound-1", correlationPersisted: true };
const message = "Synthetic external message";
const reply = { conversationRef, messageId: "inbound-1", text: "Received", timestamp: 1 };

function delivery(
  kind: "send" | "turn",
  receipt: ConversationSendResult | ConversationTurnResult,
  delivered: boolean,
  success = true,
) {
  const name = `${kind} ${receipt.status} ${"messageId" in receipt ? "with ID" : "without ID"}`;
  return { name, kind, receipt, delivered, success };
}

describe("Codex core conversation delivery", () => {
  afterEach(() => vi.restoreAllMocks());
  it.each([
    delivery("send", { ...destination, status: "sent" }, true),
    ...(["sent", "queued"] as const).map((status) =>
      delivery("send", { ...destination, status, messageId: "outbound-1" }, status === "sent"),
    ),
    delivery("turn", { ...correlated, status: "replied", reply }, true),
    delivery("turn", { ...correlated, status: "timeout" }, true, false),
    ...(["sent", "queued"] as const).map((status) =>
      delivery(
        "turn",
        { ...correlated, status, error: "No process-local reply waiter remains." },
        status === "sent",
        false,
      ),
    ),
  ])("records $name without changing the Gateway result", async (testCase) => {
    const callGateway = vi
      .spyOn(gateway, "callAgentToolGatewayRequest")
      .mockResolvedValue(testCase.receipt);
    const tool = expectDefined(
      createHostedConversationTools(undefined, "main", {}).find(
        (entry) => entry.name === `conversations_${testCase.kind}`,
      ),
      "conversation tool",
    );
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
        arguments: { conversationRef, message },
      },
      { onAgentToolResult },
    );

    expect(callGateway).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        method: `conversations.${testCase.kind}`,
        params: expect.objectContaining({ conversationRef, message }),
      }),
    );
    const observed = onAgentToolResult.mock.calls[0]?.[0];
    expect(observed?.result.details).toEqual(testCase.receipt);
    expect(Value.Check(tool.outputSchema!, observed?.result.details)).toBe(true);
    expect(response).toMatchObject({ success: testCase.success, terminate: undefined });
    expect(bridge.telemetry).toMatchObject({
      didSendViaMessagingTool: testCase.delivered,
      messagingToolSentTexts: testCase.delivered ? [message] : [],
      messagingToolSentTargets: testCase.delivered
        ? [
            expect.objectContaining({
              tool: tool.name,
              provider: "conversation",
              to: conversationRef,
            }),
          ]
        : [],
    });
  });
});
