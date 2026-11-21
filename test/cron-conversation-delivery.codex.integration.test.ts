import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../src/config/runtime-snapshot.js";
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
  afterEach(() => {
    vi.restoreAllMocks();
    clearRuntimeConfigSnapshot();
  });

  it.each(["sent", "queued"] as const)(
    "does not infer another model turn from a %s core conversation receipt",
    async (status) => {
      const params = makeIsolatedAgentParamsFixture();
      setRuntimeConfigSnapshot(params.cfg);
      const { createCodexDynamicToolBridge } = await import("../extensions/codex/test-api.js");
      const { createHostedConversationTools } =
        await import("../src/agents/tools/conversation-tools.js");
      const gateway = await import("../src/agents/tools/in-process-gateway.js");
      pickLastNonEmptyTextFromPayloadsMock.mockImplementation(
        (payloads?: Array<{ text?: string }>) => payloads?.at(-1)?.text ?? "",
      );
      const conversationRef = "conv_0123456789abcdef0123456789abcdef";
      const callGateway = vi.spyOn(gateway, "callAgentToolGatewayRequest").mockResolvedValue({
        status,
        conversationRef,
        channel: "qa-channel",
        messageId: "prepared-id",
      });
      runEmbeddedAgentMock.mockImplementationOnce(async () => {
        const tool = expectDefined(
          createHostedConversationTools(undefined, "main", {}).find(
            (entry) => entry.name === "conversations_send",
          ),
          "conversation send tool",
        );
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
          meta: {
            terminalReply: { disposition: "visible", text: "On it." },
            agentMeta: { usage: { input: 10, output: 20 } },
          },
        };
      });
      mockRunCronFallbackPassthrough();

      const result = await runCronIsolatedAgentTurn(params);
      expect(result.error).toBeUndefined();
      expect(result).toMatchObject({ status: "ok" });
      expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
      expect(runWithModelFallbackMock).toHaveBeenCalledOnce();
      expect(callGateway).toHaveBeenCalledOnce();
    },
  );
});
