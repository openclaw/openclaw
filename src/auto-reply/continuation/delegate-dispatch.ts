/**
 * Dispatches immediate and delayed continuation delegates.
 * Every outcome stays visible at info level; timer-only logging hides immediate work.
 */

import { deriveContinuationDelegateChildSessionKeyFromParent } from "../../agents/subagent-continuation-ids.js";
import { isSpawnSubagentAdmissionCancelledError } from "../../agents/subagents/spawn/subagent-spawn-contract.js";
import { spawnSubagentDirect } from "../../agents/subagents/spawn/subagent-spawn.js";
import {
  emitContinuationDelegateFireSpan,
  emitContinuationDisabledSpan,
  resolveContinuationTraceparent,
  startContinuationDelegateSpan,
} from "../../infra/continuation-tracer.js";
import { generateChainId } from "../../infra/secure-random.js";
import { enqueueSystemEventRaw as enqueueSystemEvent } from "../../infra/system-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveContinuationRuntimeConfig } from "./config.js";
import {
  partitionDelegateClaimsByAdmission,
  type ClaimedDelegate,
} from "./delegate-dispatch-accepted-children.js";
import {
  DelegateTerminalChainStatePersistError,
  formatDelegateDispatchError as formatErrorMessage,
  persistChainStateBeforeTerminalCommit,
} from "./delegate-dispatch-chain-state.js";
import type {
  DelegateDispatchParams,
  DelegateDispatchResult,
} from "./delegate-dispatch-contract.js";
import { runUnderContinuationDelegateDispatchGrant } from "./delegate-dispatch-grant.js";
import { armDelegateDispatchHedge, clearDelegateDispatchHedge } from "./delegate-dispatch-hedge.js";
import {
  buildDelegateSpawnRequest,
  delegateBudgetChainState,
} from "./delegate-dispatch-request.js";
import { commitPendingDelegateSpawnAcceptance } from "./delegate-spawn-acceptance.js";
import {
  createContinuationOwnerSessionLoader,
  registerContinuationDelegateDispatchClaim,
} from "./delegate-spawn-authority.js";
import { terminalizeInterruptedDelegateClaim } from "./delegate-spawn-interrupted.js";
import {
  annotateQueuedDelegatesInheritedPolicy,
  clearRecoverableDelegatesChainTokensFold,
  consumePendingDelegates,
  listUnresolvedDelegateClaims,
  markPendingDelegateFailed,
  peekEarliestQueuedDelegateDueAt,
  revalidatePendingDelegateForSpawn,
  requeuePendingDelegate,
  spawnResultNeverDispatched,
} from "./delegate-store.js";
import { formatDelegateTaskForSystemEvent } from "./delegate-system-event.js";
import { checkContinuationBudget, type ChainState } from "./scheduler.js";
import { bindContinuationOwner } from "./system-event-ownership.js";
import { hasCrossSessionDelegateTargeting } from "./targeting-pure.js";
import type { PendingContinuationDelegate } from "./types.js";

export { resetDelegateDispatchHedgesForTests } from "./delegate-dispatch-hedge.js";

const log = createSubsystemLogger("continuation/delegate-dispatch");

function hedgeParamsFor(params: DelegateDispatchParams) {
  return {
    chainState: params.chainState,
    ctx: params.ctx,
    maxChainLength: params.maxChainLength,
    ...(params.config ? { config: params.config } : {}),
    loadFreshChainState: params.loadFreshChainState,
    ...(params.applyDelegateChainTokensFold ? { applyDelegateChainTokensFold: true } : {}),
    persistChainState: params.persistChainState,
    ...(params.persistBeforeTerminalCommit ? { persistBeforeTerminalCommit: true } : {}),
  };
}

/**
 * Consume and dispatch all pending tool-dispatched delegates for a session.
 *
 * Called by agent-runner.ts after the response finalizes.
 * Each delegate goes through chain/cost enforcement and is spawned via spawnSubagentDirect.
 */
export async function dispatchToolDelegates(
  params: DelegateDispatchParams,
): Promise<DelegateDispatchResult> {
  const { sessionKey, chainState, ctx } = params;
  const config = params.config ?? resolveContinuationRuntimeConfig();
  // A hedge may consume only rows this dispatch could have annotated with its
  // inherited policy. Rows queued later belong to their own turn's dispatch.
  const hedgeQueuedCreatedAtOrBefore = params.queuedCreatedAtOrBefore ?? Date.now();
  // Fail closed: applying a delegate chain-cost fold requires a persist path so
  // a hedge armed for a still-unmatured delegate can durably advance the folded
  // chain state when it fires. Without `persistChainState` the hedge would fold
  // the cost only in memory and lose it (later hops rebuild from the stale entry
  // and bypass the cost cap), so force immediate dispatch here instead of arming
  // a lossy hedge.
  const foldWithoutPersist = params.applyDelegateChainTokensFold && !params.persistChainState;
  const ignoreDelay = params.dispatchQueuedRegardlessOfDelay === true || foldWithoutPersist;
  // Recovery resolves claims left `running` by a dead dispatch before it
  // claims anything new. The cutoff is the boot time, so a claim this process
  // made can never be mistaken for an abandoned one.
  const unresolvedClaims =
    params.recoverRunningDelegates === true && params.includeRunningUpdatedAtOrBefore !== undefined
      ? await listUnresolvedDelegateClaims(sessionKey, {
          updatedAtOrBefore: params.includeRunningUpdatedAtOrBefore,
        })
      : [];
  const toolDelegates = await consumePendingDelegates(sessionKey, {
    queuedCreatedAtOrBefore: params.queuedCreatedAtOrBefore,
    ignoreDelay,
  });

  // Arm (or re-arm) a hedge timer for any remaining queued delegates so a
  // deadline crossed during consumption still fires in a fully-quiet channel.
  const earliestQueuedDueAt = await peekEarliestQueuedDelegateDueAt(sessionKey, {
    queuedCreatedAtOrBefore: hedgeQueuedCreatedAtOrBefore,
  });
  if (earliestQueuedDueAt !== undefined) {
    // Inherited silent/wake policy is recorded on each still-queued delegate
    // here, so the hedge never has to carry one chain's mode at the session
    // level and leak it onto an unrelated delegate queued by a later turn.
    await annotateQueuedDelegatesInheritedPolicy(
      sessionKey,
      {
        ...(params.inheritedSilent ? { inheritedSilent: true } : {}),
        ...(params.inheritedWake ? { inheritedWake: true } : {}),
      },
      hedgeQueuedCreatedAtOrBefore,
    );
    armDelegateDispatchHedge(
      sessionKey,
      earliestQueuedDueAt,
      {
        ...hedgeParamsFor(params),
        ...(params.recoverRunningDelegates ? { recoverRunningDelegates: true } : {}),
        queuedCreatedAtOrBefore: hedgeQueuedCreatedAtOrBefore,
        ...(params.includeRunningUpdatedAtOrBefore !== undefined
          ? { includeRunningUpdatedAtOrBefore: params.includeRunningUpdatedAtOrBefore }
          : {}),
      },
      dispatchToolDelegates,
    );
  } else if (params.queuedCreatedAtOrBefore === undefined) {
    clearDelegateDispatchHedge(sessionKey);
  }

  if (toolDelegates.length === 0 && unresolvedClaims.length === 0) {
    return { dispatched: 0, rejected: 0, chainState };
  }
  const ownerSession = createContinuationOwnerSessionLoader(sessionKey, ctx.ownerAgentId);
  const ownerEventOptions = bindContinuationOwner(ownerSession.agentId);

  log.info(
    `[continue_delegate] Consuming ${toolDelegates.length} tool delegate(s) for session ${sessionKey}${unresolvedClaims.length > 0 ? ` and resolving ${unresolvedClaims.length} unresolved claim(s)` : ""}`,
  );

  const { maxDelegatesPerTurn, maxChainLength, crossSessionTargeting } = config;
  const {
    accepted: acceptedDelegates,
    interrupted: interruptedDelegates,
    pending: pendingDelegates,
  } = await partitionDelegateClaimsByAdmission({
    unresolvedClaims,
    claimed: toolDelegates,
    ownerSessionKey: sessionKey,
    onUnavailable: (delegate, err) =>
      log.warn(
        `[continuation:delegate-admission-evidence-unavailable] flowId=${delegate.flowId ?? "unknown"} session=${sessionKey} error=${formatErrorMessage(err)}`,
      ),
  });
  const delegateSlotsAvailable = Math.max(0, maxDelegatesPerTurn - acceptedDelegates.length);
  const delegatesWithinLimit: ClaimedDelegate[] = acceptedDelegates.concat(
    pendingDelegates.slice(0, delegateSlotsAvailable).map((delegate) => ({ delegate })),
  );
  const delegatesOverLimit = pendingDelegates.slice(delegateSlotsAvailable);
  let dispatched = 0,
    rejected = delegatesOverLimit.length + interruptedDelegates.length;
  let currentChainCount = chainState.currentChainCount;
  const foldBearingDelegates = acceptedDelegates
    .map(({ delegate }) => delegate)
    .concat(
      interruptedDelegates.map(({ delegate }) => delegate),
      pendingDelegates,
    );
  const appliedChainTokensFold = params.applyDelegateChainTokensFold
    ? Math.max(0, ...foldBearingDelegates.map((delegate) => delegate.chainTokensFold ?? 0))
    : 0;
  let currentAccumulatedTokens = chainState.accumulatedChainTokens + appliedChainTokensFold;
  let currentChainId = chainState.chainId;
  let chainStatePersistedBeforeTerminalCommit = false;
  const terminalChainStateForDelegate = (delegate: PendingContinuationDelegate): ChainState =>
    delegate.persistedChainState ?? {
      currentChainCount,
      chainStartedAt: chainState.chainStartedAt,
      accumulatedChainTokens: currentAccumulatedTokens,
      ...(currentChainId ? { chainId: currentChainId } : {}),
    };
  const persistTerminalChainState = async (
    delegate: PendingContinuationDelegate,
    nextState: ChainState,
    options: { markPlannedChainState?: boolean; markerKind?: "advanced" | "terminal" } = {},
  ): Promise<PendingContinuationDelegate> => {
    try {
      const updatedDelegate = await persistChainStateBeforeTerminalCommit(
        params,
        delegate,
        nextState,
        options,
      );
      if (params.persistBeforeTerminalCommit && params.persistChainState) {
        chainStatePersistedBeforeTerminalCommit = true;
      }
      return updatedDelegate;
    } catch (error) {
      const persistedFoldNeedsCleanup =
        error instanceof DelegateTerminalChainStatePersistError &&
        chainStatePersistedBeforeTerminalCommit &&
        appliedChainTokensFold > 0;
      if (persistedFoldNeedsCleanup) {
        await clearRecoverableDelegatesChainTokensFold(sessionKey);
      }
      throw error;
    }
  };
  const persistTerminalFailure = (delegate: PendingContinuationDelegate) =>
    persistTerminalChainState(delegate, terminalChainStateForDelegate(delegate), {
      markPlannedChainState: appliedChainTokensFold > 0,
      markerKind: "terminal",
    });
  const notifyOwner = (text: string): void => {
    enqueueSystemEvent(text, ownerEventOptions({ sessionKey, trusted: true }));
  };

  // Q3 (RFC §5.4.4): a claim whose admission cannot be proven ends in one
  // durable interrupted notice and is never spawned again.
  for (const { delegate, evidence } of interruptedDelegates) {
    log.info(
      `[continuation:delegate-spawn-interrupted] flowId=${delegate.flowId ?? "unknown"} session=${sessionKey} evidence=${evidence?.kind ?? "none"}`,
    );
    const failedDelegate = await persistTerminalFailure(delegate);
    await terminalizeInterruptedDelegateClaim(failedDelegate, {
      collision: evidence?.kind === "collision",
      ownerAgentId: ownerSession.agentId,
    });
  }

  for (const dropped of delegatesOverLimit) {
    const summary = `Tool delegate rejected: maxDelegatesPerTurn exceeded (${maxDelegatesPerTurn}).`;
    log.info(
      `[continuation:delegate-rejected] maxDelegatesPerTurn=${maxDelegatesPerTurn} task=${dropped.task.slice(0, 80)} session=${sessionKey}`,
    );
    const failedDelegate = await persistTerminalFailure(dropped);
    await markPendingDelegateFailed(failedDelegate, summary);
    notifyOwner(
      `[continuation] ${summary} Task: ${formatDelegateTaskForSystemEvent(dropped.task)}`,
    );
  }

  for (const { delegate, evidence } of delegatesWithinLimit) {
    const admitted = evidence?.kind === "admitted" ? evidence : undefined;
    const childSessionKey =
      admitted?.childSessionKey ??
      (delegate.flowId
        ? deriveContinuationDelegateChildSessionKeyFromParent(sessionKey, delegate.flowId)
        : undefined);
    const acceptedChildAlreadyKnown = admitted !== undefined;
    if (
      !acceptedChildAlreadyKnown &&
      crossSessionTargeting === "disabled" &&
      hasCrossSessionDelegateTargeting(delegate, sessionKey)
    ) {
      const delegateMode = delegate.mode ?? "normal";
      const delegateDelivery = delegate.delayMs && delegate.delayMs > 0 ? "timer" : "immediate";
      const summary = "Tool delegate rejected: cross-session targeting is disabled by policy.";
      log.info(
        `[continuation:delegate-rejected] policy.cross_session_targeting task=${delegate.task.slice(0, 80)} session=${sessionKey}`,
      );
      const failedDelegate = await persistTerminalFailure(delegate);
      await markPendingDelegateFailed(failedDelegate, summary);
      notifyOwner(
        `[continuation] ${summary} Task: ${formatDelegateTaskForSystemEvent(delegate.task)}`,
      );
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

    const persistedChainStateKind = delegate.persistedChainStateKind ?? "advanced";
    const budgetChainState = delegateBudgetChainState(delegate, {
      currentChainCount,
      chainStartedAt: chainState.chainStartedAt,
      accumulatedChainTokens: currentAccumulatedTokens,
      ...(currentChainId ? { chainId: currentChainId } : {}),
    });
    const budgetCheck = acceptedChildAlreadyKnown
      ? undefined
      : checkContinuationBudget({
          chainState: budgetChainState,
          config,
          sessionKey,
        });

    if (budgetCheck) {
      const summary = `Tool delegate rejected: ${budgetCheck}.`;
      log.info(
        `[continuation:delegate-rejected] ${budgetCheck} task=${delegate.task.slice(0, 80)} session=${sessionKey}`,
      );
      const failedDelegate = await persistTerminalFailure(delegate);
      await markPendingDelegateFailed(failedDelegate, summary);
      notifyOwner(
        `[continuation] ${summary} Task: ${formatDelegateTaskForSystemEvent(delegate.task)}`,
      );
      rejected++;
      continue;
    }

    const nextHop =
      delegate.persistedChainState && persistedChainStateKind === "advanced"
        ? delegate.persistedChainState.currentChainCount
        : currentChainCount + 1;
    const tokens = delegate.persistedChainState?.accumulatedChainTokens ?? currentAccumulatedTokens;
    const dispatchChainId =
      delegate.persistedChainState?.chainId ?? currentChainId ?? generateChainId();
    const plannedTerminalChainState: ChainState = {
      currentChainCount: nextHop,
      chainStartedAt: delegate.persistedChainState?.chainStartedAt ?? chainState.chainStartedAt,
      accumulatedChainTokens: tokens,
      ...(dispatchChainId ? { chainId: dispatchChainId } : {}),
    };
    const commitPlannedChainState = (chainId: string | undefined): void => {
      dispatched++;
      currentChainCount = nextHop;
      currentAccumulatedTokens = tokens;
      currentChainId = chainId ?? currentChainId;
    };

    // Own mode wins; otherwise inherit the parent chain's silent/wake policy so a
    // default-mode delegate spawned under a silent/wake chain stays internal
    // instead of announcing (mirrors the subagent-announce chain-hop guards).
    const ownSilent = delegate.mode === "silent" || delegate.mode === "silent-wake";
    const ownWake = delegate.mode === "silent-wake";
    const canInheritMode = delegate.mode === undefined;
    const inheritedSilent = delegate.inheritedSilent === true || params.inheritedSilent === true;
    const inheritedWake = delegate.inheritedWake === true || params.inheritedWake === true;
    const silent = ownSilent || (canInheritMode && inheritedSilent);
    const silentWake = ownWake || (canInheritMode && inheritedSilent && inheritedWake);
    const outboundTraceparent = resolveContinuationTraceparent(delegate.traceparent);
    const delegateMode = silentWake ? "silent-wake" : silent ? "silent" : "normal";
    const delegateDelayMs = delegate.delayMs ?? 0;
    const delegateDelivery: "immediate" | "timer" = delegateDelayMs > 0 ? "timer" : "immediate";

    let dispatchSpan: ReturnType<typeof startContinuationDelegateSpan> | undefined;
    let spawnAttempted = false;
    let rollbackAcceptedSpawn: (() => Promise<void>) | undefined;
    let releaseAcceptedSpawnHold: (() => void) | undefined;
    const activeDispatch = registerContinuationDelegateDispatchClaim({
      controller: "pending",
      delegate,
      ownerSession,
      ownerSessionKey: sessionKey,
    });
    // An uncertain spawn outcome ends the claim with the interrupted notice
    // (Q3); only a spawn that provably never dispatched goes back to the queue.
    const settleUncertainSpawn = async (reasonText: string): Promise<void> => {
      log.info(
        `[continuation:delegate-spawn-uncertain] flowId=${delegate.flowId ?? "unknown"} session=${sessionKey} reason=${reasonText}`,
      );
      const failedDelegate = await persistTerminalFailure(delegate);
      await terminalizeInterruptedDelegateClaim(failedDelegate, {
        ownerAgentId: ownerSession.agentId,
      });
      rejected++;
    };
    try {
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
      if (delegateDelivery === "timer") {
        // The concrete dispatch span is the last trace owner before deferred work
        // fires. Parent fire to it so a missing origin carrier cannot split traces.
        emitContinuationDelegateFireSpan({
          chainId: dispatchChainId,
          chainStepRemainingAtDispatch: maxChainLength - nextHop,
          delegateMode,
          delayMs: delegateDelayMs,
          fireDeferredMs: Date.now() - (delegate.firstArmedAt ?? Date.now()),
          reason: delegate.task,
          traceparent: spawnTraceparent,
          log: (message) => log.info(message),
        });
      }
      if (childSessionKey && acceptedChildAlreadyKnown) {
        const acceptedDelegate = await persistTerminalChainState(
          delegate,
          plannedTerminalChainState,
          { markPlannedChainState: true, markerKind: "advanced" },
        );
        try {
          await commitPendingDelegateSpawnAcceptance(
            acceptedDelegate,
            childSessionKey,
            Boolean(params.persistChainState),
            undefined,
            admitted?.runId,
          );
        } catch (err) {
          const errorMessage = formatErrorMessage(err);
          log.warn(
            `[continuation:delegate-accept-finalize-failed] flowId=${delegate.flowId ?? "unknown"} session=${sessionKey} leaving row recoverable: ${errorMessage}`,
          );
          dispatchSpan.setStatus("ERROR", errorMessage);
          rejected++;
          continue;
        }
        dispatchSpan.setStatus("OK");
        commitPlannedChainState(dispatchChainId);
        continue;
      }
      const spawnFence = await revalidatePendingDelegateForSpawn(delegate, "pending");
      if (!spawnFence.allowed) {
        log.info(
          `[continuation:delegate-spawn-fenced] reason=${spawnFence.reason} flowId=${delegate.flowId ?? "unknown"} session=${sessionKey}`,
        );
        dispatchSpan.setStatus("ERROR", spawnFence.summary);
        notifyOwner(
          `[continuation] ${spawnFence.summary} Task: ${formatDelegateTaskForSystemEvent(delegate.task)}`,
        );
        rejected++;
        continue;
      }
      // A refused grant throws before the spawn: a terminal rejection, never an uncertain spawn.
      const result = await runUnderContinuationDelegateDispatchGrant(
        {
          grant: delegate.dispatchGrant,
          ownerSessionKey: sessionKey,
          resolveGatewayContext: ctx.resolveGatewayContext,
        },
        () => {
          spawnAttempted = true;
          return spawnSubagentDirect(
            buildDelegateSpawnRequest({
              delegate,
              nextHop,
              maxChainLength,
              chainState: {
                startedAt: plannedTerminalChainState.chainStartedAt,
                tokens,
                chainId: dispatchChainId,
              },
              silent,
              silentWake,
              ...(spawnTraceparent ? { traceparent: spawnTraceparent } : {}),
            }),
            {
              agentSessionKey: sessionKey,
              requesterAgentIdOverride: activeDispatch.ownerAgentId,
              ...(delegate.originRunId ? { requesterTurnRunId: delegate.originRunId } : {}),
              agentChannel: ctx.agentChannel,
              agentAccountId: ctx.agentAccountId,
              agentTo: ctx.agentTo,
              agentThreadId: ctx.agentThreadId,
              continuationDelegateAdmission: activeDispatch.authority,
            },
          );
        },
      );

      if (result.status === "accepted") {
        rollbackAcceptedSpawn = result.rollbackAccepted;
        releaseAcceptedSpawnHold = result.releaseAcceptanceHold;
        // INFO-level on EVERY successful spawn — observability parity.
        log.info(
          `[continuation:delegate-spawned] hop=${nextHop}/${maxChainLength} mode=${delegate.mode ?? "normal"} session=${sessionKey} task=${delegate.task.slice(0, 80)}`,
        );
        enqueueSystemEvent(
          `[continuation:delegate-spawned] Spawned turn ${nextHop}/${maxChainLength}: ${formatDelegateTaskForSystemEvent(delegate.task)}`,
          ownerEventOptions({ sessionKey, trusted: true }),
        );
        const acceptedChildSessionKey = result.childSessionKey ?? childSessionKey;
        const acceptedDelegate = await persistTerminalChainState(
          delegate,
          plannedTerminalChainState,
          { markPlannedChainState: true, markerKind: "advanced" },
        );
        activeDispatch.authority.assertCurrent("final-acceptance", null);
        if (acceptedChildSessionKey) {
          try {
            await commitPendingDelegateSpawnAcceptance(
              acceptedDelegate,
              acceptedChildSessionKey,
              Boolean(params.persistChainState),
              result.rollbackAccepted,
              result.runId ?? delegate.spawnAttempt?.childRunId,
            );
          } catch (err) {
            const errorMessage = formatErrorMessage(err);
            log.warn(
              `[continuation:delegate-accept-finalize-failed] flowId=${delegate.flowId ?? "unknown"} session=${sessionKey} accepted child rolled back: ${errorMessage}`,
            );
            dispatchSpan.setStatus("ERROR", errorMessage);
            rejected++;
            continue;
          }
        }
        commitPlannedChainState(dispatchChainId);
        // Final acceptance point (H1 §3.2): disarm the child's durable acceptance intent.
        const acceptance = await result.confirmAccepted?.();
        if (acceptance === "refused") {
          throw new Error("Continuation delegate acceptance could not be confirmed.");
        }
        rollbackAcceptedSpawn = undefined;
        if (acceptance === "uncertain") {
          // Own acceptance is committed: keep it, never roll back or respawn.
          log.warn(
            `[continuation:delegate-accept-uncertain] flowId=${delegate.flowId ?? "unknown"} session=${sessionKey} child=${result.runId ?? "unknown"}`,
          );
        }
        dispatchSpan.setStatus("OK");
      } else if (!spawnResultNeverDispatched(result)) {
        dispatchSpan.setStatus("ERROR", result.error ?? `delegate spawn ${result.status}`);
        await settleUncertainSpawn(`${result.status}:${result.failurePhase ?? "unknown-phase"}`);
      } else if (result.status === "cancelled") {
        // Nothing dispatched: keep the delegate for a later dispatch unless
        // reset or a fence already ended the record.
        await requeuePendingDelegate(
          delegate,
          "Admission cancelled before spawn",
          { inheritedSilent, inheritedWake },
          { failurePhase: "initialize" },
        );
        dispatchSpan.setStatus("ERROR", result.error ?? "delegate admission cancelled");
        rejected++;
      } else {
        const reasonText = result.error ?? "delegation was not accepted.";
        const summary = `DELEGATE spawn ${result.status}: ${reasonText}`;
        log.info(
          `[continuation:delegate-spawn-rejected] status=${result.status} session=${sessionKey} reason=${reasonText} task=${delegate.task.slice(0, 80)}`,
        );
        const failedDelegate = await persistTerminalFailure(delegate);
        await markPendingDelegateFailed(failedDelegate, summary);
        dispatchSpan.setStatus("ERROR", reasonText);
        notifyOwner(
          `[continuation] ${summary} Task: ${formatDelegateTaskForSystemEvent(delegate.task)}`,
        );
        rejected++;
      }
    } catch (err) {
      await rollbackAcceptedSpawn?.();
      if (isSpawnSubagentAdmissionCancelledError(err) && !spawnAttempted) {
        dispatchSpan?.setStatus("ERROR", err.message);
        rejected++;
        continue;
      }
      if (err instanceof DelegateTerminalChainStatePersistError) {
        const message = formatErrorMessage(err.originalError);
        dispatchSpan?.recordException(err.originalError);
        dispatchSpan?.setStatus("ERROR", message);
        log.warn(
          `[continuation:delegate-terminal-chain-persist-failed] error=${message} session=${sessionKey} task=${delegate.task.slice(0, 80)}`,
        );
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      const summary = `DELEGATE spawn failed: ${message}`;
      dispatchSpan?.recordException(err);
      dispatchSpan?.setStatus("ERROR", message);
      log.info(`[continuation:delegate-spawn-failed] error=${message} session=${sessionKey}`);
      if (spawnAttempted) {
        // A thrown spawn has no phase: admission is unproven (RFC §5.4.4).
        await settleUncertainSpawn(`thrown:${message}`);
        continue;
      }
      const failedDelegate = await persistTerminalFailure(delegate);
      await markPendingDelegateFailed(failedDelegate, summary);
      notifyOwner(
        `[continuation] ${summary}. Task: ${formatDelegateTaskForSystemEvent(delegate.task)}`,
      );
      rejected++;
    } finally {
      // An unconfirmed arm is let go here; the registry sweeper fails it closed.
      releaseAcceptedSpawnHold?.();
      activeDispatch.release();
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
      accumulatedChainTokens: currentAccumulatedTokens,
      ...(currentChainId ? { chainId: currentChainId } : {}),
    },
    ...(appliedChainTokensFold > 0 ? { appliedChainTokensFold } : {}),
    ...(chainStatePersistedBeforeTerminalCommit ? { chainStatePersistedBeforeTerminalCommit } : {}),
  };
}
