import { AsyncLocalStorage } from "node:async_hooks";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import type { CurrentInboundPromptContext } from "../../agents/internal-runtime-context.js";
import type { SubagentRunRecord } from "../../agents/subagents/registry/subagent-registry.types.js";
import { getSubagentRunRuntimeKey } from "../../agents/subagents/registry/subagent-run-generation.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { registerAgentEventLifecycleRotationHandler } from "../../infra/agent-events.js";
import { getAgentRunLifecycleGeneration } from "../../infra/agent-run-registry.js";
import type {
  ReplyOperation,
  SessionControllerInput,
} from "../../sessions/session-controller.contracts.js";
import { runAfterReplyOperationClear } from "../../sessions/session-controller.state.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { GoalContinuation } from "./goal-continuation.types.js";
import { resolveFollowupAbortSignal, type FollowupRun } from "./queue/types.js";
import { replyCallbackCustody } from "./reply-callback-custody.js";

type GoalReturnParams = {
  base: FollowupRun;
  sessionKey: string;
  storePath: string;
  expectedSession: Pick<SessionEntry, "sessionId" | "lifecycleRevision">;
  initialGoalId?: string;
  operation: ReplyOperation;
  context: (
    continuation: GoalContinuation,
    entry: SessionEntry | undefined,
    existing?: CurrentInboundPromptContext,
  ) => CurrentInboundPromptContext | undefined;
  resume: (params: {
    continuation: GoalContinuation;
    base: FollowupRun;
    runId: string;
    result: EmbeddedAgentRunResult;
    isCurrent: () => boolean;
  }) => Promise<void>;
};
type GoalReturn = {
  params: GoalReturnParams;
  continuation?: GoalContinuation;
  generation: string;
  signal: AbortSignal;
  sourceRunId?: string;
  cohort?: { keys: readonly object[]; rearmGeneration: number };
  holds?: DisposableStack;
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
  owner.holds?.dispose();
}

/** Preserve the admitted chat route independently of the expiring settle capability. */
export function createGoalContinuationReturnScope(
  params: GoalReturnParams,
): <T>(run: () => T) => T {
  const owner = createGoalReturn(params);
  return (run) => goalReturns.run(owner, run);
}

function createGoalReturn(params: GoalReturnParams): GoalReturn {
  const sourceSignal = resolveFollowupAbortSignal(params.base);
  const owner: GoalReturn = {
    params,
    continuation: params.initialGoalId
      ? { ...params.expectedSession, goalId: params.initialGoalId }
      : undefined,
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
  return owner;
}

/** The reply execution owner supplies its physical run ID before any tools can yield. */
export function bindGoalContinuationExecution(runId: string, sessionKey: string | undefined): void {
  const owner = goalReturns.getStore();
  if (owner && !owner.closed && owner.params.sessionKey === sessionKey) {
    owner.sourceRunId = runId;
  }
}

type GoalToolContinuation = {
  runId?: string;
  sessionKey: string;
  agentId: string;
  storePath: string;
  goalId: string;
};

function activeGoalReturnForTool(params: GoalToolContinuation): GoalReturn | undefined {
  const owner = goalReturns.getStore();
  if (
    !owner ||
    owner.closed ||
    owner.signal.aborted ||
    owner.params.base.run.scheduledAutomation ||
    owner.params.operation.result !== null ||
    owner.generation !== getAgentRunLifecycleGeneration() ||
    !params.runId ||
    owner.sourceRunId !== params.runId ||
    owner.params.sessionKey !== params.sessionKey ||
    owner.params.base.run.agentId !== params.agentId ||
    owner.params.storePath !== params.storePath
  ) {
    return undefined;
  }
  return owner;
}

/** A Goal created by this execution can use its admitted chat return, never another command's. */
export function bindCreatedGoalContinuation(params: GoalToolContinuation): void {
  const owner = activeGoalReturnForTool(params);
  if (owner && !owner.continuation) {
    owner.continuation = { ...owner.params.expectedSession, goalId: params.goalId };
  }
}

/** Only the committed completion of this return's goal permits its next explicit creation. */
export function releaseCompletedGoalContinuation(params: GoalToolContinuation): void {
  const owner = activeGoalReturnForTool(params);
  if (owner?.continuation?.goalId === params.goalId) {
    owner.continuation = undefined;
  }
}

/** A created successor overrides the old goal fence only within its own execution. */
export function readCreatedGoalContinuationId(
  runId: string,
  operation: ReplyOperation,
): string | undefined {
  const owner = goalReturns.getStore();
  return owner &&
    !owner.closed &&
    !owner.signal.aborted &&
    owner.generation === getAgentRunLifecycleGeneration() &&
    owner.sourceRunId === runId &&
    owner.params.operation === operation &&
    owner.continuation?.goalId !== owner.params.initialGoalId
    ? owner.continuation?.goalId
    : undefined;
}

function retainGoalReturn(owner: GoalReturn): boolean {
  if (!owner.holds) {
    const { base } = owner.params;
    const source = base.queuedFollowupReplyDisposition;
    if (source?.kind === "drop") {
      owner.close();
      return false;
    }
    using holds = new DisposableStack();
    if (base.operatorAuthority?.retain) {
      holds.defer(base.operatorAuthority.retain());
    }
    if (base[replyCallbackCustody]) {
      holds.defer(base[replyCallbackCustody].retain());
    }
    // Allocate one-shot delivery before the lending source settles.
    owner.params.base = {
      ...base,
      queuedFollowupReplyDisposition:
        source?.kind === "deliver"
          ? {
              kind: "deliver",
              deliver: source.deliver.createSourceRetry?.() ?? source.deliver,
            }
          : source,
    };
    if (
      owner.closed ||
      owner.signal.aborted ||
      owner.generation !== getAgentRunLifecycleGeneration()
    ) {
      return false;
    }
    owner.holds = holds.move();
    retainedReturns.add(owner);
    owner.signal.addEventListener("abort", owner.close, { once: true });
  }
  return true;
}

type NativeGoalBarrier = {
  runId: string;
  agentId: string;
  sessionKey: string;
  session: Pick<SessionEntry, "sessionId" | "lifecycleRevision">;
  isCurrent: () => boolean;
  displaced?: {
    owner: GoalReturn;
    remaining: number;
    eligible: (result: EmbeddedAgentRunResult) => boolean;
  };
  terminal?: GoalReturn["terminal"];
};

const { pending, commands } = resolveGlobalSingleton(
  Symbol.for("openclaw.nativeGoalBarriers"),
  () => ({
    pending: new WeakMap<SessionControllerInput, NativeGoalBarrier | null>(),
    commands: new AsyncLocalStorage<NativeGoalBarrier>(),
  }),
);

/** A native input can delay an eligible chat nudge. It never borrows chat context or authority. */
export async function withNativeGoalBarrier<T>(
  input: SessionControllerInput,
  barrier: NativeGoalBarrier | null,
  deliver: () => Promise<T>,
  delivered: (receipt: T) => boolean,
  onError: () => void,
): Promise<T> {
  if (pending.has(input)) {
    return deliver();
  }
  pending.set(input, barrier);
  try {
    // Uncaptured or cancelled inputs still block pursuit after becoming mailbox tasks.
    if (!barrier) {
      return await deliver();
    }
    const receipt = await commands.run(barrier, deliver);
    const group = barrier.displaced;
    if (
      group &&
      barrier.terminal &&
      delivered(receipt) &&
      group.owner.params.operation.result?.kind === "completed"
    ) {
      // An acknowledged delivery must never be replayed because pursuit failed.
      try {
        if (barrier.isCurrent() && group.eligible(barrier.terminal.result)) {
          if (--group.remaining === 0) {
            group.owner.terminal = barrier.terminal;
            await resumeGoalReturn(group.owner, barrier.isCurrent);
          } else {
            barrier.displaced = undefined;
          }
        }
      } catch {
        onError();
      }
    }
    return receipt;
  } finally {
    pending.delete(input);
    barrier?.displaced?.owner.close();
  }
}

export function isNativeGoalBarrier(input: SessionControllerInput): boolean {
  return pending.has(input);
}

export function deferGoalContinuation(
  inputs: ReadonlySet<SessionControllerInput>,
  params: GoalReturnParams,
  continuation: GoalContinuation,
  eligible: (result: EmbeddedAgentRunResult) => boolean,
): void {
  const barriers: NativeGoalBarrier[] = [];
  for (const input of inputs) {
    const barrier = pending.get(input);
    if (
      !barrier ||
      barrier.displaced ||
      input.abortSignal.aborted ||
      barrier.sessionKey !== params.sessionKey ||
      barrier.agentId !== params.base.run.agentId ||
      barrier.session.sessionId !== continuation.sessionId ||
      barrier.session.lifecycleRevision !== continuation.lifecycleRevision ||
      params.operation.sessionId !== continuation.sessionId
    ) {
      return;
    }
    barriers.push(barrier);
  }
  const owner = createGoalReturn(params);
  owner.continuation = { ...continuation, nativeReturn: true };
  if (retainGoalReturn(owner)) {
    const displaced = { owner, remaining: barriers.length, eligible };
    for (const barrier of barriers) {
      barrier.displaced = displaced;
    }
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
  const continuation = owner.continuation;
  if (!continuation) {
    return;
  }
  const { sessionKey, base } = owner.params;
  if (
    params.entries.some(
      (entry) =>
        entry.requesterSessionKey !== sessionKey ||
        entry.requesterAgentId !== base.run.agentId ||
        entry.requesterSettleWake?.rearmGeneration !== params.rearmGeneration ||
        entry.requesterSettleWake?.requesterYieldBatch !== true,
    )
  ) {
    return;
  }
  if (!retainGoalReturn(owner)) {
    return;
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

/** Command preparation supplies current session facts for runtime admission. */
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

/** Only the exact admitted child-result command consumes this context. */
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
  const continuation = settlement.owner.continuation;
  const context =
    continuation &&
    settlement.owner.params.context(continuation, settlement.entry, params.currentInboundContext);
  if (!context) {
    return undefined;
  }
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
  const barrier = commands.getStore();
  if (
    barrier?.runId === params.runId &&
    barrier.sessionKey === params.sessionKey &&
    barrier.isCurrent()
  ) {
    barrier.terminal = params.succeeded
      ? { runId: params.runId, result: params.result }
      : undefined;
    return;
  }
  const settlement = goalSettlements.getStore();
  if (
    settlement &&
    settlement.runId === params.runId &&
    settlement.owner.params.sessionKey === params.sessionKey &&
    settlement.isCurrent() &&
    !settlement.owner.closed
  ) {
    settlement.owner.terminal =
      settlement.admitted && params.succeeded
        ? { runId: params.runId, result: params.result }
        : undefined;
  }
}

async function resumeGoalReturn(owner: GoalReturn, current?: () => boolean): Promise<void> {
  const isCurrent = () =>
    !owner.closed &&
    !owner.signal.aborted &&
    owner.generation === getAgentRunLifecycleGeneration() &&
    current?.() !== false;
  if (owner.terminal && owner.continuation && isCurrent()) {
    await owner.params.resume({
      continuation: owner.continuation,
      base: owner.params.base,
      ...owner.terminal,
      isCurrent,
    });
  }
}

/** Run only after the persisted batch commit; waiting inside the command would deadlock. */
export async function finishGoalContinuationSettlement(
  entries: readonly SubagentRunRecord[],
  delivered: boolean,
): Promise<void> {
  const owner = findGoalReturn(entries);
  if (!owner) {
    // A partition settled ahead of its siblings leaves the cohort; the last one resumes the Goal.
    for (const key of entries.map(getSubagentRunRuntimeKey)) {
      const member = cohortReturns.get(key);
      if (member?.cohort) {
        member.cohort = { ...member.cohort, keys: member.cohort.keys.filter((k) => k !== key) };
        cohortReturns.delete(key);
      }
    }
    return;
  }
  try {
    if (delivered) {
      await resumeGoalReturn(owner);
    }
  } catch (error) {
    if (owner.closed) {
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
