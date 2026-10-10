import { afterEach, describe, expect, it } from "vitest";
import {
  createDiscordLoopbackRest,
  discordPlugin,
  sendMessageDiscord,
} from "../extensions/discord/test-api.js";
import { readEmbeddedMessageDeliveryFact } from "../src/agents/embedded-agent-message-delivery.js";
import { installMessageToolOnlyTerminalHook } from "../src/agents/embedded-agent-runner/run/message-tool-terminal.js";
import type { AfterToolCallContext, Agent } from "../src/agents/runtime/index.js";
import { createMessageTool } from "../src/agents/tools/message-tool-execution.js";
import {
  createAgentTurnExecutionDefaults,
  createFollowupRun,
  createMockTypingSignaler,
  fallbackAttemptOptions,
  getExecuteAgentTurnForTest,
  initialFallbackAttemptOptions,
  setupAgentRunnerExecutionTestState,
  type EmbeddedAgentParams,
  type FallbackRunnerParams,
} from "../src/auto-reply/reply/agent-runner-execution.test-support.js";
import type { TemplateContext } from "../src/auto-reply/templating.js";
import type { GetReplyOptions } from "../src/auto-reply/types.js";
import type { MessageActionResult } from "../src/infra/outbound/message-action-contracts.js";
import { setActivePluginRegistry } from "../src/plugins/runtime.js";
import { createTestRegistry } from "../src/test-utils/channel-plugins.js";

const state = await setupAgentRunnerExecutionTestState();

afterEach(() => {
  setActivePluginRegistry(createTestRegistry([]));
});

describe("Discord message-tool terminal delivery", () => {
  it("keeps a delivered source reply final when candidate finalization fails", async () => {
    const loopback = await createDiscordLoopbackRest();
    try {
      const config = {
        channels: { discord: { token: "test-token", groupPolicy: "open" as const } },
      };
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: "discord", source: "test", plugin: discordPlugin }]),
      );
      const messageTool = createMessageTool({
        config,
        agentSessionKey: "agent:main:discord:channel:123",
        agentAccountId: "default",
        currentChannelProvider: "discord",
        currentChannelId: "123",
        currentMessagingTarget: "channel:123",
        sourceReplyDeliveryMode: "message_tool_only",
        sourceReplyOnly: true,
        getScopedChannelsCommandSecretTargets: () => ({ targetIds: new Set<string>() }),
        resolveCommandSecretRefsViaGateway: async ({ config: resolvedConfig }) => ({
          resolvedConfig,
          diagnostics: [],
          targetStatesByPath: {},
          hadUnresolvedTargets: false,
        }),
        runMessageAction: async () => {
          const sendResult = await sendMessageDiscord("channel:123", "Loopback completed answer", {
            cfg: config,
            accountId: "default",
            rest: loopback.rest,
          });
          return {
            kind: "send",
            channel: "discord",
            action: "send",
            to: "channel:123",
            handledBy: "core",
            payload: { ok: true },
            sendResult: {
              channel: "discord",
              to: "channel:123",
              via: "direct",
              mediaUrl: null,
              result: {
                channel: "discord",
                messageId: sendResult.messageId,
                receipt: sendResult.receipt,
              },
            },
            dryRun: false,
          } satisfies MessageActionResult;
        },
      });

      state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
        const args = { action: "send", message: "Loopback completed answer", final: true };
        const toolResult = await messageTool.execute("message-1", args);
        const deliveryFact = readEmbeddedMessageDeliveryFact(
          (toolResult.details as { messageDelivery?: unknown } | undefined)?.messageDelivery,
        );
        expect(deliveryFact).toMatchObject({
          status: "settled",
          partialDelivery: false,
          sourceReplyDelivered: true,
        });
        const agent = {} as Agent;
        installMessageToolOnlyTerminalHook({
          agent,
          sourceReplyDeliveryMode: "message_tool_only",
          onCompletedSourceReply: params.onCompletedSourceReplyDelivered,
        });
        const hookResult = await agent.afterToolCall?.({
          toolCall: { name: "message", arguments: args },
          args,
          result: toolResult,
          isError: false,
        } as unknown as AfterToolCallContext);
        expect(hookResult).toMatchObject({ terminate: true });
        throw new Error("plugin state failed after delivery");
      });
      state.runWithModelFallbackMock.mockImplementationOnce(
        async (params: FallbackRunnerParams) => {
          try {
            return {
              result: await params.run(
                "anthropic",
                "primary",
                initialFallbackAttemptOptions(params),
              ),
              provider: "anthropic",
              model: "primary",
              attempts: [],
            };
          } catch (error) {
            if (params.canFallbackAfterError?.() === false) {
              throw error;
            }
            return {
              result: await params.run(
                "xai",
                "fallback",
                fallbackAttemptOptions(params, "unknown"),
              ),
              provider: "xai",
              model: "fallback",
              attempts: [],
            };
          }
        },
      );

      const executeAgentTurn = await getExecuteAgentTurnForTest();
      const followupRun = createFollowupRun();
      followupRun.run.sourceReplyDeliveryMode = "message_tool_only";
      const result = await executeAgentTurn({
        commandBody: "hello",
        followupRun,
        sessionCtx: { Provider: "discord", MessageSid: "msg" } as unknown as TemplateContext,
        opts: {} satisfies GetReplyOptions,
        typingSignals: createMockTypingSignaler(),
        ...createAgentTurnExecutionDefaults(),
        resolvedVerboseLevel: "on",
      });

      expect(loopback.requests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ method: "POST", path: "/v10/channels/123/messages" }),
        ]),
      );
      expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ kind: "final", payload: { text: "NO_REPLY" } });
    } finally {
      await loopback.close();
    }
  });
});
