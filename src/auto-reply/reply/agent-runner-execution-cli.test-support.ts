import { beforeEach } from "vitest";
import type { RunCliAgentParams } from "../../agents/cli-runner/types.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import {
  createFollowupRun,
  createMinimalRunAgentTurnParams,
  getExecuteAgentTurnForTest,
  runInitialFallbackAttempt,
  setupAgentRunnerExecutionTestState,
  type FallbackRunnerParams,
} from "./agent-runner-execution.test-support.js";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";

export async function setupCliExecutionTest(model: string) {
  const state = await setupAgentRunnerExecutionTestState();
  beforeEach(() => {
    state.isCliProviderMock.mockReturnValue(true);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await runInitialFallbackAttempt(params, "claude-cli", model),
      provider: "claude-cli",
      model,
      attempts: [],
    }));
  });
  return {
    state,
    mockEvents(
      this: void,
      events: Array<[string, Record<string, unknown>]>,
      payloads: ReplyPayload[],
      meta = {},
      onRun?: (params: RunCliAgentParams) => void,
    ) {
      const run = { id: "" };
      state.runCliAgentMock.mockImplementationOnce(async (params: RunCliAgentParams) => {
        run.id = params.runId;
        onRun?.(params);
        const { emitAgentEvent } = await import("../../infra/agent-events.js");
        for (const [stream, data] of events) {
          emitAgentEvent({ runId: params.runId, stream, data });
        }
        return { payloads, meta };
      });
      return run;
    },
    async execute(
      this: void,
      opts: GetReplyOptions,
      runOverrides: Partial<ReturnType<typeof createFollowupRun>["run"]> = {},
      turnOverrides: Partial<
        Pick<AgentTurnParams, "commandBody" | "blockStreamingEnabled" | "sessionKey">
      > = {},
    ) {
      const followupRun = createFollowupRun();
      Object.assign(followupRun.run, { provider: "claude-cli", model }, runOverrides);
      return (await getExecuteAgentTurnForTest())({
        ...createMinimalRunAgentTurnParams({
          followupRun,
          opts,
          sessionCtx: { Provider: "telegram", MessageSid: "msg" },
        }),
        ...turnOverrides,
      });
    },
  };
}
