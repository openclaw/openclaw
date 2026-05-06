/**
 * Continuation delegate dispatch — spawn logic for both immediate and delayed delegates.
 *
 * Consumes pending delegates from the store and dispatches them via spawnSubagentDirect.
 * Handles per-turn cap enforcement, chain-hop prefix, and mode flags.
 *
 * OBSERVABILITY: every spawn outcome (accepted/rejected/failed) is logged at info level,
 * regardless of whether the spawn was immediate or timer-triggered. The old branch gated
 * success logging behind `timerTriggered`, making immediate delegates invisible to operators.
 * Do not reproduce this.
 *
 * RFC: docs/design/continue-work-signal-v2.md §3.2, §3.4
 */

import { spawnSubagentDirect } from "../../agents/subagent-spawn.js";
import type { SpawnSubagentContext } from "../../agents/subagent-spawn.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { failFlow } from "../../tasks/task-flow-registry.js";
import { resolveContinuationRuntimeConfig } from "./config.js";
import { consumePendingDelegates, peekSoonestUnmaturedDelegateDueAt } from "./delegate-store.js";
import { checkContinuationBudget, type ChainState } from "./scheduler.js";
import {
  registerContinuationTimerHandle,
  retainContinuationTimerRef,
  unregisterContinuationTimerHandle,
} from "./state.js";

const log = createSubsystemLogger("continuation/delegate-dispatch");
const HEDGE_DISPATCH_FAILURE_RETRY_MS = 30_000;

// Per-session hedge timer for re-checking unmatured pending delegates in fully
// quiet channels (no further response-finalize event). Idempotent per
// sessionKey: a fresh dispatch call cancels + replaces any existing hedge.
const hedgeTimers = new Map<string, NodeJS.Timeout>();

function clearHedgeTimer(sessionKey: string): void {
  const existing = hedgeTimers.get(sessionKey);
  if (existing) {
    clearTimeout(existing);
    hedgeTimers.delete(sessionKey);
    unregisterContinuationTimerHandle(sessionKey, existing);
  }
}

function formatErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function surfaceHedgeDispatchFailure(sessionKey: string, errorMessage: string): void {
  try {
    enqueueSystemEvent(
      `[system:continuation-warning] Hedge-timer dispatch failed; queued delegates may be orphaned. Error: ${errorMessage}. Re-issue continue_delegate if the work is still needed.`,
      { sessionKey },
    );
  } catch (err) {
    log.error(
      `[continuation:delegate-hedge-event-error] error=${formatErrorMessage(err)} session=${sessionKey}`,
    );
  }
}

function armHedgeTimer(
  sessionKey: string,
  fireAt: number,
  params: {
    chainState: ChainState;
    ctx: DelegateDispatchContext;
    maxChainLength: number;
    loadFreshChainState?: () => ChainState;
  },
): void {
  clearHedgeTimer(sessionKey);
  const fireIn = Math.max(0, fireAt - Date.now());
  log.info(
    `[continuation:delegate-hedge-armed] fireIn=${fireIn}ms fireAt=${fireAt} session=${sessionKey}`,
  );
  retainContinuationTimerRef(sessionKey);
  const handle = setTimeout(() => {
    hedgeTimers.delete(sessionKey);
    // Release ref + handle registration on natural fire (matches
    // clearHedgeTimer on cancel). Without this, every hedge that fires
    // naturally leaks a timer-ref and handle, keeping continuation state
    // alive past its useful lifetime.
    unregisterContinuationTimerHandle(sessionKey, handle);
    log.info(`[continuation:delegate-hedge-fired] session=${sessionKey}`);
    // Re-load chain state at fire time when the caller supplies a
    // fresh-loader. The originally-captured `params.chainState`
    // is a snapshot from when the hedge was armed and may understate
    // currentChainCount if other dispatches advanced it in between. The
    // hedge must enforce the chain-budget against the latest persisted
    // state, not the snapshot.
    const refreshedChainState = params.loadFreshChainState
      ? params.loadFreshChainState()
      : params.chainState;
    void dispatchToolDelegates({
      sessionKey,
      chainState: refreshedChainState,
      ctx: params.ctx,
      maxChainLength: params.maxChainLength,
      loadFreshChainState: params.loadFreshChainState,
    }).catch((err) => {
      const errorMessage = formatErrorMessage(err);
      log.error(`[continuation:delegate-hedge-error] error=${errorMessage} session=${sessionKey}`);
      surfaceHedgeDispatchFailure(sessionKey, errorMessage);
      try {
        armHedgeTimer(sessionKey, Date.now() + HEDGE_DISPATCH_FAILURE_RETRY_MS, params);
      } catch (rearmErr) {
        log.error(
          `[continuation:delegate-hedge-rearm-error] error=${formatErrorMessage(rearmErr)} session=${sessionKey}`,
        );
      }
    });
  }, fireIn);
  registerContinuationTimerHandle(sessionKey, handle);
  handle.unref();
  hedgeTimers.set(sessionKey, handle);
}

/**
 * Test-only: cancel any pending hedge timers and clear the registry.
 */
export function resetDelegateDispatchHedgesForTests(): void {
  for (const [sessionKey, handle] of hedgeTimers) {
    clearTimeout(handle);
    unregisterContinuationTimerHandle(sessionKey, handle);
  }
  hedgeTimers.clear();
}

export type DelegateDispatchContext = {
  sessionKey: string;
  agentChannel?: string;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
};

/**
 * Consume and dispatch all pending tool-dispatched delegates for a session.
 *
 * Called by agent-runner.ts after the response finalizes.
 * Each delegate goes through chain/cost enforcement and is spawned via spawnSubagentDirect.
 */
function markDelegateFailed(
  delegate: { flowId?: string; expectedRevision?: number; task: string },
  summary: string,
): void {
  if (!delegate.flowId || delegate.expectedRevision === undefined) {
    return;
  }
  failFlow({
    flowId: delegate.flowId,
    expectedRevision: delegate.expectedRevision,
    currentStep: "Delegate spawn failed",
    blockedSummary: summary,
    updatedAt: Date.now(),
  });
}

export async function dispatchToolDelegates(params: {
  sessionKey: string;
  chainState: ChainState;
  ctx: DelegateDispatchContext;
  maxChainLength: number;
  /**
   * Optional callback the hedge timer invokes to re-load the chain state
   * from the persisted session entry at fire time, so the re-dispatch sees
   * any chain-count advancement that happened while the timer was pending.
   * Without this the hedge captures a stale `chainState` snapshot and may
   * dispatch past `maxChainLength`.
   */
  loadFreshChainState?: () => ChainState;
}): Promise<{ dispatched: number; rejected: number; chainState: ChainState }> {
  const { sessionKey, chainState, ctx } = params;
  const config = resolveContinuationRuntimeConfig();
  const toolDelegates = consumePendingDelegates(sessionKey);

  // Arm (or re-arm) a hedge timer for any unmatured queued delegates so they
  // still fire in fully-quiet channels where no further response-finalize
  // arrives. The hedge re-invokes this function; idempotent per sessionKey.
  const soonestUnmaturedDueAt = peekSoonestUnmaturedDelegateDueAt(sessionKey);
  if (soonestUnmaturedDueAt !== undefined) {
    armHedgeTimer(sessionKey, soonestUnmaturedDueAt, {
      chainState: params.chainState,
      ctx: params.ctx,
      maxChainLength: params.maxChainLength,
      loadFreshChainState: params.loadFreshChainState,
    });
  } else {
    clearHedgeTimer(sessionKey);
  }

  if (toolDelegates.length === 0) {
    return { dispatched: 0, rejected: 0, chainState };
  }

  log.info(
    `[continue_delegate] Consuming ${toolDelegates.length} tool delegate(s) for session ${sessionKey}`,
  );

  const { maxDelegatesPerTurn, maxChainLength } = config;
  const delegatesWithinLimit = toolDelegates.slice(0, maxDelegatesPerTurn);
  const delegatesOverLimit = toolDelegates.slice(maxDelegatesPerTurn);

  for (const dropped of delegatesOverLimit) {
    const summary = `Tool delegate rejected: maxDelegatesPerTurn exceeded (${maxDelegatesPerTurn}).`;
    log.info(
      `[continuation:delegate-rejected] maxDelegatesPerTurn=${maxDelegatesPerTurn} task=${dropped.task.slice(0, 80)} session=${sessionKey}`,
    );
    markDelegateFailed(dropped, summary);
    enqueueSystemEvent(`[continuation] ${summary} Task: ${dropped.task}`, { sessionKey });
  }

  let dispatched = 0;
  let rejected = delegatesOverLimit.length;
  let currentChainCount = chainState.currentChainCount;
  let accumulatedTokens = chainState.accumulatedChainTokens;

  for (const delegate of delegatesWithinLimit) {
    const budgetCheck = checkContinuationBudget({
      chainState: {
        currentChainCount,
        chainStartedAt: chainState.chainStartedAt,
        accumulatedChainTokens: accumulatedTokens,
      },
      config,
      sessionKey,
    });

    if (budgetCheck) {
      const summary = `Tool delegate rejected: ${budgetCheck}.`;
      log.info(
        `[continuation:delegate-rejected] ${budgetCheck} task=${delegate.task.slice(0, 80)} session=${sessionKey}`,
      );
      markDelegateFailed(delegate, summary);
      enqueueSystemEvent(`[continuation] ${summary} Task: ${delegate.task}`, { sessionKey });
      rejected++;
      continue;
    }

    const nextHop = currentChainCount + 1;
    const silent = delegate.mode === "silent" || delegate.mode === "silent-wake";
    const silentWake = delegate.mode === "silent-wake";

    const spawnCtx: SpawnSubagentContext = {
      agentSessionKey: sessionKey,
      agentChannel: ctx.agentChannel,
      agentAccountId: ctx.agentAccountId,
      agentTo: ctx.agentTo,
      agentThreadId: ctx.agentThreadId,
    };

    try {
      const result = await spawnSubagentDirect(
        {
          task: `[continuation:chain-hop:${nextHop}] Delegated task (turn ${nextHop}/${maxChainLength}): ${delegate.task}`,
          drainsContinuationDelegateQueue: true,
          ...(silent ? { silentAnnounce: true } : {}),
          ...(silentWake ? { silentAnnounce: true, wakeOnReturn: true } : {}),
          ...(delegate.targetSessionKey
            ? { continuationTargetSessionKey: delegate.targetSessionKey }
            : {}),
          ...(delegate.targetSessionKeys && delegate.targetSessionKeys.length > 0
            ? { continuationTargetSessionKeys: delegate.targetSessionKeys }
            : {}),
          ...(delegate.fanoutMode ? { continuationFanoutMode: delegate.fanoutMode } : {}),
        },
        spawnCtx,
      );

      if (result.status === "accepted") {
        // INFO-level on EVERY successful spawn — observability parity.
        log.info(
          `[continuation:delegate-spawned] hop=${nextHop}/${maxChainLength} mode=${delegate.mode ?? "normal"} session=${sessionKey} task=${delegate.task.slice(0, 80)}`,
        );
        enqueueSystemEvent(
          `[continuation:delegate-spawned] Spawned turn ${nextHop}/${maxChainLength}: ${delegate.task}`,
          { sessionKey },
        );
        dispatched++;
        currentChainCount = nextHop;
      } else {
        const summary = `DELEGATE spawn ${result.status}: delegation was not accepted.`;
        log.info(
          `[continuation:delegate-spawn-rejected] status=${result.status} session=${sessionKey} task=${delegate.task.slice(0, 80)}`,
        );
        markDelegateFailed(delegate, summary);
        enqueueSystemEvent(`[continuation] ${summary} Task: ${delegate.task}`, {
          sessionKey,
        });
        rejected++;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const summary = `DELEGATE spawn failed: ${message}`;
      log.info(`[continuation:delegate-spawn-failed] error=${message} session=${sessionKey}`);
      markDelegateFailed(delegate, summary);
      enqueueSystemEvent(`[continuation] ${summary}. Task: ${delegate.task}`, {
        sessionKey,
      });
      rejected++;
    }
  }

  return {
    dispatched,
    rejected,
    // Return the advanced chain state so callers can persist `currentChainCount`,
    // `chainStartedAt`, and `accumulatedChainTokens` after dispatch. Without
    // this the persisted counter never advances across hops and the
    // maxChainLength budget enforcement breaks.
    chainState: {
      currentChainCount,
      chainStartedAt: chainState.chainStartedAt,
      accumulatedChainTokens: accumulatedTokens,
    },
  };
}

// ---------------------------------------------------------------------------
// Post-compaction delegate dispatch (RFC §4.4)
// ---------------------------------------------------------------------------

const postCompactionLog = createSubsystemLogger("continuation/compaction");

export interface PostCompactionSpawnContext {
  agentSessionKey: string;
  agentChannel?: string;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
}

/**
 * Dispatch post-compaction delegates with silentAnnounce + wakeOnReturn.
 *
 * This mirrors dispatchToolDelegates but is specifically for post-compaction
 * staged delegates. Errors are logged and surfaced as system events rather
 * than silently swallowed.
 */
export async function dispatchStagedPostCompactionDelegates(
  delegates: Array<{
    task: string;
    targetSessionKey?: string;
    targetSessionKeys?: string[];
    fanoutMode?: "tree" | "all";
  }>,
  sessionKey: string,
  spawnCtx: PostCompactionSpawnContext,
): Promise<{ dispatched: number; failed: number }> {
  let dispatched = 0;
  let failed = 0;

  postCompactionLog.info(
    `[continuation:compaction-delegate] Consuming ${delegates.length} compaction delegate(s) for session ${sessionKey}`,
  );

  for (const delegate of delegates) {
    try {
      const spawnResult = await spawnSubagentDirect(
        {
          task: delegate.task,
          silentAnnounce: true,
          wakeOnReturn: true,
          drainsContinuationDelegateQueue: true,
          ...(delegate.targetSessionKey
            ? { continuationTargetSessionKey: delegate.targetSessionKey }
            : {}),
          ...(delegate.targetSessionKeys && delegate.targetSessionKeys.length > 0
            ? { continuationTargetSessionKeys: delegate.targetSessionKeys }
            : {}),
          ...(delegate.fanoutMode ? { continuationFanoutMode: delegate.fanoutMode } : {}),
        },
        spawnCtx,
      );
      if (spawnResult.status === "accepted") {
        dispatched++;
        continue;
      }
      postCompactionLog.warn(
        `[continuation:post-compaction-spawn-rejected] status=${spawnResult.status} session=${sessionKey} task=${delegate.task.slice(0, 80)}`,
      );
      enqueueSystemEvent(
        `[continuation] Post-compaction delegate spawn ${spawnResult.status}: delegation was not accepted. Task: ${delegate.task}`,
        { sessionKey },
      );
      failed++;
    } catch (err) {
      postCompactionLog.warn(
        `[continuation:post-compaction-spawn-failed] error=${err instanceof Error ? err.message : String(err)} session=${sessionKey} task=${delegate.task.slice(0, 80)}`,
      );
      enqueueSystemEvent(
        `[continuation] Post-compaction delegate spawn failed: ${String(err)}. Task: ${delegate.task}`,
        { sessionKey },
      );
      failed++;
    }
  }

  return { dispatched, failed };
}
