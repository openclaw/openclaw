import { describe, expect, it } from "vitest";
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

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const pending = runAgentTurnWithFallback({
      ...createMinimalRunAgentTurnParams({ replyOperation }),
      pendingToolTasks: new Set([pendingToolTask]),
    });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(settled).toBe(false);
    releaseToolTask();

    await expect(pending).resolves.toEqual({
      kind: "final",
      payload: {
        text: "⚠️ This turn was interrupted because it stopped making progress. Please try again.",
        isError: true,
      },
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

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const pending = runAgentTurnWithFallback({
      ...createMinimalRunAgentTurnParams({ replyOperation }),
      pendingToolTasks: new Set([pendingToolTask]),
    });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(settled).toBe(false);
    releaseToolTask();

    await expect(pending).resolves.toEqual({
      kind: "final",
      payload: {
        text: "⚠️ This turn was interrupted because it stopped making progress. Please try again.",
        isError: true,
      },
    });
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
