import { expect, it } from "vitest";
import { AgentHarnessPreflightError } from "../../agents/harness/errors.js";
import { onAgentRuntimeEvent } from "../../infra/agent-events.js";
import {
  createMinimalRunAgentTurnParams,
  createMockReplyOperation,
  getExecuteAgentTurnForTest,
  setupAgentRunnerExecutionTestState,
} from "./agent-runner-execution.test-support.js";

const state = await setupAgentRunnerExecutionTestState();
const userMessage =
  "OpenCode cannot run with this chat's tool restrictions. Choose a different model provider or update the tool settings.";
it("delivers public preflight copy without verbose diagnostic disclosure", async () => {
  const cause = new Error("private-cause-canary 529 overloaded");
  const error = new AgentHarnessPreflightError("private-diagnostic-canary", {
    cause,
    scope: "harness",
    userMessage,
  });
  state.runEmbeddedAgentMock.mockRejectedValueOnce(error);
  state.isInternalMessageChannelMock.mockReturnValue(false);
  const { replyOperation, failMock } = createMockReplyOperation();
  const params = createMinimalRunAgentTurnParams({ replyOperation });
  params.sessionCtx = {
    ...params.sessionCtx,
    Provider: "telegram",
    Surface: "telegram",
    ChatType: "direct",
  };
  params.resolvedVerboseLevel = "on";
  const executeAgentTurn = await getExecuteAgentTurnForTest();
  const terminalErrors: unknown[] = [];
  const unsubscribe = onAgentRuntimeEvent((event) => {
    if (event.stream === "lifecycle" && event.data.phase === "error") {
      terminalErrors.push(event.data.error);
    }
  });
  try {
    const result = await executeAgentTurn(params);
    expect(state.runWithModelFallbackMock).toHaveBeenCalledOnce();
    expect(state.runEmbeddedAgentMock).toHaveBeenCalledOnce();
    expect(failMock).toHaveBeenCalledWith("run_failed", error);
    expect(terminalErrors).toEqual([userMessage]);
    expect(result).toMatchObject({
      kind: "final",
      payload: { text: userMessage, isError: true },
    });
  } finally {
    unsubscribe();
  }
});
