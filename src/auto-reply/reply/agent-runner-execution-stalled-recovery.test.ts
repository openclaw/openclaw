import { describe, expect, it, vi } from "vitest";
import {
  createMinimalRunAgentTurnParams,
  getRunAgentTurnWithFallback,
  setupAgentRunnerExecutionTestState,
} from "./agent-runner-execution.test-support.js";
import { HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT } from "./agent-runner-failure-copy.js";
import { createReplyOperation, expireStaleReplyOperation } from "./reply-run-registry.js";

const state = setupAgentRunnerExecutionTestState();

function createStalledReplyOperation(sessionId: string) {
  const replyOperation = createReplyOperation({
    sessionKey: `agent:main:${sessionId}`,
    sessionId,
    resetTriggered: false,
  });
  replyOperation.setPhase("running");
  return replyOperation;
}

describe("runAgentTurnWithFallback: stalled recovery", () => {
  it("surfaces a stalled reply operation after the embedded run returns no payload", async () => {
    const replyOperation = createStalledReplyOperation("stalled-empty-reply");
    state.runEmbeddedAgentMock.mockImplementationOnce(async () => {
      expect(expireStaleReplyOperation(replyOperation, "no_activity")).toBe(true);
      expect(replyOperation.abortSignal.aborted).toBe(true);
      return { payloads: [], meta: {} };
    });
    let releaseToolTask: () => void = () => undefined;
    const pendingToolTask = new Promise<void>((resolve) => {
      releaseToolTask = resolve;
    });
    let toolTaskSettled = false;
    void pendingToolTask.then(() => {
      toolTaskSettled = true;
    });
    const pendingToolTasks = new Set([pendingToolTask]);

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const pending = runAgentTurnWithFallback({
      ...createMinimalRunAgentTurnParams({ replyOperation }),
      pendingToolTasks,
    });
    let result: Awaited<typeof pending> | undefined;
    void pending.then((value) => {
      result = value;
    });
    await vi.waitFor(() => {
      expect(result).toEqual({
        kind: "final",
        payload: {
          text: "⚠️ This turn was interrupted because it stopped making progress. Please try again.",
          isError: true,
        },
      });
    });
    expect(toolTaskSettled).toBe(false);
    releaseToolTask();
    await pendingToolTask;
    await vi.waitFor(() => {
      expect(pendingToolTasks.size).toBe(0);
    });
  });

  it("surfaces a stalled reply operation after its aborted embedded run rejects", async () => {
    const replyOperation = createStalledReplyOperation("stalled-rejected-reply");
    state.runEmbeddedAgentMock.mockImplementationOnce(async () => {
      expect(expireStaleReplyOperation(replyOperation, "no_activity")).toBe(true);
      expect(replyOperation.abortSignal.aborted).toBe(true);
      throw new Error("embedded run aborted after stale recovery");
    });
    let releaseToolTask: () => void = () => undefined;
    const pendingToolTask = new Promise<void>((resolve) => {
      releaseToolTask = resolve;
    });
    let toolTaskSettled = false;
    void pendingToolTask.then(() => {
      toolTaskSettled = true;
    });
    const pendingToolTasks = new Set([pendingToolTask]);

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const pending = runAgentTurnWithFallback({
      ...createMinimalRunAgentTurnParams({ replyOperation }),
      pendingToolTasks,
    });
    let result: Awaited<typeof pending> | undefined;
    void pending.then((value) => {
      result = value;
    });
    await vi.waitFor(() => {
      expect(result).toEqual({
        kind: "final",
        payload: {
          text: "⚠️ This turn was interrupted because it stopped making progress. Please try again.",
          isError: true,
        },
      });
    });
    expect(toolTaskSettled).toBe(false);
    releaseToolTask();
    await pendingToolTask;
    await vi.waitFor(() => {
      expect(pendingToolTasks.size).toBe(0);
    });
  });

  it("surfaces a stalled reply operation when stale recovery interrupts retry backoff", async () => {
    vi.useFakeTimers();
    const replyOperation = createStalledReplyOperation("stalled-retry-backoff");
    state.runEmbeddedAgentMock.mockRejectedValue(new Error("model is overloaded"));

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const pending = runAgentTurnWithFallback(createMinimalRunAgentTurnParams({ replyOperation }));
    await vi.advanceTimersByTimeAsync(0);
    expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(1);

    expect(expireStaleReplyOperation(replyOperation, "no_activity")).toBe(true);
    await vi.advanceTimersByTimeAsync(0);

    await expect(pending).resolves.toEqual({
      kind: "final",
      payload: {
        text: "⚠️ This turn was interrupted because it stopped making progress. Please try again.",
        isError: true,
      },
    });
    expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
  });

  it("uses heartbeat failure copy for a stalled heartbeat operation", async () => {
    const replyOperation = createStalledReplyOperation("stalled-heartbeat");
    state.runEmbeddedAgentMock.mockImplementationOnce(async () => {
      expect(expireStaleReplyOperation(replyOperation, "no_activity")).toBe(true);
      return { payloads: [], meta: {} };
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      ...createMinimalRunAgentTurnParams({ replyOperation }),
      isHeartbeat: true,
    });

    expect(result).toEqual({
      kind: "final",
      payload: {
        text: HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT,
        isError: true,
      },
    });
  });
});
