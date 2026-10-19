import { AsyncLocalStorage } from "node:async_hooks";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import type { CurrentInboundPromptContext } from "../../agents/internal-runtime-context.js";
import type { SubagentRunRecord } from "../../agents/subagents/registry/subagent-registry.types.js";
import { getSubagentRunRuntimeKey } from "../../agents/subagents/registry/subagent-run-generation.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { registerAgentEventLifecycleRotationHandler } from "../../infra/agent-events.js";
import { getAgentRunLifecycleGeneration } from "../../infra/agent-run-registry.js";
import type { ReplyOperation } from "../../sessions/session-controller.contracts.js";
import { runAfterReplyOperationClear } from "../../sessions/session-controller.state.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { GoalContinuation } from "./goal-continuation.types.js";
import { resolveFollowupAbortSignal, type FollowupRun } from "./queue/types.js";

type GoalReturnParams = {
  base: FollowupRun;
  sessionKey: string;
  continuation: GoalContinuation;
  operation: ReplyOperation;
  context: (
    entry: SessionEntry | undefined,
    existing?: CurrentInboundPromptContext,
  ) => CurrentInboundPromptContext | undefined;
  resume: (params: {
    base: FollowupRun;
    runId: string;
    result: EmbeddedAgentRunResult;
    isCurrent: () => boolean;
  }) => Promise<void>;
};
type GoalReturn = {
  params: GoalReturnParams;
  generation: string;
  signal: AbortSignal;
  sourceRunId?: string;
  cohort?: { keys: readonly object[]; rearmGeneration: number };
  release?: () => void;
  closed: boolean;
  close: () => void;
  terminal?: { runId: string; result: EmbeddedAgentRunResult };
};
type GoalSettlement = {
  owner: GoalReturn;
  runId: string;
  isCurrent: () => boolean;
  entry?: SessionEntry;
  admitted?: true;
};

// Weak projection only. The existing Goal queue owner supplies context and decides every enqueue.
const { goalReturns, goalSettlements, cohortReturns, retainedReturns } = resolveGlobalSingleton(
  Symbol.for("openclaw.goalContinuationReturns"),
  () => ({
    goalReturns: new AsyncLocalStorage<GoalReturn>(),
    goalSettlements: new AsyncLocalStorage<GoalSettlement>(),
    cohortReturns: new WeakMap<object, GoalReturn>(),
    retainedReturns: new Set<GoalReturn>(),
  }),
);

function closeGoalReturn(owner: GoalReturn): void {
  if (owner.closed) {
    return;
  }
  owner.closed = true;
  retainedReturns.delete(owner);
  for (const key of owner.cohort?.keys ?? []) {
    if (cohortReturns.get(key) === owner) {
      cohortReturns.delete(key);
    }
  }
  owner.signal.removeEventListener("abort", owner.close);
  owner.release?.();
}

/** Preserve the admitted chat route independently of the expiring settle capability. */
export function createGoalContinuationReturnScope(
  params: GoalReturnParams,
): <T>(run: () => T) => T {
  const sourceSignal = resolveFollowupAbortSignal(params.base);
  const owner: GoalReturn = {
    params,
    signal: sourceSignal
      ? AbortSignal.any([params.operation.abortSignal, sourceSignal])
      : params.operation.abortSignal,
    generation: getAgentRunLifecycleGeneration(),
    closed: false,
    close: () => closeGoalReturn(owner),
  };
  runAfterReplyOperationClear(params.operation, () => {
    if (params.operation.result?.kind !== "completed") {
      owner.close();
    }
  });
  return (run) => goalReturns.run(owner, run);
}

/** The reply execution owner supplies its physical run ID before any tools can yield. */
export function bindGoalContinuationExecution(runId: string, sessionKey: string | undefined): void {
  const owner = goalReturns.getStore();
  if (owner && !owner.closed && owner.params.sessionKey === sessionKey) {
    owner.sourceRunId = runId;
  }
}

/** The committed yield publisher binds the return before the completion wake becomes eligible. */
export function promoteGoalContinuationYield(params: {
  entries: readonly SubagentRunRecord[];
  requesterTurnRunId: string;
  rearmGeneration?: number;
}): void {
  const settlement = goalSettlements.getStore();
  const lendingTurn = goalReturns.getStore();
  const owner =
    settlement?.admitted && settlement.runId === params.requesterTurnRunId
      ? settlement.owner
      : lendingTurn?.sourceRunId === params.requesterTurnRunId
        ? lendingTurn
        : undefined;
  if (
    !owner ||
    owner.closed ||
    owner.signal.aborted ||
    params.rearmGeneration === undefined ||
    !params.entries.length
  ) {
    return;
  }
  const { continuation, sessionKey, base } = owner.params;
  if (
    params.entries.some(
      (entry) =>
        entry.requesterSessionKey !== sessionKey ||
        entry.requesterAgentId !== base.run.agentId ||
        (entry.completionRequesterSessionId !== undefined &&
          (entry.completionRequesterSessionId !== continuation.sessionId ||
            entry.completionRequesterLifecycleRevision !== continuation.lifecycleRevision)) ||
        entry.requesterSettleWake?.rearmGeneration !== params.rearmGeneration ||
        entry.requesterSettleWake?.requesterYieldBatch !== true,
    )
  ) {
    return;
  }
  base.operatorAuthority?.assertCurrent();
  if (!owner.cohort) {
    const source = base.queuedFollowupReplyDisposition;
    if (source?.kind === "drop") {
      owner.close();
      return;
    }
    // Allocate one-shot delivery before the lending source settles.
    owner.params.base = {
      ...base,
      queuedFollowupReplyDisposition:
        source?.kind === "deliver"
          ? { kind: "deliver", deliver: source.deliver.createSourceRetry?.() ?? source.deliver }
          : source,
    };
    owner.release = base.operatorAuthority?.retain?.();
    retainedReturns.add(owner);
    owner.signal.addEventListener("abort", owner.close, { once: true });
  }
  for (const key of owner.cohort?.keys ?? []) {
    cohortReturns.delete(key);
  }
  owner.cohort = {
    keys: params.entries.map(getSubagentRunRuntimeKey),
    rearmGeneration: params.rearmGeneration,
  };
  for (const key of owner.cohort.keys) {
    const previous = cohortReturns.get(key);
    if (previous && previous !== owner) {
      previous.close();
    }
  }
  for (const key of owner.cohort.keys) {
    cohortReturns.set(key, owner);
  }
}

function findGoalReturn(entries: readonly SubagentRunRecord[]): GoalReturn | undefined {
  const first = entries[0];
  const owner = first && cohortReturns.get(getSubagentRunRuntimeKey(first));
  return owner &&
    !owner.closed &&
    owner.generation === getAgentRunLifecycleGeneration() &&
    owner.cohort?.keys.length === entries.length &&
    entries.every(
      (entry) =>
        cohortReturns.get(getSubagentRunRuntimeKey(entry)) === owner &&
        entry.requesterSettleWake?.rearmGeneration === owner.cohort?.rearmGeneration,
    )
    ? owner
    : undefined;
}

/** Transient exact-run scope: ordinary commands never acquire a Goal return. */
export function withGoalContinuationSettlement<T>(
  entries: readonly SubagentRunRecord[],
  runId: string,
  isCurrent: () => boolean,
  run: () => T,
): T {
  const owner = isCurrent() ? findGoalReturn(entries) : undefined;
  if (owner && owner.terminal?.runId !== runId) {
    // An ambiguous transport retry may replay the Gateway receipt without rerunning post-run.
    owner.terminal = undefined;
  }
  return owner ? goalSettlements.run({ owner, runId, isCurrent }, run) : run();
}

/** Command preparation captures current Goal facts without injecting them into a native runtime. */
export function prepareGoalContinuationContext(params: {
  runId: string;
  sessionKey?: string;
  sessionEntry?: SessionEntry;
}): void {
  const settlement = goalSettlements.getStore();
  if (
    settlement?.runId === params.runId &&
    settlement.owner.params.sessionKey === params.sessionKey &&
    !settlement.owner.closed &&
    settlement.isCurrent()
  ) {
    settlement.entry = params.sessionEntry;
  }
}

/** Only the actual built-in harness consumes this transient context. */
export function readGoalContinuationContext(params: {
  runId: string;
  sessionKey?: string;
  currentInboundContext?: CurrentInboundPromptContext;
}) {
  const settlement = goalSettlements.getStore();
  if (
    !settlement ||
    settlement.runId !== params.runId ||
    settlement.owner.params.sessionKey !== params.sessionKey ||
    settlement.owner.closed ||
    !settlement.isCurrent()
  ) {
    return undefined;
  }
  const context = settlement.owner.params.context(settlement.entry, params.currentInboundContext);
  if (!context) {
    return undefined;
  }
  settlement.owner.params.base.operatorAuthority?.assertCurrent();
  settlement.admitted = true;
  return context;
}

/** Publish the actual command terminal result, never a synthetic success for a failure. */
export function recordGoalContinuationSettlement(params: {
  runId: string;
  sessionKey?: string;
  result: EmbeddedAgentRunResult;
  succeeded: boolean;
}): void {
  const settlement = goalSettlements.getStore();
  if (
    settlement &&
    settlement.runId === params.runId &&
    settlement.owner.params.sessionKey === params.sessionKey &&
    settlement.isCurrent() &&
    !settlement.owner.closed
  ) {
    settlement.owner.terminal = params.succeeded
      ? { runId: params.runId, result: params.result }
      : undefined;
  }
}

/** Run only after the persisted batch commit; waiting inside the command would deadlock. */
export async function finishGoalContinuationSettlement(
  entries: readonly SubagentRunRecord[],
  delivered: boolean,
): Promise<void> {
  const owner = findGoalReturn(entries);
  if (!owner) {
    return;
  }
  try {
    if (delivered && owner.terminal) {
      await owner.params.resume({
        base: owner.params.base,
        ...owner.terminal,
        isCurrent: () => !owner.closed && owner.generation === getAgentRunLifecycleGeneration(),
      });
    }
  } catch (error) {
    if (owner.closed) {
      return;
    }
    try {
      owner.params.base.operatorAuthority?.assertCurrent();
    } catch {
      return;
    }
    throw error;
  } finally {
    owner.close();
  }
}

export function revokeGoalContinuationReturn(entry: SubagentRunRecord): void {
  cohortReturns.get(getSubagentRunRuntimeKey(entry))?.close();
}

registerAgentEventLifecycleRotationHandler("goal-continuation-returns", () => {
  for (const owner of retainedReturns) {
    owner.close();
  }
});
