import { vi } from "vitest";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import type { SubagentRunRecord } from "../../agents/subagents/registry/subagent-registry.types.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { ReplyOperation } from "../../sessions/session-controller.contracts.js";
import { createReplyOperation } from "../../sessions/session-controller.operation.js";
import {
  bindGoalContinuationExecution,
  prepareGoalContinuationYield,
  promoteGoalContinuationYield,
  withGoalContinuationSettlement,
  prepareGoalContinuationContext,
  readGoalContinuationContext,
  recordGoalContinuationSettlement,
  finishGoalContinuationSettlement,
} from "./goal-continuation-return.js";
import { createGoalContinuationReturn, enqueueGoalContinuation } from "./goal-continuation.js";
import type { FollowupRun } from "./queue/types.js";

export const identity = {
  sessionId: "goal-session",
  lifecycleRevision: "revision-2",
  goalId: "goal-1",
};
export const normal: EmbeddedAgentRunResult = {
  meta: { durationMs: 0, stopReason: "end_turn" },
  payloads: [{ text: "More work remains." }],
};
export const operations = new Set<ReplyOperation>();
export function entry(): SessionEntry {
  return {
    sessionId: identity.sessionId,
    lifecycleRevision: "revision-2",
    updatedAt: 2000,
    goal: {
      schemaVersion: 1,
      id: identity.goalId,
      status: "active",
      objective: "Finish the checklist",
      createdAt: 1000,
      updatedAt: 1000,
      tokenStart: 0,
      tokensUsed: 0,
      continuationTurns: 0,
    },
  };
}
export function fixture() {
  const controller = new AbortController();
  const operation = createReplyOperation({
    sessionKey: "agent:main:goal",
    sessionId: identity.sessionId,
    resetTriggered: false,
    upstreamAbortSignal: controller.signal,
  });
  operations.add(operation);
  const base: FollowupRun = {
    prompt: "Initial user request",
    enqueuedAt: 1000,
    abortSignal: controller.signal,
    run: {
      agentId: "main",
      agentDir: "/fixture",
      sessionId: identity.sessionId,
      sessionKey: "agent:main:goal",
      sessionFile: "agent:main:goal",
      workspaceDir: "/fixture",
      config: {},
      provider: "test",
      model: "test",
      timeoutMs: 10000,
      blockReplyBreak: "text_end",
    },
  };
  const params: Parameters<typeof enqueueGoalContinuation>[0] = {
    base,
    result: normal,
    initialGoalId: identity.goalId,
    expectedSession: identity,
    sessionKey: "agent:main:goal",
    storePath: "/fixture/sessions.json",
    queueKey: "agent:main:goal",
    settings: { mode: "followup", debounceMs: 0 },
    sourceRunId: "run-1",
    operation,
    runFollowup: vi.fn(async () => {}),
  };
  return { params, controller, operation };
}
export function retainedGoal(existingChild?: SubagentRunRecord, sessionEntry = entry()) {
  const f = fixture();
  const child: SubagentRunRecord = existingChild ?? {
    runId: "goal-child",
    childSessionKey: "agent:main:subagent:goal-child",
    childAgentId: "main",
    requesterSessionKey: f.params.sessionKey,
    requesterAgentId: "main",
    requesterDisplayKey: f.params.sessionKey,
    task: "Verify the first item",
    cleanup: "keep",
    createdAt: 1000,
    execution: { status: "terminal", endedAt: 1100, outcome: { status: "ok" } },
    completionRequesterSessionId: identity.sessionId,
    completionRequesterLifecycleRevision: identity.lifecycleRevision,
    requesterSettleWake: {
      status: "dispatching",
      attemptCount: 1,
      requesterYieldBatch: true,
      rearmGeneration: 1,
      batchRunIds: ["goal-child"],
    },
  };
  const publish = (
    verifiedSettlement = true,
    runId = "settle-run",
    result = normal,
    succeeded = true,
  ) =>
    withGoalContinuationSettlement(
      [child],
      "settle-run",
      () => true,
      () => {
        if (verifiedSettlement) {
          prepareGoalContinuationContext({
            runId,
            sessionKey: f.params.sessionKey,
            sessionEntry,
          });
        }
        const context = readGoalContinuationContext({ runId, sessionKey: f.params.sessionKey });
        recordGoalContinuationSettlement({
          runId,
          sessionKey: f.params.sessionKey,
          result,
          succeeded,
        });
        return context;
      },
    );
  const retain = (beforeYield?: () => void | Promise<void>) =>
    createGoalContinuationReturn(f.params)(async () => {
      await bindGoalContinuationExecution(f.params.sourceRunId, f.params.sessionKey);
      await beforeYield?.();
      await prepareGoalContinuationYield({
        requesterTurnRunId: f.params.sourceRunId,
        entries: [child],
      });
      promoteGoalContinuationYield({
        requesterTurnRunId: f.params.sourceRunId,
        entries: [child],
        rearmGeneration: child.requesterSettleWake?.rearmGeneration,
      });
    });
  return {
    ...f,
    child,
    retain,
    publish,
    finish: (delivered = true) => finishGoalContinuationSettlement([child], delivered),
  };
}
