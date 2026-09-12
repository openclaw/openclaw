import { describe, expect, it } from "vitest";
import {
  createMinimalRunAgentTurnParams,
  createMockReplyOperation,
  type EmbeddedAgentParams,
  getExecuteAgentTurnForTest,
  setupAgentRunnerExecutionTestState,
} from "./agent-runner-execution.test-support.js";

const state = await setupAgentRunnerExecutionTestState();

describe("executeAgentTurn: backend progress", () => {
  it("refreshes only the reply operation that launched the candidate", async () => {
    const { replyOperation: owner } = createMockReplyOperation();
    const { replyOperation: successor } = createMockReplyOperation();
    let ownerActivityCount = 0;
    let successorActivityCount = 0;
    owner.recordActivity = () => {
      ownerActivityCount += 1;
    };
    successor.recordActivity = () => {
      successorActivityCount += 1;
    };
    let reportLateProgress: (() => void) | undefined;
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      params.onRunProgress?.({ reason: "notification:item/started", backend: "codex-app-server" });
      reportLateProgress = () => params.onRunProgress?.({ reason: "notification:item/completed" });
      return { payloads: [{ text: "ok" }], meta: {} };
    });

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    await executeAgentTurn(createMinimalRunAgentTurnParams({ replyOperation: owner }));

    expect(ownerActivityCount).toBe(1);
    reportLateProgress?.();
    expect(ownerActivityCount).toBe(2);
    expect(successorActivityCount).toBe(0);
  });
});
