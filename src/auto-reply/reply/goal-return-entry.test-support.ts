import type { SubagentRunRecord } from "../../agents/subagents/registry/subagent-registry.types.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import {
  bindGoalContinuationExecution,
  finishGoalContinuationSettlement,
  prepareGoalContinuationContext,
  promoteGoalContinuationYield,
  readGoalContinuationContext,
  withGoalContinuationSettlement,
} from "./goal-continuation-return.js";

/** Observe the real caller's retained return; never manufacture a return scope. */
export function createGoalReturnEntryProbe(target: {
  agentId: string;
  sessionKey: string;
  sessionId: string;
  agentHarnessId: string;
}) {
  const entry: InternalSessionEntry = {
    sessionId: target.sessionId,
    agentHarnessId: target.agentHarnessId,
    updatedAt: 1,
    goal: {
      schemaVersion: 1,
      id: "entry-goal",
      status: "active",
      objective: "Finish the delegated checklist",
      createdAt: 1,
      updatedAt: 1,
      tokenStart: 0,
      tokensUsed: 0,
      continuationTurns: 0,
    },
  };
  const child: SubagentRunRecord = {
    runId: "entry-child",
    childSessionKey: `agent:${target.agentId}:subagent:entry-child`,
    childAgentId: target.agentId,
    requesterSessionKey: target.sessionKey,
    requesterAgentId: target.agentId,
    requesterDisplayKey: target.sessionKey,
    task: "Verify the checklist",
    cleanup: "keep",
    createdAt: 1,
    execution: { status: "terminal", endedAt: 2, outcome: { status: "ok" } },
    completionRequesterSessionId: target.sessionId,
    requesterSettleWake: {
      status: "dispatching",
      attemptCount: 1,
      requesterYieldBatch: true,
      rearmGeneration: 1,
      batchRunIds: ["entry-child"],
    },
  };
  return {
    entry,
    yieldFrom(runId: string) {
      bindGoalContinuationExecution(runId, target.sessionKey);
      promoteGoalContinuationYield({
        entries: [child],
        requesterTurnRunId: runId,
        rearmGeneration: 1,
      });
    },
    readContext() {
      return withGoalContinuationSettlement(
        [child],
        "entry-settle",
        () => true,
        () => {
          const params = { runId: "entry-settle", sessionKey: target.sessionKey };
          prepareGoalContinuationContext({ ...params, sessionEntry: entry });
          return readGoalContinuationContext(params);
        },
      );
    },
    release: () => finishGoalContinuationSettlement([child], false),
  };
}
