import { describe, expect, it, vi } from "vitest";
import {
  createFollowupRun,
  createMinimalRunAgentTurnParams,
  createMockReplyOperation,
  getExecuteAgentTurnForTest,
  setupAgentRunnerExecutionTestState,
} from "./agent-runner-execution.test-support.js";
import type { EmbeddedAgentParams } from "./agent-runner-execution.test-support.js";

const state = await setupAgentRunnerExecutionTestState();
const { executeAgentTurn } = await import("./agent-runner-execution.js");

describe("executeAgentTurn contract", () => {
  it("returns one closed settled result with winner and fallback facts", async () => {
    state.runEmbeddedAgentMock.mockResolvedValue({
      payloads: [{ text: "done" }],
      meta: {
        durationMs: 1,
        agentMeta: { provider: "anthropic", model: "claude-sonnet" },
      },
    });

    const result = await executeAgentTurn(createMinimalRunAgentTurnParams());

    expect(result).toMatchObject({
      runId: expect.any(String),
      outcome: {
        kind: "settled",
        status: "ok",
        resolved: { provider: "anthropic", model: "claude" },
        fallback: { exhausted: false, attempts: [] },
        result: { payloads: [{ text: "done" }] },
      },
    });
  });

  it("keeps publisher-only compaction counts presentation-only after a late user abort", async () => {
    state.runEmbeddedAgentMock.mockResolvedValue({
      payloads: [{ text: "late reply" }],
      meta: { durationMs: 1, agentMeta: { compactionCount: 1, compactionTokensAfter: 40 } },
    });
    const { replyOperation } = createMockReplyOperation();
    let operationResult: typeof replyOperation.result = null;
    const lateAbortedOperation = {
      ...replyOperation,
      get result() {
        return operationResult;
      },
      freezeAbort: () => {
        operationResult = { kind: "aborted", code: "aborted_by_user" };
      },
    };

    const result = await executeAgentTurn(
      createMinimalRunAgentTurnParams({ replyOperation: lateAbortedOperation }),
    );

    expect(result.outcome).toEqual({
      kind: "aborted",
      reason: "user",
      compaction: { count: 1, durable: [] },
    });
  });
});

describe("executeAgentTurn: cancellation retirement on freeze", () => {
  it("retires queued cancellation ownership when execution freezes", async () => {
    const { replyOperation } = createMockReplyOperation();
    const onCancellationRetired = vi.fn();
    const followupRun = createFollowupRun();
    followupRun.turnAdoptionLifecycle = {
      onAdopted: async () => {},
      onCancellationRetired,
    };
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      params.onExecutionPhase?.({ phase: "model_call_started" });
      return { payloads: [{ text: "ok" }], meta: {} };
    });

    const execute = await getExecuteAgentTurnForTest();
    await execute({
      ...createMinimalRunAgentTurnParams({ followupRun }),
      replyOperation,
    });

    expect(onCancellationRetired).toHaveBeenCalledTimes(1);
  });

  it("does not retire queued cancellation ownership on a pre-start failure that is retryable", async () => {
    const { replyOperation } = createMockReplyOperation();
    const onCancellationRetired = vi.fn();
    const followupRun = createFollowupRun();
    followupRun.turnAdoptionLifecycle = {
      onAdopted: async () => {},
      onCancellationRetired,
    };
    state.resolveCurrentTurnImagesMock.mockRejectedValueOnce(new Error("image resolution failed"));

    const execute = await getExecuteAgentTurnForTest();
    await expect(
      execute(createMinimalRunAgentTurnParams({ followupRun, replyOperation })),
    ).rejects.toThrow("image resolution failed");

    expect(onCancellationRetired).not.toHaveBeenCalled();
  });

  it("retires queued cancellation ownership when a started execution throws", async () => {
    const { replyOperation } = createMockReplyOperation();
    const onCancellationRetired = vi.fn();
    const followupRun = createFollowupRun();
    followupRun.turnAdoptionLifecycle = {
      onAdopted: async () => {},
      onCancellationRetired,
    };
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      params.onExecutionPhase?.({ phase: "model_call_started" });
      throw new Error("model execution failed after start");
    });

    const execute = await getExecuteAgentTurnForTest();
    const result = await execute(createMinimalRunAgentTurnParams({ followupRun, replyOperation }));

    expect(result.kind).toBe("final");
    expect(onCancellationRetired).toHaveBeenCalledTimes(1);
  });
});
