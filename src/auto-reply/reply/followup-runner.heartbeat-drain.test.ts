import { afterEach, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { createReplyOperation } from "../../sessions/session-controller.js";
import { cleanupReplyAgentRun } from "./agent-runner-core.js";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";
import {
  createFollowupTurnTestTurn,
  executeFollowupTurnForTest,
  getFollowupTurnTestState,
  resetFollowupTurnTestState,
} from "./followup-turn-execution.test-support.js";
import { createQueueSettings, createQueueTestRun } from "./queue.test-helpers.js";
import { enqueueFollowupRun } from "./queue/enqueue.js";
import { clearFollowupQueue, getExistingFollowupQueue } from "./queue/state.js";
import { createMockTypingController } from "./test-helpers.js";

const key = "followup-cleanup-drain";
afterEach(() => {
  clearFollowupQueue(key);
  vi.useRealTimers();
});

it("does not pass cleanup defaults into a queued execution", async () => {
  resetFollowupTurnTestState();
  const turn = createFollowupTurnTestTurn();
  try {
    await executeFollowupTurnForTest({
      turn,
      defaults: {
        typing: createMockTypingController(),
        typingMode: "never",
        defaultModel: "claude",
        opts: {
          cleanupBundleMcpOnRunEnd: true,
          bootstrapContextMode: "lightweight",
          sourceReplyDeliveryMode: "message_tool_only",
        },
      },
      onToolResult: async () => {},
      onCompactionNoticePayload: async () => {},
    });
    const execution: AgentTurnParams = getFollowupTurnTestState().execute.mock.calls[0]![0];
    expect(execution.opts).toMatchObject({
      cleanupBundleMcpOnRunEnd: undefined,
      bootstrapContextMode: undefined,
      sourceReplyDeliveryMode: undefined,
    });
  } finally {
    turn.operation.complete();
    await turn.operation.ownerSettlement;
  }
});

it("cleanup wakes the registered source runner only after its operation clears", async ({
  signal,
}) => {
  vi.useFakeTimers();
  const settled = createDeferred();
  const sourceRunner = vi.fn(async () => {});
  const cleanupRunner = vi.fn(async () => {});
  const queued = createQueueTestRun(
    {
      prompt: "user message",
      turnAdoptionLifecycle: {
        admission: "cancel-only",
        onAdopted() {},
        onSettled: () => settled.resolve(),
      },
    },
    { sessionKey: key },
  );
  const operation = createReplyOperation({
    sessionKey: key,
    sessionId: queued.run.sessionId,
    agentId: queued.run.agentId,
    resetTriggered: false,
  });
  try {
    expect(
      enqueueFollowupRun(
        key,
        queued,
        createQueueSettings({ mode: "followup" }),
        "none",
        sourceRunner,
        false,
      ),
    ).toBe(true);
    await cleanupReplyAgentRun({
      blockReplyPipeline: null,
      providedReplyOperation: operation,
      replyOperation: operation,
      queueKey: key,
      sessionKey: key,
      runFollowupTurn: cleanupRunner,
      shouldDrainQueuedFollowupsAfterClear: true,
      typing: createMockTypingController(),
    });
    expect(sourceRunner).not.toHaveBeenCalled();
    operation.complete();
    await withinTest(operation.ownerSettlement, signal);
    await vi.advanceTimersByTimeAsync(0);
    await withinTest(settled.promise, signal);
    expect(sourceRunner).toHaveBeenCalledOnce();
    expect(cleanupRunner).not.toHaveBeenCalled();
    expect(getExistingFollowupQueue(key)).toBeUndefined();
  } finally {
    operation.complete();
    await operation.ownerSettlement;
  }
});
