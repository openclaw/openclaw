import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractMessagingToolSourceReplyPayload } from "../../agents/embedded-agent-messaging-extraction.js";
import type { RunEmbeddedAgentInternalParams } from "../../agents/embedded-agent-runner/run/internal-params.js";
import { createOpenClawToolsAsync } from "../../agents/openclaw-tools.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { withSessionTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
import { makeCronJob } from "../../cron/delivery.test-helpers.js";
import { TEST_SCHEDULED_TURN } from "../../cron/scheduled-occurrence.test-support.js";
import {
  createFollowupRun,
  createMinimalRunAgentTurnParams,
  getExecuteAgentTurnForTest,
  runFallbackCandidate,
  setupAgentRunnerExecutionTestState,
  useProductionEmbeddedRunExecutionParamsForTest,
  type FallbackRunnerParams,
} from "./agent-runner-execution.test-support.js";

const state = await setupAgentRunnerExecutionTestState();

async function prepareRuntime(runtime: "cli" | "embedded", sessionKey: string) {
  const isCli = runtime === "cli";
  const provider = isCli ? "claude-cli" : "anthropic";
  const model = isCli ? "sonnet-4.6" : "claude";
  state.isCliProviderMock.mockReturnValue(isCli);
  await useProductionEmbeddedRunExecutionParamsForTest();
  state.runWithModelFallbackMock.mockImplementationOnce((params: FallbackRunnerParams) =>
    runFallbackCandidate(params, provider, model),
  );
  return {
    followupRun: createFollowupRun({ sessionKey, provider, model }),
    runAgent: isCli ? state.runCliAgentMock : state.runEmbeddedAgentMock,
  };
}

describe.each(["cli", "embedded"] as const)("%s source delivery", (runtime) => {
  it.each([false, true])(
    "requires an explicit message target only for scheduled execution (%s)",
    async (scheduled) => {
      const sessionKey = "agent:main:dashboard:completion";
      const { followupRun, runAgent } = await prepareRuntime(runtime, sessionKey);
      followupRun.run.messageProvider = "webchat";
      followupRun.run.sourceReplyDeliveryMode = "message_tool_only";
      followupRun.originatingChannel = "webchat";
      followupRun.originatingTo = sessionKey;
      followupRun.originatingChatType = "direct";
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
      if (scheduled) {
        followupRun.run.scheduledAutomation = {
          ...TEST_SCHEDULED_TURN,
          job: makeCronJob({ sessionTarget: "session:main", wakeMode: "now" }),
        };
      }
      const params = createMinimalRunAgentTurnParams({
        followupRun,
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
      params.sessionKey = sessionKey;
      const executeAgentTurn = await getExecuteAgentTurnForTest();
      const result = await executeAgentTurn(params);
      expect(result.kind).toBe("success");
      if (!scheduled) {
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
    const sessionKey = "agent:main:dashboard:source-authority";
    const { followupRun, runAgent } = await prepareRuntime(runtime, sessionKey);
    const isCli = runtime === "cli";
    let current = true;
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
    const params = createMinimalRunAgentTurnParams({ followupRun, opts: {} });
    params.storePath = path.join(followupRun.run.workspaceDir, "sessions.json");
    params.sessionKey = sessionKey;
    const target = {
      agentId: followupRun.run.agentId,
      sessionId: followupRun.run.sessionId,
      sessionKey,
      storePath: params.storePath,
    };
    const entry = await replaceSessionEntry(target, {
      sessionId: followupRun.run.sessionId,
      updatedAt: 1,
    });
    expect(entry).not.toBeNull();
    params.getActiveSessionEntry = () => entry ?? undefined;
    await withSessionTranscriptWriteAssertion(
      target,
      () => {
        if (!current) {
          throw new Error("source revoked");
        }
      },
      () => execute(params),
    );
    expect(sourceFailure).toBeInstanceOf(Error);
    expect(String(sourceFailure)).toContain("source revoked");
    if (!isCli) {
      expect(admissionFailure).toBeInstanceOf(Error);
      expect(String(admissionFailure)).toContain("source revoked");
    }
  });
});
