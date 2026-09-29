import { describe, expect, it } from "vitest";
import { PROVIDER_CONVERSATION_STATE_ERROR_USER_MESSAGE } from "../../agents/failover/user-copy.js";
import type { TemplateContext } from "../templating.js";
import {
  createAgentTurnExecutionDefaults,
  setupAgentRunnerExecutionTestState,
  getExecuteAgentTurnForTest,
  createRunAgentTurnParams,
  createMockTypingSignaler,
  createFollowupRun,
  createMinimalRunAgentTurnParams,
  GENERIC_RUN_FAILURE_TEXT,
  NON_DIRECT_FAILURE_SURFACE_CASES,
  createNonDirectFailureSessionCtx,
} from "./agent-runner-execution.test-support.js";

const state = await setupAgentRunnerExecutionTestState();

describe("executeAgentTurn: conversation failures", () => {
  it.each(NON_DIRECT_FAILURE_SURFACE_CASES)(
    "surfaces a safe failure for an accepted request in $label chats",
    async (testCase) => {
      state.runEmbeddedAgentMock.mockRejectedValueOnce(
        new Error("openai/gpt-5.5 ended with an incomplete terminal response"),
      );

      const executeAgentTurn = await getExecuteAgentTurnForTest();
      const result = await executeAgentTurn(
        createMinimalRunAgentTurnParams({
          sessionCtx: createNonDirectFailureSessionCtx(testCase),
        }),
      );

      expect(result.kind).toBe("final");
      if (result.kind === "final") {
        expect(result.payload).toMatchObject({ text: GENERIC_RUN_FAILURE_TEXT, isError: true });
        expect(result.payload.text).not.toContain("openai/gpt-5.5");
      }
    },
  );

  it("returns a session reset hint for Bedrock tool mismatch errors on external chat channels", async () => {
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new Error(
        "The number of toolResult blocks at messages.186.content exceeds the number of toolUse blocks of previous turn.",
      ),
    );

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn(createRunAgentTurnParams(createFollowupRun()));

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(PROVIDER_CONVERSATION_STATE_ERROR_USER_MESSAGE);
    }
  });

  it("returns a provider conversation-state error for OpenAI missing custom tool output errors on external chat channels", async () => {
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new Error("Custom tool call output is missing for call id: call_live_123."),
    );

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "slack",
        ChannelId: "channel-1",
      } as unknown as TemplateContext,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      ...createAgentTurnExecutionDefaults(),
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(PROVIDER_CONVERSATION_STATE_ERROR_USER_MESSAGE);
    }
  });

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

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn({
      commandBody: "hello",
      followupRun,
      sessionCtx: {
        Provider: "telegram",
        ChatId: "chat-1",
      } as unknown as TemplateContext,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      ...createAgentTurnExecutionDefaults(),
      getActiveSessionEntry: () => sessionStore.main,
      activeSessionStore: sessionStore,
    });

    expect(followupRun.run.sessionId).toBe(sessionSnapshot.sessionId);
    expect(sessionStore.main).toEqual(sessionSnapshot);
    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(PROVIDER_CONVERSATION_STATE_ERROR_USER_MESSAGE);
    }
  });

  it("keeps actionable provider errors on internal control surfaces", async () => {
    state.isInternalMessageChannelMock.mockReturnValue(true);
    const providerError = "provider failed with actionable details";
    state.runEmbeddedAgentMock.mockRejectedValueOnce(new Error(providerError));

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "chat",
        Surface: "chat",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      ...createAgentTurnExecutionDefaults(),
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toContain(providerError);
      expect(result.payload.text).toContain("openclaw logs --follow");
      expect(result.payload.text).toMatch(/terminal/i);
    }
  });
});
