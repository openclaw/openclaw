import { assert, expect, it } from "vitest";
import { PROVIDER_CONVERSATION_STATE_ERROR_USER_MESSAGE } from "../../agents/failover/user-copy.js";
import { WorkerNodeLostError } from "../../worker/worker-node-loss.js";
import {
  setupAgentRunnerExecutionTestState,
  getExecuteAgentTurnForTest,
  createFollowupRun,
  createMinimalRunAgentTurnParams,
  GENERIC_RUN_FAILURE_TEXT,
  NON_DIRECT_FAILURE_SURFACE_CASES,
  createNonDirectFailureSessionCtx,
} from "./agent-runner-execution.test-support.js";

const state = await setupAgentRunnerExecutionTestState();
const executeAgentTurn = await getExecuteAgentTurnForTest();

async function internalFailure(error: Error) {
  state.isInternalMessageChannelMock.mockReturnValue(true);
  state.runEmbeddedAgentMock.mockRejectedValueOnce(error);
  return (await getExecuteAgentTurnForTest())({
    ...createMinimalRunAgentTurnParams({
      sessionCtx: { Provider: "chat", Surface: "chat", MessageSid: "msg" },
    }),
    commandBody: "hello",
  });
}

it("preserves typed node-loss guidance on internal control surfaces", async () => {
  state.isInternalMessageChannelMock.mockReturnValue(true);
  const failure = new WorkerNodeLostError();
  state.runEmbeddedAgentMock.mockRejectedValueOnce(failure);
  const result = await executeAgentTurn(createMinimalRunAgentTurnParams());
  expect(result).toMatchObject({
    kind: "final",
    payload: { text: `${failure.message} This turn will not be continued automatically.` },
  });
  expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
});

it.each([NON_DIRECT_FAILURE_SURFACE_CASES[0]])(
  "surfaces a safe failure for an accepted request in $label chats",
  async (testCase) => {
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new Error("openai/gpt-5.5 ended with an incomplete terminal response"),
    );

    const result = await executeAgentTurn(
      createMinimalRunAgentTurnParams({
        sessionCtx: createNonDirectFailureSessionCtx(testCase),
      }),
    );

    assert(result.kind === "final");
    expect(result.payload).toMatchObject({ text: GENERIC_RUN_FAILURE_TEXT, isError: true });
    expect(result.payload.text).not.toContain("openai/gpt-5.5");
  },
);

it("does not auto-reset role-ordering provider conversation-state errors", async () => {
  const followupRun = createFollowupRun();
  const sessionEntry = {
    sessionId: followupRun.run.sessionId,
    lifecycleRevision: "original-generation",
    updatedAt: 1,
  };
  const sessionSnapshot = { ...sessionEntry };
  const sessionStore = { main: sessionEntry };
  state.runEmbeddedAgentMock.mockRejectedValueOnce(new Error("400 Incorrect role information"));

  const result = await executeAgentTurn({
    ...createMinimalRunAgentTurnParams({
      followupRun,
      sessionCtx: { Provider: "telegram", ChatId: "chat-1" },
    }),
    commandBody: "hello",
    getActiveSessionEntry: () => sessionStore.main,
    activeSessionStore: sessionStore,
  });

  expect(followupRun.run.sessionId).toBe(sessionSnapshot.sessionId);
  expect(sessionStore.main).toEqual(sessionSnapshot);
  assert(result.kind === "final");
  expect(result.payload.text).toBe(PROVIDER_CONVERSATION_STATE_ERROR_USER_MESSAGE);
});

it("shows recovery guidance without provider diagnostics on internal control surfaces", async () => {
  const providerError = "provider failed with actionable details";
  const result = await internalFailure(new Error(providerError));

  assert(result.kind === "final");
  expect(result.payload.text).toContain("OpenClaw couldn't finish this reply.");
  expect(result.payload.text).not.toContain(providerError);
  expect(result.payload.text).toContain("openclaw logs --follow");
  expect(result.payload.text).toMatch(/terminal/i);
});

it("preserves curated execution-node recovery on internal control surfaces", async () => {
  const result = await internalFailure(
    new Error(
      "Codex execution node disconnected; start a fresh attempt. (execution node failed: node disconnected (codex.exec-server.stdio.v1))",
    ),
  );

  assert(result.kind === "final");
  expect(result.payload.text).toMatch(/Codex execution node disconnected.*fresh attempt/iu);
});
