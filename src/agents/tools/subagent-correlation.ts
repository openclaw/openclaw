import type { SubagentRunRecord } from "../subagents/registry/subagent-registry.types.js";

/** Recorded facts only; callers must apply the existing controller scope first. */
export function projectSubagentCorrelation(run: SubagentRunRecord) {
  const wake = run.requesterSettleWake;
  const delivery = run.delivery;
  const custody = delivery?.requesterDelivery;
  const visibleFinal = delivery?.requesterVisibleFinal;
  return {
    runId: run.runId,
    taskRunId: run.taskRunId,
    childSessionKey: run.childSessionKey,
    requesterSessionKey: run.requesterSessionKey,
    requesterTurnRunId: run.requesterTurnRunId,
    controllerSessionKey: run.controllerSessionKey,
    generation: run.generation,
    status: run.pauseReason === "sessions_yield" ? "waiting" : run.execution.status,
    outcome: run.execution.outcome?.status,
    expectsCompletionMessage: run.expectsCompletionMessage,
    wake: wake && {
      status: wake.status,
      requesterRunId: wake.requesterRunId,
      batchRunIds: wake.batchRunIds?.slice(),
      rearmGeneration: wake.rearmGeneration,
      // Admission policy, not evidence that an original final is still owed.
      yieldedFinalDeliverable: wake.yieldedFinalDeliverable,
    },
    delivery: delivery && {
      status: delivery.status,
      disposition: delivery.disposition,
      generation: delivery.generation,
      requesterDelivery: custody && {
        state: custody.state,
        runId: custody.runId,
        at: custody.at,
        blockingRunId: custody.blockingRunId,
      },
      requesterVisibleFinal: visibleFinal && {
        requesterTurnRunId: visibleFinal.requesterTurnRunId,
        batchRunIds: visibleFinal.batchRunIds.slice(),
      },
    },
  };
}

export type SubagentCorrelationSelection = {
  runId: string;
  generation: number;
  rearmGeneration?: number;
};

/** Expected identities narrow a read; they never establish visibility or authority. */
export function matchesSubagentCorrelationSelection(
  run: SubagentRunRecord,
  expected: SubagentCorrelationSelection | undefined,
): boolean {
  return (
    !expected ||
    (run.runId === expected.runId &&
      run.generation === expected.generation &&
      (expected.rearmGeneration === undefined ||
        run.requesterSettleWake?.rearmGeneration === expected.rearmGeneration))
  );
}
