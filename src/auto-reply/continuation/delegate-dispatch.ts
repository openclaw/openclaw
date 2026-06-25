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

import { deriveContinuationDelegateChildSessionKeyFromParent } from "../../agents/subagent-continuation-ids.js";
import {
  getSubagentRunByChildSessionKey,
  hasLiveContinuationDelegateChildRun,
  isSubagentRunLive,
} from "../../agents/subagent-registry-read.js";
import { spawnSubagentDirect } from "../../agents/subagent-spawn.js";
import type { SpawnSubagentContext } from "../../agents/subagent-spawn.js";
import { getRuntimeConfig } from "../../config/config.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import { loadSessionStore } from "../../config/sessions/store-load.js";
import { updateSessionStore } from "../../config/sessions/store.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  emitContinuationDelegateFireSpan,
  emitContinuationDisabledSpan,
  resolveContinuationTraceparent,
  startContinuationDelegateSpan,
} from "../../infra/continuation-tracer.js";
import { generateChainId } from "../../infra/secure-random.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import { resolveContinuationRuntimeConfig } from "./config.js";
import {
  consumePendingDelegates,
  listPendingDelegateSessionKeysForRecovery,
  markPendingDelegateFailed,
  markPendingDelegateSpawnAccepted,
  peekSoonestUnmaturedDelegateDueAt,
} from "./delegate-store.js";
import { checkContinuationBudget, type ChainState } from "./scheduler.js";
import {
  registerContinuationTimerHandle,
  retainContinuationTimerRef,
  persistContinuationChainState,
  unregisterContinuationTimerHandle,
  loadContinuationChainState,
} from "./state.js";
import { hasCrossSessionDelegateTargeting } from "./targeting-pure.js";
import type { ContinuationRuntimeConfig } from "./types.js";

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
      { sessionKey, trusted: true },
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
    config?: ContinuationRuntimeConfig;
    loadFreshChainState?: () => ChainState;
    persistChainState?: (chainState: ChainState) => void | Promise<void>;
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
      ...(params.config ? { config: params.config } : {}),
      loadFreshChainState: params.loadFreshChainState,
      persistChainState: params.persistChainState,
    })
      .then(async (result) => {
        if (params.persistChainState && (result.dispatched > 0 || result.rejected > 0)) {
          await params.persistChainState(result.chainState);
        }
      })
      .catch((err: unknown) => {
        const errorMessage = formatErrorMessage(err);
        log.error(
          `[continuation:delegate-hedge-error] error=${errorMessage} session=${sessionKey}`,
        );
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

function hasActiveSubagentRegistryRun(childSessionKey: string): boolean {
  return isSubagentRunLive(getSubagentRunByChildSessionKey(childSessionKey));
}

function hasAcceptedContinuationChildRun(childSessionKey: string, flowId: string): boolean {
  return hasLiveContinuationDelegateChildRun({ childSessionKey, flowId });
}

function markDelegateFailed(
  delegate: { flowId?: string; expectedRevision?: number; task: string },
  summary: string,
): void {
  markPendingDelegateFailed(delegate, summary);
}

export async function dispatchToolDelegates(params: {
  sessionKey: string;
  chainState: ChainState;
  ctx: DelegateDispatchContext;
  maxChainLength: number;
  /**
   * Resolved runtime config for the active run. Callers with scoped/runtime
   * snapshots should pass it so delegate caps match the turn that queued them.
   */
  config?: ContinuationRuntimeConfig;
  /**
   * Delegate slots already consumed by another continuation signal in the same
   * turn, e.g. a bracket-style CONTINUE_DELEGATE.
   */
  reservedDelegateSlots?: number;
  /**
   * Optional callback the hedge timer invokes to re-load the chain state
   * from the persisted session entry at fire time, so the re-dispatch sees
   * any chain-count advancement that happened while the timer was pending.
   * Without this the hedge captures a stale `chainState` snapshot and may
   * dispatch past `maxChainLength`.
   */
  loadFreshChainState?: () => ChainState;
  recoverRunningDelegates?: boolean;
  includeRunningUpdatedAtOrBefore?: number;
  /**
   * Optional callback used by hedge-fired dispatches, where there is no
   * enclosing runner finalize frame to persist the advanced chain state.
   */
  persistChainState?: (chainState: ChainState) => void | Promise<void>;
}): Promise<{ dispatched: number; rejected: number; chainState: ChainState }> {
  const { sessionKey, chainState, ctx } = params;
  const config = params.config ?? resolveContinuationRuntimeConfig();
  const toolDelegates = consumePendingDelegates(sessionKey, {
    includeRunning: params.recoverRunningDelegates === true,
    includeRunningUpdatedAtOrBefore: params.includeRunningUpdatedAtOrBefore,
  });

  // Arm (or re-arm) a hedge timer for any unmatured queued delegates so they
  // still fire in fully-quiet channels where no further response-finalize
  // arrives. The hedge re-invokes this function; idempotent per sessionKey.
  const soonestUnmaturedDueAt = peekSoonestUnmaturedDelegateDueAt(sessionKey);
  if (soonestUnmaturedDueAt !== undefined) {
    armHedgeTimer(sessionKey, soonestUnmaturedDueAt, {
      chainState: params.chainState,
      ctx: params.ctx,
      maxChainLength: params.maxChainLength,
      ...(params.config ? { config: params.config } : {}),
      loadFreshChainState: params.loadFreshChainState,
      persistChainState: params.persistChainState,
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

  const { maxDelegatesPerTurn, maxChainLength, crossSessionTargeting } = config;
  const delegateSlotsAvailable = Math.max(
    0,
    maxDelegatesPerTurn - (params.reservedDelegateSlots ?? 0),
  );
  const delegatesWithinLimit = toolDelegates.slice(0, delegateSlotsAvailable);
  const delegatesOverLimit = toolDelegates.slice(delegateSlotsAvailable);

  for (const dropped of delegatesOverLimit) {
    const summary = `Tool delegate rejected: maxDelegatesPerTurn exceeded (${maxDelegatesPerTurn}).`;
    log.info(
      `[continuation:delegate-rejected] maxDelegatesPerTurn=${maxDelegatesPerTurn} task=${dropped.task.slice(0, 80)} session=${sessionKey}`,
    );
    markDelegateFailed(dropped, summary);
    enqueueSystemEvent(`[continuation] ${summary} Task: ${dropped.task}`, {
      sessionKey,
      trusted: true,
    });
  }

  let dispatched = 0;
  let rejected = delegatesOverLimit.length;
  let currentChainCount = chainState.currentChainCount;
  const accumulatedTokens = chainState.accumulatedChainTokens;
  let currentChainId = chainState.chainId;

  for (const delegate of delegatesWithinLimit) {
    if (
      crossSessionTargeting === "disabled" &&
      hasCrossSessionDelegateTargeting(delegate, sessionKey)
    ) {
      const delegateMode = delegate.mode ?? "normal";
      const delegateDelivery: "immediate" | "timer" =
        delegate.delayMs && delegate.delayMs > 0 ? "timer" : "immediate";
      const summary = "Tool delegate rejected: cross-session targeting is disabled by policy.";
      log.info(
        `[continuation:delegate-rejected] policy.cross_session_targeting task=${delegate.task.slice(0, 80)} session=${sessionKey}`,
      );
      markDelegateFailed(delegate, summary);
      enqueueSystemEvent(`[continuation] ${summary} Task: ${delegate.task}`, {
        sessionKey,
        trusted: true,
      });
      emitContinuationDisabledSpan({
        chainId: undefined,
        chainStepRemaining: Math.max(0, maxChainLength - currentChainCount),
        disabledReason: "policy.cross_session_targeting",
        signalKind: "tool-delegate",
        delegateDelivery,
        delegateMode,
        reason: delegate.task,
        log: (message) => log.info(message),
      });
      rejected++;
      continue;
    }

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
      enqueueSystemEvent(`[continuation] ${summary} Task: ${delegate.task}`, {
        sessionKey,
        trusted: true,
      });
      rejected++;
      continue;
    }

    const nextHop = currentChainCount + 1;
    const silent = delegate.mode === "silent" || delegate.mode === "silent-wake";
    const silentWake = delegate.mode === "silent-wake";
    const outboundTraceparent = resolveContinuationTraceparent(delegate.traceparent);
    const delegateMode = silentWake ? "silent-wake" : silent ? "silent" : "normal";
    const delegateDelayMs = delegate.delayMs ?? 0;
    const delegateDelivery: "immediate" | "timer" = delegateDelayMs > 0 ? "timer" : "immediate";

    const spawnCtx: SpawnSubagentContext = {
      agentSessionKey: sessionKey,
      agentChannel: ctx.agentChannel,
      agentAccountId: ctx.agentAccountId,
      agentTo: ctx.agentTo,
      agentThreadId: ctx.agentThreadId,
    };

    let dispatchSpan: ReturnType<typeof startContinuationDelegateSpan> | undefined;
    const dispatchChainId = currentChainId ?? generateChainId();
    try {
      if (delegateDelivery === "timer") {
        emitContinuationDelegateFireSpan({
          chainId: dispatchChainId,
          chainStepRemainingAtDispatch: maxChainLength - nextHop,
          delegateMode,
          delayMs: delegateDelayMs,
          fireDeferredMs: Date.now() - (delegate.firstArmedAt ?? Date.now()),
          reason: delegate.task,
          log: (message) => log.info(message),
        });
      }
      dispatchSpan = startContinuationDelegateSpan({
        chainId: dispatchChainId,
        chainStepRemaining: maxChainLength - nextHop,
        delayMs: delegateDelayMs,
        delivery: delegateDelivery,
        delegateMode,
        reason: delegate.task,
        traceparent: outboundTraceparent,
        log: (message) => log.info(message),
      });
      const spawnTraceparent = dispatchSpan.traceparent?.() ?? outboundTraceparent;
      const childSessionKey = delegate.flowId
        ? deriveContinuationDelegateChildSessionKeyFromParent(sessionKey, delegate.flowId)
        : undefined;
      if (
        childSessionKey &&
        (hasActiveSubagentRegistryRun(childSessionKey) ||
          (delegate.flowId && hasAcceptedContinuationChildRun(childSessionKey, delegate.flowId)))
      ) {
        markPendingDelegateSpawnAccepted(delegate, childSessionKey);
        dispatchSpan.setStatus("OK");
        dispatched++;
        currentChainCount = nextHop;
        currentChainId = dispatchChainId;
        continue;
      }
      const result = await spawnSubagentDirect(
        {
          task: `[continuation:chain-hop:${nextHop}] Delegated task (turn ${nextHop}/${maxChainLength}): ${delegate.task}`,
          drainsContinuationDelegateQueue: true,
          ...(delegate.model ? { model: delegate.model } : {}),
          ...(delegate.flowId ? { continuationDelegateFlowId: delegate.flowId } : {}),
          ...(silent ? { silentAnnounce: true } : {}),
          ...(silentWake ? { silentAnnounce: true, wakeOnReturn: true } : {}),
          ...(delegate.targetSessionKey
            ? { continuationTargetSessionKey: delegate.targetSessionKey }
            : {}),
          ...(delegate.targetSessionKeys && delegate.targetSessionKeys.length > 0
            ? { continuationTargetSessionKeys: delegate.targetSessionKeys }
            : {}),
          ...(delegate.fanoutMode ? { continuationFanoutMode: delegate.fanoutMode } : {}),
          ...(spawnTraceparent ? { traceparent: spawnTraceparent } : {}),
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
          { sessionKey, trusted: true },
        );
        const acceptedChildSessionKey = result.childSessionKey ?? childSessionKey;
        if (acceptedChildSessionKey) {
          markPendingDelegateSpawnAccepted(delegate, acceptedChildSessionKey);
        }
        dispatchSpan.setStatus("OK");
        dispatched++;
        currentChainCount = nextHop;
        currentChainId = dispatchChainId;
      } else {
        const reasonText = result.error ?? "delegation was not accepted.";
        const summary = `DELEGATE spawn ${result.status}: ${reasonText}`;
        log.info(
          `[continuation:delegate-spawn-rejected] status=${result.status} session=${sessionKey} reason=${reasonText} task=${delegate.task.slice(0, 80)}`,
        );
        markDelegateFailed(delegate, summary);
        dispatchSpan.setStatus("ERROR", reasonText);
        enqueueSystemEvent(`[continuation] ${summary} Task: ${delegate.task}`, {
          sessionKey,
          trusted: true,
        });
        rejected++;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const summary = `DELEGATE spawn failed: ${message}`;
      dispatchSpan?.recordException(err);
      dispatchSpan?.setStatus("ERROR", message);
      log.info(`[continuation:delegate-spawn-failed] error=${message} session=${sessionKey}`);
      markDelegateFailed(delegate, summary);
      enqueueSystemEvent(`[continuation] ${summary}. Task: ${delegate.task}`, {
        sessionKey,
        trusted: true,
      });
      rejected++;
    } finally {
      dispatchSpan?.end();
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
      ...(currentChainId ? { chainId: currentChainId } : {}),
    },
  };
}

export async function recoverPendingContinuationDelegates(
  params: {
    chainState?: ChainState;
    ctx?: Partial<DelegateDispatchContext>;
    maxChainLength?: number;
    /** Override the session-store path used to load persisted chain budgets. */
    storePath?: string;
  } = {},
): Promise<{ sessions: number; dispatched: number; rejected: number }> {
  const runtimeConfig = resolveContinuationRuntimeConfig();
  // Honor the deny-gate across the restart seam: if continuation is disabled,
  // recovery must NOT replay queued/running delegates — re-driving them here
  // would override the user's explicit `continuation.enabled=false`.
  if (!runtimeConfig.enabled) {
    return { sessions: 0, dispatched: 0, rejected: 0 };
  }
  const sessionKeys = listPendingDelegateSessionKeysForRecovery();
  const includeRunningUpdatedAtOrBefore = Date.now();
  const storeByPath = new Map<string, Record<string, SessionEntry>>();
  const runtimeConfigSnapshot = getRuntimeConfig();
  let dispatched = 0;
  let rejected = 0;
  for (const sessionKey of sessionKeys) {
    const agentId = parseAgentSessionKey(sessionKey)?.agentId;
    const storePath =
      params.storePath ?? resolveStorePath(runtimeConfigSnapshot.session?.store, { agentId });
    let sessionStore = storeByPath.get(storePath);
    if (!sessionStore) {
      try {
        sessionStore = loadSessionStore(storePath);
      } catch (err) {
        log.warn(
          `[continuation:delegate-recovery-store-load-failed] path=${storePath} falling back to zero chain state: ${formatErrorMessage(err)}`,
        );
        sessionStore = {};
      }
      storeByPath.set(storePath, sessionStore);
    }
    const result = await dispatchToolDelegates({
      sessionKey,
      chainState: params.chainState ?? loadContinuationChainState(sessionStore[sessionKey]),
      ctx: { ...params.ctx, sessionKey },
      maxChainLength: params.maxChainLength ?? runtimeConfig.maxChainLength,
      recoverRunningDelegates: true,
      includeRunningUpdatedAtOrBefore,
    });
    dispatched += result.dispatched;
    rejected += result.rejected;
    if (!params.chainState && (result.dispatched > 0 || result.rejected > 0)) {
      await updateSessionStore(storePath, (store) => {
        const sessionEntry = store[sessionKey] ?? {};
        persistContinuationChainState({
          sessionEntry,
          count: result.chainState.currentChainCount,
          startedAt: result.chainState.chainStartedAt,
          tokens: result.chainState.accumulatedChainTokens,
          ...(result.chainState.chainId ? { chainId: result.chainState.chainId } : {}),
        });
        store[sessionKey] = sessionEntry;
      });
    }
  }
  return { sessions: sessionKeys.length, dispatched, rejected };
}

// ---------------------------------------------------------------------------
// Post-compaction delegate dispatch (docs/design/continue-work-signal-v2.md §4.4)
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
    traceparent?: string;
    model?: string;
  }>,
  sessionKey: string,
  spawnCtx: PostCompactionSpawnContext,
  options?: {
    chainState?: ChainState;
  },
): Promise<{ dispatched: number; failed: number }> {
  let dispatched = 0;
  let failed = 0;
  const config = resolveContinuationRuntimeConfig();
  const chainStartedAt = options?.chainState?.chainStartedAt ?? Date.now();
  const accumulatedChainTokens = options?.chainState?.accumulatedChainTokens ?? 0;
  let currentChainCount = options?.chainState?.currentChainCount ?? 0;
  const delegatesWithinLimit = delegates.slice(0, config.maxDelegatesPerTurn);
  const delegatesOverLimit = delegates.slice(config.maxDelegatesPerTurn);

  postCompactionLog.info(
    `[continuation:compaction-delegate] Consuming ${delegates.length} compaction delegate(s) for session ${sessionKey}`,
  );

  for (const dropped of delegatesOverLimit) {
    postCompactionLog.warn(
      `[continuation:post-compaction-policy-rejected] cap.delegates_per_turn maxDelegatesPerTurn=${config.maxDelegatesPerTurn} session=${sessionKey} task=${dropped.task.slice(0, 80)}`,
    );
    enqueueSystemEvent(
      `[continuation] Post-compaction delegate rejected: maxDelegatesPerTurn exceeded (${config.maxDelegatesPerTurn}). Task: ${dropped.task}`,
      { sessionKey, trusted: true },
    );
    emitContinuationDisabledSpan({
      chainId: undefined,
      chainStepRemaining: Math.max(0, config.maxChainLength - currentChainCount),
      disabledReason: "cap.delegates_per_turn",
      signalKind: "tool-delegate",
      delegateDelivery: "immediate",
      delegateMode: "post-compaction",
      reason: dropped.task,
      log: (message) => postCompactionLog.warn(message),
    });
    failed++;
  }

  for (const delegate of delegatesWithinLimit) {
    if (
      config.crossSessionTargeting === "disabled" &&
      hasCrossSessionDelegateTargeting(delegate, sessionKey)
    ) {
      postCompactionLog.warn(
        `[continuation:post-compaction-policy-rejected] policy.cross_session_targeting session=${sessionKey} task=${delegate.task.slice(0, 80)}`,
      );
      enqueueSystemEvent(
        `[continuation] Post-compaction delegate rejected: cross-session targeting is disabled by policy. Task: ${delegate.task}`,
        { sessionKey, trusted: true },
      );
      emitContinuationDisabledSpan({
        chainId: undefined,
        chainStepRemaining: config.maxChainLength,
        disabledReason: "policy.cross_session_targeting",
        signalKind: "tool-delegate",
        delegateDelivery: "immediate",
        delegateMode: "post-compaction",
        reason: delegate.task,
        log: (message) => postCompactionLog.warn(message),
      });
      failed++;
      continue;
    }

    const budgetCheck = checkContinuationBudget({
      chainState: {
        currentChainCount,
        chainStartedAt,
        accumulatedChainTokens,
      },
      config,
      sessionKey,
    });
    if (budgetCheck) {
      const disabledReason = budgetCheck === "chain-capped" ? "cap.chain" : "cap.cost";
      const summary =
        budgetCheck === "chain-capped"
          ? `chain length ${config.maxChainLength} reached`
          : `cost cap exceeded (${accumulatedChainTokens} > ${config.costCapTokens})`;
      postCompactionLog.warn(
        `[continuation:post-compaction-policy-rejected] ${disabledReason} session=${sessionKey} task=${delegate.task.slice(0, 80)}`,
      );
      enqueueSystemEvent(
        `[continuation] Post-compaction delegate rejected: ${summary}. Task: ${delegate.task}`,
        { sessionKey, trusted: true },
      );
      emitContinuationDisabledSpan({
        chainId: undefined,
        chainStepRemaining: Math.max(0, config.maxChainLength - currentChainCount),
        disabledReason,
        signalKind: "tool-delegate",
        delegateDelivery: "immediate",
        delegateMode: "post-compaction",
        reason: delegate.task,
        log: (message) => postCompactionLog.warn(message),
      });
      failed++;
      continue;
    }

    try {
      const spawnTraceparent = resolveContinuationTraceparent(delegate.traceparent);
      const spawnResult = await spawnSubagentDirect(
        {
          task: delegate.task,
          silentAnnounce: true,
          wakeOnReturn: true,
          drainsContinuationDelegateQueue: true,
          ...(delegate.model ? { model: delegate.model } : {}),
          ...(delegate.targetSessionKey
            ? { continuationTargetSessionKey: delegate.targetSessionKey }
            : {}),
          ...(delegate.targetSessionKeys && delegate.targetSessionKeys.length > 0
            ? { continuationTargetSessionKeys: delegate.targetSessionKeys }
            : {}),
          ...(delegate.fanoutMode ? { continuationFanoutMode: delegate.fanoutMode } : {}),
          ...(spawnTraceparent ? { traceparent: spawnTraceparent } : {}),
        },
        spawnCtx,
      );
      if (spawnResult.status === "accepted") {
        currentChainCount++;
        dispatched++;
        continue;
      }
      postCompactionLog.warn(
        `[continuation:post-compaction-spawn-rejected] status=${spawnResult.status} session=${sessionKey} reason=${spawnResult.error ?? "not accepted"} task=${delegate.task.slice(0, 80)}`,
      );
      enqueueSystemEvent(
        `[continuation] Post-compaction delegate spawn ${spawnResult.status}: ${spawnResult.error ?? "delegation was not accepted."}. Task: ${delegate.task}`,
        { sessionKey, trusted: true },
      );
      failed++;
    } catch (err) {
      postCompactionLog.warn(
        `[continuation:post-compaction-spawn-failed] error=${err instanceof Error ? err.message : String(err)} session=${sessionKey} task=${delegate.task.slice(0, 80)}`,
      );
      enqueueSystemEvent(
        `[continuation] Post-compaction delegate spawn failed: ${String(err)}. Task: ${delegate.task}`,
        { sessionKey, trusted: true },
      );
      failed++;
    }
  }

  return { dispatched, failed };
}
