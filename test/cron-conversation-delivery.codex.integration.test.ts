import { describe, expect, it, vi } from "vitest";
import { makeIsolatedAgentParamsFixture } from "../src/cron/isolated-agent/job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "../src/cron/isolated-agent/run.suite-helpers.js";
import {
  loadRunCronIsolatedAgentTurn,
  mockRunCronFallbackPassthrough,
  pickLastNonEmptyTextFromPayloadsMock,
  runEmbeddedAgentMock,
  runWithModelFallbackMock,
} from "../src/cron/isolated-agent/run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

describe("Codex conversation delivery and cron retry", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it.each(["sent", "queued"] as const)(
    "preserves the retry decision for a %s core conversation receipt",
    async (status) => {
      const { createCodexDynamicToolBridge } = await import("../extensions/codex/test-api.js");
      const { createConversationsSendTool } =
        await import("../src/agents/tools/conversation-tools.js");
      const { callAgentToolGatewayRequest } =
        await import("../src/agents/tools/in-process-gateway.js");
      const { resolveConversation } =
        await import("../src/config/sessions/conversation-registry.js");
      pickLastNonEmptyTextFromPayloadsMock.mockImplementation(
        (payloads?: Array<{ text?: string }>) => payloads?.at(-1)?.text ?? "",
      );
      const conversationRef = "conv_0123456789abcdef0123456789abcdef";
      const deps = { callGateway: callAgentToolGatewayRequest, resolveConversation };
      const callGateway = vi.spyOn(deps, "callGateway").mockResolvedValue({
        status,
        conversationRef,
        channel: "qa-channel",
        messageId: "prepared-id",
      });
      runEmbeddedAgentMock
        .mockImplementationOnce(async () => {
          const tool = createConversationsSendTool({ agentId: "main" }, deps);
          const bridge = createCodexDynamicToolBridge({
            tools: [tool],
            signal: new AbortController().signal,
          });
          const response = await bridge.handleToolCall({
            threadId: "cron-thread",
            turnId: "cron-turn",
            callId: "cron-send",
            namespace: null,
            tool: tool.name,
            arguments: { conversationRef, message: "Synthetic scheduled report" },
          });
          expect(response.success, JSON.stringify(response)).toBe(true);
          return {
            payloads: [{ text: "On it." }],
            didSendViaMessagingTool: bridge.telemetry.didSendViaMessagingTool,
            meta: { agentMeta: { usage: { input: 10, output: 20 } } },
          };
        })
        .mockResolvedValueOnce({
          payloads: [{ text: "Report delivery is still queued." }],
          meta: { agentMeta: { usage: { input: 10, output: 20 } } },
        });
      mockRunCronFallbackPassthrough();

      const attempts = status === "sent" ? 1 : 2;
      const result = await runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture());
      expect(result.error).toBeUndefined();
      expect(result).toMatchObject({ status: "ok" });
      expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(attempts);
      expect(runWithModelFallbackMock).toHaveBeenCalledTimes(attempts);
      expect(callGateway).toHaveBeenCalledOnce();
    },
  );
});
