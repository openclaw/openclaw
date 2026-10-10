import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { cleanupReplyAgentRun } from "./agent-runner-core.js";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";
import type { admitFollowupTurn } from "./followup-turn-admission.js";
import {
  createFollowupTurnTestTypingController,
  createFollowupTurnTestTurn,
  getFollowupTurnTestState,
  resetFollowupTurnTestState,
} from "./followup-turn-execution.test-support.js";
import {
  clearFollowupQueueForTest,
  createQueueSettings,
  createQueueTestRun,
} from "./queue.test-helpers.js";
import { scheduleFollowupDrain } from "./queue/drain.js";
import { enqueueFollowupRun } from "./queue/enqueue.js";
import { getExistingFollowupQueue } from "./queue/state.js";
import { FollowupRunDeferredError } from "./queue/types.js";
import { createMockReplyOperation } from "./test-helpers.js";

// mock-isolation: Keep database admission outside this queue-to-execution ownership proof.
vi.mock("./followup-turn-admission.js", () => ({
  admitFollowupTurn: async ({ queued }: Parameters<typeof admitFollowupTurn>[0]) => ({
    kind: "admitted",
    turn: createFollowupTurnTestTurn({ runId: "queued-user-run", queued }),
  }),
}));

// mock-isolation: An aborted stub turn needs no result accounting or worker initialization.
vi.mock("./agent-runner-result-accounting.js", () => ({
  accountFollowupTurn: async () => undefined,
}));

// mock-isolation: Inspect execution options without loading outbound transport/plugin runtimes.
vi.mock("./followup-delivery.js", () => ({
  resolveFollowupDeliveryDecision: async () => ({ kind: "suppress", reason: "aborted" }),
  deliverFollowupDecision: async () => ({ kind: "completed", payloads: [] }),
}));

const { createFollowupRunner } = await import("./followup-runner.js");
const state = getFollowupTurnTestState();
const key = "followup-heartbeat-drain";

beforeEach(() => {
  vi.useFakeTimers();
  resetFollowupTurnTestState();
});

afterEach(() => {
  clearFollowupQueueForTest(key);
  vi.useRealTimers();
});

it("keeps heartbeat cleanup options out of a deferred queued user turn", async ({ signal }) => {
  const firstStarted = createDeferred();
  const releaseFirst = createDeferred();
  const settled = createDeferred();
  let attempts = 0;
  let retriedExecution: AgentTurnParams | undefined;
  state.execute.mockImplementation(async (params: AgentTurnParams) => {
    if (++attempts === 1) {
      firstStarted.resolve();
      await releaseFirst.promise;
      throw new FollowupRunDeferredError("reply lane busy");
    }
    retriedExecution = params;
    return { runId: "queued-user-run", outcome: { kind: "aborted", reason: "user" } };
  });
  const typing = createFollowupTurnTestTypingController();
  const userRunner = createFollowupRunner({
    typing,
    typingMode: "never",
    defaultModel: "gpt-test",
    opts: {},
  });
  const heartbeatRunner = createFollowupRunner({
    typing,
    typingMode: "never",
    defaultModel: "gpt-test",
    opts: {
      isHeartbeat: true,
      useHeartbeatFailureCopy: true,
      cleanupBundleMcpOnRunEnd: true,
      enableHeartbeatTool: true,
      forceHeartbeatTool: true,
      sourceReplyDeliveryMode: "message_tool_only",
      bootstrapContextMode: "lightweight",
    },
  });
  const run = createQueueTestRun({ prompt: "user message", messageId: "user-message" });
  run.run.sessionKey = key;
  run.turnAdoptionLifecycle = {
    admission: "cancel-only",
    onAdopted: () => {},
    onSettled: () => settled.resolve(),
  };
  expect(
    enqueueFollowupRun(
      key,
      run,
      createQueueSettings({ mode: "followup" }),
      "none",
      userRunner,
      false,
    ),
  ).toBe(true);
  try {
    scheduleFollowupDrain(key, userRunner);
    await withinTest(firstStarted.promise, signal);
    const { replyOperation: heartbeatOperation } = createMockReplyOperation({ key });
    await cleanupReplyAgentRun({
      blockReplyPipeline: null,
      clearRestartRecoveryDeliveryClaim: async () => {},
      isHeartbeat: true,
      providedReplyOperation: heartbeatOperation,
      queueKey: key,
      replyOperation: heartbeatOperation,
      runFollowupTurn: heartbeatRunner,
      sessionKey: key,
      shouldDrainQueuedFollowupsAfterClear: true,
      typing,
    });
    releaseFirst.resolve();
    await withinTest(settled.promise, signal);
    await vi.runAllTimersAsync();

    expect(getExistingFollowupQueue(key)).toBeUndefined();
    expect(state.execute).toHaveBeenCalledTimes(2);
    expect(retriedExecution).toMatchObject({
      isHeartbeat: false,
      opts: { isHeartbeat: false },
    });
    for (const option of [
      "enableHeartbeatTool",
      "forceHeartbeatTool",
      "useHeartbeatFailureCopy",
      "cleanupBundleMcpOnRunEnd",
      "bootstrapContextMode",
      "sourceReplyDeliveryMode",
    ] as const) {
      expect(retriedExecution?.opts?.[option], option).toBeUndefined();
    }
  } finally {
    releaseFirst.resolve();
  }
});
