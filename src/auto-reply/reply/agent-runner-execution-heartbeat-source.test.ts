import { describe, expect, it } from "vitest";
import { extractMessagingToolSourceReplyPayload } from "../../agents/embedded-agent-messaging-extraction.js";
import type { RunEmbeddedAgentInternalParams } from "../../agents/embedded-agent-runner/run/internal-params.js";
import { createOpenClawTools } from "../../agents/openclaw-tools.js";
import {
  createFollowupRun,
  createMinimalRunAgentTurnParams,
  getExecuteAgentTurnForTest,
  initialFallbackAttemptOptions,
  setupAgentRunnerExecutionTestState,
  useProductionEmbeddedRunExecutionParamsForTest,
  type FallbackRunnerParams,
} from "./agent-runner-execution.test-support.js";

const state = await setupAgentRunnerExecutionTestState();

describe.each(["cli", "embedded"] as const)("heartbeat %s source delivery", (runtime) => {
  it.each([false, true, undefined])(
    "honors the admitted explicit-target policy (%s) at message-tool creation",
    async (requireExplicitMessageTarget) => {
      const sessionKey = "agent:main:dashboard:completion";
      const followupRun = createFollowupRun();
      followupRun.run.sessionKey = sessionKey;
      followupRun.run.messageProvider = "webchat";
      followupRun.run.sourceReplyDeliveryMode = "message_tool_only";
      followupRun.originatingChannel = "webchat";
      followupRun.originatingTo = sessionKey;
      followupRun.originatingChatType = "direct";
      const isCli = runtime === "cli";
      const provider = isCli ? "claude-cli" : "anthropic";
      const model = isCli ? "sonnet-4.6" : "claude";
      followupRun.run.provider = provider;
      followupRun.run.model = model;
      state.isCliProviderMock.mockReturnValue(isCli);
      await useProductionEmbeddedRunExecutionParamsForTest();
      state.runWithModelFallbackMock.mockImplementationOnce(
        async (params: FallbackRunnerParams) => ({
          result: await params.run(provider, model, initialFallbackAttemptOptions(params)),
          provider,
          model,
          attempts: [],
        }),
      );
      const runAgent = isCli ? state.runCliAgentMock : state.runEmbeddedAgentMock;
      let sourceReply:
        | Awaited<ReturnType<ReturnType<typeof createOpenClawTools>[number]["execute"]>>
        | undefined;
      let sendError: unknown;
      runAgent.mockImplementationOnce(async (runParams: RunEmbeddedAgentInternalParams) => {
        // Exercise the actual runner policy and tool factory while the run owns delivery.
        const message = createOpenClawTools({
          config: runParams.config,
          agentSessionKey: runParams.sessionKey,
          workspaceDir: runParams.workspaceDir,
          runId: runParams.runId,
          agentChannel: runParams.messageProvider,
          currentChannelId: runParams.currentChannelId,
          requireExplicitMessageTarget: runParams.requireExplicitMessageTarget,
          sourceReplyDeliveryMode: runParams.sourceReplyDeliveryMode,
        }).find((tool) => tool.name === "message");
        if (!message) {
          throw new Error("message tool was not created");
        }
        try {
          sourceReply = await message.execute("completion-send", {
            action: "send",
            message: "WEBCHAT_SOURCE_REPLY",
          });
        } catch (error) {
          sendError = error;
        }
        return { payloads: [], meta: {} };
      });
      const opts = { isHeartbeat: true, requireExplicitMessageTarget };
      const params = createMinimalRunAgentTurnParams({
        followupRun,
        opts,
        sessionCtx: {
          Provider: "webchat",
          Surface: "webchat",
          OriginatingChannel: "webchat",
          OriginatingTo: sessionKey,
          To: sessionKey,
          ChatType: "direct",
          SessionKey: sessionKey,
        },
      });
      params.isHeartbeat = true;
      params.sessionKey = sessionKey;
      const executeAgentTurn = await getExecuteAgentTurnForTest();
      const result = await executeAgentTurn(params);
      expect(result.kind).toBe("success");
      expect(runAgent).toHaveBeenCalledOnce();
      if (requireExplicitMessageTarget === false) {
        expect(sendError).toBeUndefined();
        expect(sourceReply?.details).toMatchObject({
          channel: "webchat",
          sourceReplySink: "internal-ui",
        });
        expect(extractMessagingToolSourceReplyPayload(sourceReply)?.text).toBe(
          "WEBCHAT_SOURCE_REPLY",
        );
      } else {
        expect(sendError).toBeInstanceOf(Error);
        expect(String(sendError)).toMatch(/Explicit message target required/);
        expect(sourceReply).toBeUndefined();
      }
    },
  );
});
