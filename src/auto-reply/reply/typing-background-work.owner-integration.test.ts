import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { observeAgentRunHumanWait } from "../../agents/agent-run-approval-wait.js";
import { observeSubagentExecution } from "../../agents/subagents/registry/subagent-execution-observation.js";
import { subagentRuns } from "../../agents/subagents/registry/subagent-registry-memory.js";
import {
  resetSubagentRegistryForTests,
  seedSubagentRunForReadTest,
} from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import { createAskUserTool } from "../../agents/tools/ask-user-tool.js";
import { resetPendingAskUserQuestionsForTest } from "../../agents/tools/ask-user-tool.test-support.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../../infra/agent-run-registry.js";
import { createReplyBackgroundWorkObserver } from "./typing-background-work.runtime.js";
import { createTypingController } from "./typing.js";

type GatewayCall = Extract<
  NonNullable<Parameters<typeof createAskUserTool>[0]["gatewayCall"]>,
  (...args: never[]) => unknown
>;

const args = {
  questions: [
    {
      id: "choice",
      header: "Choice",
      question: "Select one",
      options: [{ label: "A" }, { label: "B" }],
    },
  ],
};

const requesterRunId = "typing-human-wait-requester";
const requesterSessionKey = "agent:main:discord:channel:typing-human-wait";
const childRunId = "typing-human-wait-child";
const childSessionKey = "agent:main:subagent:typing-human-wait";
const childSessionId = "typing-human-wait-child-session";

let controller: ReturnType<typeof createTypingController> | undefined;
let workObserver: ReturnType<typeof createReplyBackgroundWorkObserver> | undefined;
let humanWait: ReturnType<typeof observeAgentRunHumanWait> | undefined;
let childClaimId: string | undefined;
let successorClaimId: string | undefined;

beforeEach(() => {
  setRuntimeConfigSnapshot({});
});

afterEach(async () => {
  controller?.cleanup();
  controller = undefined;
  workObserver?.dispose();
  workObserver = undefined;
  humanWait?.dispose();
  humanWait = undefined;
  if (childClaimId) {
    releaseAgentRunContext(childRunId, childClaimId);
  }
  childClaimId = undefined;
  if (successorClaimId) {
    releaseAgentRunContext("typing-human-wait-successor", successorClaimId);
  }
  successorClaimId = undefined;
  resetPendingAskUserQuestionsForTest();
  await resetSubagentRegistryForTests({ persist: false });
  clearRuntimeConfigSnapshot();
  vi.useRealTimers();
});

it("keeps the exact answered ask_user child suspended until execution resumes", async ({
  signal,
}) => {
  await resetSubagentRegistryForTests({ persist: false });
  const now = Date.now();
  seedSubagentRunForReadTest({
    runId: childRunId,
    childSessionKey,
    childAgentId: "main",
    requesterSessionKey,
    requesterAgentId: "main",
    requesterTurnRunId: requesterRunId,
    requesterTurnYielded: true,
    expectsCompletionMessage: true,
    generation: 1,
    createdAt: now,
    execution: { status: "running", startedAt: now },
  });
  childClaimId = claimAgentRunContext(
    childRunId,
    { sessionKey: childSessionKey, sessionId: childSessionId, agentId: "main" },
    { trackOwner: true, ownsContext: true, protectFromSweep: true },
  );
  expect(childClaimId).toBeDefined();
  emitAgentEvent({
    runId: childRunId,
    sessionKey: childSessionKey,
    sessionId: childSessionId,
    stream: "execution",
    data: { state: "running", sourceId: "agent", executionId: "child-initial-execution" },
  });
  expect(observeSubagentExecution(subagentRuns.get(childRunId)!, []).state).toBe("running");

  const workWaiting = createDeferred();
  const workResumed = createDeferred();
  const workFinished = createDeferred();
  let sawChildWait = false;
  const starts = vi.fn();
  const pauses = vi.fn();
  const cleanups = vi.fn();
  workObserver = createReplyBackgroundWorkObserver({
    sessionKey: requesterSessionKey,
    runId: requesterRunId,
    onChange: (state) => {
      if (state === "waiting") {
        sawChildWait = true;
        workWaiting.resolve();
      }
      if (state === "active" && sawChildWait) {
        workResumed.resolve();
      }
      if (state === "none") {
        workFinished.resolve();
      }
    },
  });
  controller = createTypingController({
    onReplyStart: starts,
    onCleanup: cleanups,
    typingIntervalSeconds: 60,
  });
  const shouldRetainCallbacks = controller.shouldRetainChannelCallbacks;
  if (!shouldRetainCallbacks) {
    throw new Error("expected the opt-in controller custody hook");
  }
  controller.setBackgroundWorkPause?.(pauses, "discord/test-account/typing-human-wait");
  controller.bindRunIdentity?.(
    requesterRunId,
    requesterSessionKey,
    "typing-human-wait-requester-session",
  );
  await controller.startTypingLoop();
  expect(workObserver.currentState()).toBe("active");
  controller.markRunComplete();
  controller.markDispatchIdle();

  const answerStarted = createDeferred();
  const promptDelivered = createDeferred();
  const waitStarted = createDeferred();
  const resumeRequired = createDeferred();
  let questionId: unknown;
  let finishAnswer: ((value: unknown) => void) | undefined;
  humanWait = observeAgentRunHumanWait({ runId: childRunId, sessionKey: childSessionKey });
  humanWait.onChange = (snapshot) => {
    if (snapshot.waiting) {
      waitStarted.resolve();
    }
    if (snapshot.resumeRequired) {
      resumeRequired.resolve();
    }
  };
  const gatewayCall = (async (
    method: string,
    _opts: Record<string, unknown>,
    params: Record<string, unknown>,
  ) => {
    if (method === "question.request") {
      questionId = params.id;
      return { id: params.id };
    }
    if (method === "question.waitAnswer") {
      answerStarted.resolve();
      return await new Promise((resolve) => {
        finishAnswer = resolve;
      });
    }
    if (method === "question.resolve") {
      return { status: "cancelled" };
    }
    throw new Error("unexpected Gateway question method");
  }) as GatewayCall;
  const pending = createAskUserTool({
    runId: childRunId,
    sessionKey: childSessionKey,
    gatewayCall,
    questionPrompt: { send: () => promptDelivered.resolve() },
  }).execute("call-typing-human-wait", args);

  await withinTest(
    awaitGateBeforeSettlement(answerStarted.promise, pending, "ask_user answer RPC did not start"),
    signal,
  );
  await withinTest(
    awaitGateBeforeSettlement(promptDelivered.promise, pending, "ask_user prompt did not deliver"),
    signal,
  );
  await withinTest(
    awaitGateBeforeSettlement(
      waitStarted.promise,
      pending,
      "ask_user wait event was not published",
    ),
    signal,
  );
  await withinTest(workWaiting.promise, signal);
  expect(humanWait.waiting).toBe(true);
  expect(workObserver.currentState()).toBe("waiting");
  expect(pauses).toHaveBeenCalledTimes(1);
  expect(shouldRetainCallbacks()).toBe(true);
  const startsWhileWaiting = starts.mock.calls.length;

  // A generic activity projection can still say "running" while this exact
  // ask_user execution is waiting. The exact owner must keep typing paused.
  emitAgentEvent({
    runId: childRunId,
    sessionKey: childSessionKey,
    sessionId: childSessionId,
    stream: "execution",
    data: { state: "running", sourceId: "agent", executionId: "generic-running-projection" },
  });
  expect(observeSubagentExecution(subagentRuns.get(childRunId)!, []).state).toBe("running");
  expect(humanWait.waiting).toBe(true);
  expect(workObserver.currentState()).toBe("waiting");
  expect(starts).toHaveBeenCalledTimes(startsWhileWaiting);

  finishAnswer?.({ status: "answered", answers: { answers: { choice: ["A"] } } });
  await expect(pending).resolves.toMatchObject({ details: { status: "answered" } });
  await withinTest(resumeRequired.promise, signal);
  expect(starts.mock.calls.length).toBe(startsWhileWaiting);
  expect(humanWait.waiting).toBe(false);
  expect(humanWait.resumeRequired).toBe(true);
  expect(observeSubagentExecution(subagentRuns.get(childRunId)!, []).state).toBe("unknown");
  expect(workObserver.currentState()).toBe("waiting");
  expect(shouldRetainCallbacks()).toBe(true);

  expect(typeof questionId).toBe("string");
  emitAgentEvent({
    runId: childRunId,
    sessionKey: childSessionKey,
    sessionId: childSessionId,
    stream: "execution",
    data: { state: "running", sourceId: "ask_user", executionId: questionId },
  });
  await withinTest(workResumed.promise, signal);
  expect(workObserver.currentState()).toBe("active");
  expect(controller.isActive()).toBe(true);
  expect(starts.mock.calls.length).toBeGreaterThan(startsWhileWaiting);
  const startsAfterResume = starts.mock.calls.length;

  emitAgentEvent({
    runId: childRunId,
    sessionKey: childSessionKey,
    sessionId: childSessionId,
    stream: "lifecycle",
    data: { phase: "end" },
  });
  await withinTest(workFinished.promise, signal);
  expect(shouldRetainCallbacks()).toBe(false);
  expect(controller.isActive()).toBe(false);
  expect(cleanups).toHaveBeenCalledTimes(1);

  const successorRunId = "typing-human-wait-successor";
  const successorSessionId = "typing-human-wait-successor-session";
  seedSubagentRunForReadTest({
    runId: successorRunId,
    childSessionKey,
    childAgentId: "main",
    requesterSessionKey,
    requesterAgentId: "main",
    requesterTurnRunId: requesterRunId,
    requesterTurnYielded: true,
    expectsCompletionMessage: true,
    generation: 2,
    createdAt: now + 1,
    execution: { status: "running", startedAt: now + 1 },
  });
  successorClaimId = claimAgentRunContext(
    successorRunId,
    { sessionKey: childSessionKey, sessionId: successorSessionId, agentId: "main" },
    { trackOwner: true, ownsContext: true, protectFromSweep: true },
  );
  expect(successorClaimId).toBeDefined();
  emitAgentEvent({
    runId: successorRunId,
    sessionKey: childSessionKey,
    sessionId: successorSessionId,
    stream: "execution",
    data: { state: "unknown", sourceId: "unattributed", executionId: "fresh-execution" },
  });
  const freshObserver = createReplyBackgroundWorkObserver({
    sessionKey: requesterSessionKey,
    runId: requesterRunId,
    onChange: vi.fn(),
  });
  try {
    expect(freshObserver.currentState()).toBe("none");
    expect(shouldRetainCallbacks()).toBe(false);
    expect(starts.mock.calls.length).toBe(startsAfterResume);
  } finally {
    freshObserver.dispose();
    if (successorClaimId) {
      releaseAgentRunContext(successorRunId, successorClaimId);
    }
    successorClaimId = undefined;
  }
});
