import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { createReplyOperation } from "../../sessions/session-controller.js";
import { AgentDatabaseExecutionAdmissionClosedError } from "../../state/agent-database-admission-error.js";
import { cleanupReplyAgentRun } from "./agent-runner-core.js";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";
import {
  createFollowupTurnTestTypingController,
  createFollowupTurnTestTurn,
  getFollowupTurnTestState,
  resetFollowupTurnTestState,
} from "./followup-turn-execution.test-support.js";
import {
  createQueueSettings,
  createQueueTestRun,
  rejectQueuePreparation,
} from "./queue.test-helpers.js";
import { scheduleFollowupDrain } from "./queue/drain.js";
import { enqueueFollowupRun } from "./queue/enqueue.js";
import { clearFollowupQueue, getExistingFollowupQueue } from "./queue/state.js";
import type { FollowupRun } from "./queue/types.js";
import type { prepareReplyAgentTurn } from "./reply-agent-turn-preparation.js";

const admissionState = vi.hoisted(() => ({
  beforeAdmission: vi.fn<(queued: FollowupRun) => Promise<void>>(),
}));

// mock-isolation: Keep database admission outside this queue-to-execution ownership proof.
vi.mock("./reply-agent-turn-preparation.js", () => ({
  prepareReplyAgentTurn: async ({ queued }: Parameters<typeof prepareReplyAgentTurn>[0]) => {
    await admissionState.beforeAdmission(queued);
    return {
      kind: "admitted",
      turn: createFollowupTurnTestTurn({ runId: "queued-user-run", queued }),
    };
  },
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
  admissionState.beforeAdmission.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  clearFollowupQueue(key);
  vi.useRealTimers();
});

it("keeps heartbeat cleanup options out of a deferred queued user turn", async ({ signal }) => {
  const firstStarted = createDeferred();
  const releaseFirst = createDeferred();
  const settled = createDeferred();
  let retriedExecution: AgentTurnParams | undefined;
  admissionState.beforeAdmission.mockImplementationOnce(async (queued) => {
    firstStarted.resolve();
    await releaseFirst.promise;
    rejectQueuePreparation(
      queued,
      new AgentDatabaseExecutionAdmissionClosedError("database is still closing"),
    );
  });
  state.execute.mockImplementation(async (params: AgentTurnParams) => {
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
  const heartbeatOperation = createReplyOperation({
    sessionKey: key,
    sessionId: run.run.sessionId,
    agentId: run.run.agentId,
    resetTriggered: false,
    turnKind: "heartbeat",
  });
  try {
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
    heartbeatOperation.complete();
    await withinTest(heartbeatOperation.ownerSettlement, signal);
    scheduleFollowupDrain(key, userRunner);
    await withinTest(firstStarted.promise, signal);
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
    await vi.advanceTimersByTimeAsync(0);

    expect(getExistingFollowupQueue(key)).toBeUndefined();
    expect(admissionState.beforeAdmission).toHaveBeenCalledTimes(2);
    expect(state.execute).toHaveBeenCalledOnce();
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
    heartbeatOperation.complete();
    await heartbeatOperation.ownerSettlement;
  }
});
