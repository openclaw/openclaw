import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractMessagingToolSourceReplyPayload } from "../../agents/embedded-agent-messaging-extraction.js";
import type { RunEmbeddedAgentInternalParams } from "../../agents/embedded-agent-runner/run/internal-params.js";
import { createOpenClawToolsAsync } from "../../agents/openclaw-tools.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { withSessionTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
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
        | Awaited<
            ReturnType<Awaited<ReturnType<typeof createOpenClawToolsAsync>>[number]["execute"]>
          >
        | undefined;
      let sendError: unknown;
      runAgent.mockImplementationOnce(async (runParams: RunEmbeddedAgentInternalParams) => {
        // Exercise the actual runner policy and tool factory while the run owns delivery.
        const message = (
          await createOpenClawToolsAsync({
            config: runParams.config,
            agentSessionKey: runParams.sessionKey,
            workspaceDir: runParams.workspaceDir,
            runId: runParams.runId,
            agentChannel: runParams.messageProvider,
            currentChannelId: runParams.currentChannelId,
            requireExplicitMessageTarget: runParams.requireExplicitMessageTarget,
            sourceReplyDeliveryMode: runParams.sourceReplyDeliveryMode,
          })
        ).find((tool) => tool.name === "message");
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
  it("retains revoked source authority at runtime admission", async () => {
    const followupRun = createFollowupRun();
    followupRun.run.sessionKey = "agent:main:dashboard:source-authority";
    const isCli = runtime === "cli";
    const provider = isCli ? "claude-cli" : "anthropic";
    const model = isCli ? "sonnet-4.6" : "claude";
    followupRun.run.provider = provider;
    followupRun.run.model = model;
    state.isCliProviderMock.mockReturnValue(isCli);
    await useProductionEmbeddedRunExecutionParamsForTest();
    let current = true;
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      return {
        result: await params.run(provider, model, initialFallbackAttemptOptions(params)),
        provider,
        model,
        attempts: [],
      };
    });
    const runAgent = isCli ? state.runCliAgentMock : state.runEmbeddedAgentMock;
    let sourceFailure: unknown;
    let admissionFailure: unknown;
    runAgent.mockImplementationOnce(async (params: RunEmbeddedAgentInternalParams) => {
      current = false;
      try {
        params.preparedRunAdmission!.assertSourceCurrent();
      } catch (error) {
        sourceFailure = error;
      }
      // CLI is already admitted by its candidate owner; embedded admission is
      // deferred to the runner. Both must retain the original live authority.
      if (!isCli) {
        try {
          await params.preparedRunAdmission!.admit(runtime, "source-test-runtime");
        } catch (error) {
          admissionFailure = error;
        }
      }
      return { payloads: [], meta: {} };
    });
    const execute = await getExecuteAgentTurnForTest();
    const params = createMinimalRunAgentTurnParams({
      followupRun,
      opts: { isHeartbeat: true },
    });
    params.isHeartbeat = true;
    params.storePath = path.join(followupRun.run.workspaceDir, "sessions.json");
    params.sessionKey = followupRun.run.sessionKey;
    const entry = await replaceSessionEntry(
      {
        agentId: followupRun.run.agentId,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
      },
      { sessionId: followupRun.run.sessionId, updatedAt: 1 },
    );
    expect(entry).not.toBeNull();
    params.getActiveSessionEntry = () => entry ?? undefined;
    await withSessionTranscriptWriteAssertion(
      {
        agentId: followupRun.run.agentId,
        sessionId: followupRun.run.sessionId,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
      },
      () => {
        if (!current) {
          throw new Error("source revoked");
        }
      },
      () => execute(params),
    );
    expect(runAgent).toHaveBeenCalledOnce();
    expect(sourceFailure).toBeInstanceOf(Error);
    expect(String(sourceFailure)).toContain("source revoked");
    if (!isCli) {
      expect(admissionFailure).toBeInstanceOf(Error);
      expect(String(admissionFailure)).toContain("source revoked");
    }
  });
});
