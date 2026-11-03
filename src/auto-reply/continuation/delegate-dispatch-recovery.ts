/** Stateless startup recovery for continuation delegates (RFC §5.4.4, §4.4). */

import { getRuntimeConfig } from "../../config/config.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { loadSessionEntry, updateSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { enqueueSystemEventRaw as enqueueSystemEvent } from "../../infra/system-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import { deliveryContextFromSession } from "../../utils/delivery-context.read.js";
import { resolveContinuationRuntimeConfig } from "./config.js";
import { DelegateTerminalChainStatePersistError } from "./delegate-dispatch-chain-state.js";
import type { DelegateDispatchContext } from "./delegate-dispatch-contract.js";
import { armDelegateDispatchHedge } from "./delegate-dispatch-hedge.js";
import { dispatchToolDelegates } from "./delegate-dispatch.js";
import {
  deliverOwedDelegateNotice,
  listOwedDelegateNotices,
} from "./delegate-spawn-interrupted.js";
import {
  listRecoverableStagedPostCompactionDelegates,
  releaseStagedPostCompactionDelegateToQueue,
  requeueAwaitingNextCompactionDelegatesRaw as requeueAwaitingNextCompactionDelegateRows,
  toSessionPostCompactionDelegate,
} from "./delegate-store-post-compaction.js";
import {
  classifyRecoverablePendingDelegates,
  clearRecoverableDelegatesChainTokensFold,
  listPendingDelegateSessionKeysForRecovery,
  listUnresolvedDelegateClaims,
  peekEarliestQueuedDelegateDueAt,
  reconcileContinuationDelegateAttachmentCustody,
} from "./delegate-store.js";
import { formatDelegateTaskForSystemEvent } from "./delegate-system-event.js";
import { rejectPostCompactionDelegate } from "./post-compaction-rejection.js";
import {
  classifyPostCompactionDelegateAge,
  formatPostCompactionStaleRejection,
} from "./post-compaction-staleness.js";
import type { ChainState } from "./scheduler.js";
import { loadContinuationChainState, persistContinuationChainState } from "./state.js";
import { withContinuationOwner } from "./system-event-ownership.js";
import type { PendingContinuationDelegate } from "./types.js";

const log = createSubsystemLogger("continuation/delegate-dispatch");
// A claim a head swap aborted is requeued by the dispatch holding it; look again after this.
const ABORTED_CLAIM_REARM_MS = 30_000;

function formatErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Chain state read from and persisted to the session row instead of a turn's closures. The
 * in-memory mirror keeps `loadFreshChainState` fresh so sequential hedge fires for several
 * delayed delegates see the advancing basis instead of the stale pre-dispatch entry.
 */
function sessionRowChainState(sessionKey: string, storePath: string, entry: SessionEntry) {
  const persistChainState = async (nextState: ChainState): Promise<void> => {
    const updated = await updateSessionEntry(
      { sessionKey, storePath },
      (sessionEntry) => {
        persistContinuationChainState({
          sessionEntry,
          count: nextState.currentChainCount,
          startedAt: nextState.chainStartedAt,
          tokens: nextState.accumulatedChainTokens,
          ...(nextState.chainId ? { chainId: nextState.chainId } : {}),
        });
        return sessionEntry;
      },
      { requireWriteSuccess: true },
    );
    if (!updated) {
      throw new Error(`session entry disappeared during recovery: ${sessionKey}`);
    }
    persistContinuationChainState({
      sessionEntry: entry,
      count: nextState.currentChainCount,
      startedAt: nextState.chainStartedAt,
      tokens: nextState.accumulatedChainTokens,
      ...(nextState.chainId ? { chainId: nextState.chainId } : {}),
    });
  };
  return {
    persistChainState,
    persistBeforeTerminalCommit: true,
    loadFreshChainState: () => loadContinuationChainState(entry),
  };
}

/**
 * A /new or /reset cleared the replaced head's hedge, whose chain-state callbacks wrote through
 * that head's run. Re-arm the delegates the reset kept as startup recovery drives them, on the
 * session row alone. A claim the reset aborted stays with the dispatch holding it, which requeues
 * it if it never dispatched; it is never resolved here.
 */
export async function rearmPendingContinuationDelegates(params: {
  sessionKey: string;
  storePath: string;
  entry: SessionEntry;
}): Promise<void> {
  const { sessionKey, storePath, entry } = params;
  const runtimeConfig = resolveContinuationRuntimeConfig();
  // Disabled continuation leaves the kept rows durable for a re-enable, as recovery does.
  if (!runtimeConfig.enabled) {
    return;
  }
  const earliestQueuedDueAt = await peekEarliestQueuedDelegateDueAt(sessionKey);
  const claimed =
    (await listUnresolvedDelegateClaims(sessionKey, { updatedAtOrBefore: Date.now() })).length > 0;
  const fireAt = claimed
    ? Math.min(earliestQueuedDueAt ?? Infinity, Date.now() + ABORTED_CLAIM_REARM_MS)
    : earliestQueuedDueAt;
  if (fireAt === undefined) {
    return;
  }
  armDelegateDispatchHedge(
    sessionKey,
    fireAt,
    {
      chainState: loadContinuationChainState(entry),
      ctx: { sessionKey },
      maxChainLength: runtimeConfig.maxChainLength,
      applyDelegateChainTokensFold: true,
      ...sessionRowChainState(sessionKey, storePath, entry),
    },
    dispatchToolDelegates,
  );
}

/** Deliver every interrupted-spawn notice custody still owes (RFC §5.4.2). */
async function drainOwedDelegateNotices(): Promise<number> {
  let delivered = 0;
  for (const record of await listOwedDelegateNotices()) {
    try {
      if (await deliverOwedDelegateNotice(record)) {
        delivered += 1;
      }
    } catch (err) {
      // The obligation stays set for the next recovery pass.
      log.warn(
        `[continuation:delegate-notice-drain-failed] flowId=${record.recordId} error=${formatErrorMessage(err)}`,
      );
    }
  }
  return delivered;
}

export async function recoverPendingContinuationDelegates(
  params: {
    chainState?: ChainState;
    ctx?: Partial<DelegateDispatchContext>;
    maxChainLength?: number;
    /** Override the session-store path used to load persisted chain budgets. */
    storePath?: string;
    /**
     * Startup recovery owns only rows that were already queued when recovery was
     * armed. Rows created later belong to the live post-response drain/hedge.
     */
    queuedCreatedAtOrBefore?: number;
    /** Exclude running rows claimed after recovery was armed. */
    includeRunningUpdatedAtOrBefore?: number;
  } = {},
): Promise<{ sessions: number; dispatched: number; rejected: number }> {
  const custody = await reconcileContinuationDelegateAttachmentCustody(
    params.queuedCreatedAtOrBefore ?? Date.now(),
  );
  if (custody.failed > 0) {
    log.warn(
      `[continuation:delegate-attachment-reconcile-failed] failures=${custody.failed} removed=${custody.removed}`,
    );
  }
  // Owed interrupted-spawn notices are delivered even when continuation is
  // disabled: the debt is a visible outcome of work that already ran.
  await drainOwedDelegateNotices();
  const runtimeConfig = resolveContinuationRuntimeConfig();
  const includeRunningUpdatedAtOrBefore = params.includeRunningUpdatedAtOrBefore ?? Date.now();
  await classifyRecoverablePendingDelegates({
    queuedCreatedAtOrBefore: params.queuedCreatedAtOrBefore,
    includeRunningUpdatedAtOrBefore,
  });
  // Honor the deny-gate across the restart seam: if continuation is disabled,
  // recovery must NOT replay valid queued/running delegates — re-driving them
  // here would override the user's explicit `continuation.enabled=false`.
  if (!runtimeConfig.enabled) {
    return { sessions: 0, dispatched: 0, rejected: 0 };
  }
  const sessionKeys = await listPendingDelegateSessionKeysForRecovery({
    queuedCreatedAtOrBefore: params.queuedCreatedAtOrBefore,
    includeRunningUpdatedAtOrBefore,
  });
  const runtimeConfigSnapshot = getRuntimeConfig();
  let dispatched = 0;
  let rejected = 0;
  let recoveredSessions = 0;
  for (const sessionKey of sessionKeys) {
    const agentId = parseAgentSessionKey(sessionKey)?.agentId;
    const storePath =
      params.storePath ??
      resolveSessionStorePathCore(runtimeConfigSnapshot.session?.store, { agentId });
    let recoveredEntry: ReturnType<typeof loadSessionEntry>;
    try {
      recoveredEntry = loadSessionEntry({
        hydrateSkillPromptRefs: false,
        readConsistency: "latest",
        sessionKey,
        storePath,
      });
    } catch (err) {
      log.warn(
        `[continuation:delegate-recovery-store-load-failed] path=${storePath} leaving queued/running delegates recoverable: ${formatErrorMessage(err)}`,
      );
      continue;
    }
    let recoveryChainState = params.chainState;
    if (!recoveryChainState) {
      if (!recoveredEntry) {
        log.warn(
          `[continuation:delegate-recovery-session-missing] path=${storePath} session=${sessionKey} leaving queued/running delegates recoverable`,
        );
        continue;
      }
      recoveryChainState = loadContinuationChainState(recoveredEntry);
    }
    recoveredSessions++;
    // When the caller provides their own chainState they own persistence.
    const rowChainState =
      !params.chainState && recoveredEntry
        ? sessionRowChainState(sessionKey, storePath, recoveredEntry)
        : undefined;
    const persistRecoveredChainState = rowChainState?.persistChainState;
    let result: Awaited<ReturnType<typeof dispatchToolDelegates>>;
    try {
      result = await dispatchToolDelegates({
        sessionKey,
        chainState: recoveryChainState,
        ctx: { ...params.ctx, sessionKey },
        maxChainLength: params.maxChainLength ?? runtimeConfig.maxChainLength,
        // Claims left `running` at or before the boot cutoff belonged to a dead
        // dispatch: the dispatcher decides each from `subagent_runs` and never
        // spawns it again (RFC §5.4.4, Q3).
        recoverRunningDelegates: true,
        queuedCreatedAtOrBefore: params.queuedCreatedAtOrBefore,
        includeRunningUpdatedAtOrBefore,
        // Recovery rebuilds chain cost from the persisted child entry, which is
        // stale when the settle-time chain-cost persist failed; apply the
        // delegate's durable fold so the cost cap holds across the restart.
        applyDelegateChainTokensFold: true,
        // A recovered delayed delegate only arms a hedge here; pass the persist +
        // fresh-load callbacks so the eventual hedge fire durably advances the
        // folded chain state instead of losing it (cost-cap bypass).
        ...rowChainState,
      });
    } catch (err) {
      if (err instanceof DelegateTerminalChainStatePersistError) {
        log.warn(
          `[continuation:delegate-recovery-chain-persist-failed] session=${sessionKey} leaving accepted rows recoverable: ${formatErrorMessage(err.originalError)}`,
        );
        continue;
      }
      throw err;
    }
    dispatched += result.dispatched;
    rejected += result.rejected;
    if (persistRecoveredChainState && (result.dispatched > 0 || result.rejected > 0)) {
      if (!result.chainStatePersistedBeforeTerminalCommit) {
        await persistRecoveredChainState(result.chainState);
      }
      if (result.appliedChainTokensFold && result.appliedChainTokensFold > 0) {
        await clearRecoverableDelegatesChainTokensFold(sessionKey);
      }
    }
  }
  return { sessions: recoveredSessions, dispatched, rejected };
}

// ---------------------------------------------------------------------------
// Post-compaction delegate startup recovery (docs/design/continue-work-signal-v2.md §4.4)
// ---------------------------------------------------------------------------

const postCompactionRecoveryLog = createSubsystemLogger("continuation/compaction");

/** Startup: records persisted for the next compaction seam go back to staged. */
export async function requeueAwaitingNextCompactionDelegates(options: {
  runningUpdatedAtOrBefore: number;
}): Promise<{ requeued: number }> {
  return {
    requeued: await requeueAwaitingNextCompactionDelegateRows({
      runningUpdatedAtOrBefore: options.runningUpdatedAtOrBefore,
    }),
  };
}

/**
 * Startup recovery for post-compaction delegates a crash left claimed for
 * release before the release committed (RFC §4.4). Release and queue insert
 * are one commit, so such a record has no queue entry and no spawn can have
 * begun for it. For a session that already compacted there is no later seam
 * to consume it, so recovery finishes the release now: stale work fails, the
 * per-turn budget applies as at the seam, and the rest go to the queue in the
 * same atomic release. Only the entries released here are drained; entries
 * that already existed belong to session-delivery recovery.
 */
export async function recoverAndReleaseStagedPostCompactionDelegates(options: {
  runningUpdatedAtOrBefore: number;
}): Promise<{ sessions: number; dispatched: number; failed: number }> {
  const recoverable = await listRecoverableStagedPostCompactionDelegates({
    runningUpdatedAtOrBefore: options.runningUpdatedAtOrBefore,
  });
  if (recoverable.length === 0) {
    return { sessions: 0, dispatched: 0, failed: 0 };
  }
  const delegatesBySession = new Map<string, PendingContinuationDelegate[]>();
  for (const { sessionKey, delegate } of recoverable) {
    const list = delegatesBySession.get(sessionKey) ?? [];
    list.push(delegate);
    delegatesBySession.set(sessionKey, list);
  }
  const runtimeConfigSnapshot = getRuntimeConfig();
  const { maxDelegatesPerTurn } = resolveContinuationRuntimeConfig(runtimeConfigSnapshot);
  let released = 0;
  let failed = 0;
  let recoveredSessions = 0;
  for (const [sessionKey, delegates] of delegatesBySession) {
    const agentId = parseAgentSessionKey(sessionKey)?.agentId;
    const storePath = resolveSessionStorePathCore(runtimeConfigSnapshot.session?.store, {
      agentId,
    });
    let entry: ReturnType<typeof loadSessionEntry>;
    try {
      entry = loadSessionEntry({
        hydrateSkillPromptRefs: false,
        readConsistency: "latest",
        sessionKey,
        storePath,
      });
    } catch (err) {
      postCompactionRecoveryLog.warn(
        `[continuation:post-compaction-recovery-store-load-failed] path=${storePath} leaving staged delegates recoverable: ${formatErrorMessage(err)}`,
      );
      continue;
    }
    if (!entry?.sessionId) {
      postCompactionRecoveryLog.warn(
        `[continuation:post-compaction-recovery-session-missing] path=${storePath} session=${sessionKey} leaving staged delegates recoverable`,
      );
      continue;
    }
    recoveredSessions++;
    const now = Date.now();
    const releasable: PendingContinuationDelegate[] = [];
    for (const delegate of delegates) {
      const staleness = classifyPostCompactionDelegateAge(delegate, now);
      if (staleness.stale) {
        postCompactionRecoveryLog.warn(
          `[continuation:post-compaction-release-stale] flowId=${delegate.flowId ?? "none"} session=${sessionKey} ageMs=${staleness.ageMs}`,
        );
        if (
          await rejectPostCompactionDelegate(
            delegate,
            formatPostCompactionStaleRejection(staleness.ageMs),
          )
        ) {
          failed++;
        }
        continue;
      }
      releasable.push(delegate);
    }
    for (const dropped of releasable.slice(maxDelegatesPerTurn)) {
      const summary = `Post-compaction delegate rejected: maxDelegatesPerTurn exceeded (${maxDelegatesPerTurn}).`;
      if (await rejectPostCompactionDelegate(dropped, summary)) {
        failed++;
        // Same owner notice the compaction seam emits for this cap.
        if (agentId) {
          enqueueSystemEvent(
            `[continuation] ${summary} Task: ${formatDelegateTaskForSystemEvent(dropped.task)}`,
            withContinuationOwner({ sessionKey, trusted: true }, agentId),
          );
        }
      }
    }
    const deliveryContext = deliveryContextFromSession(entry);
    const entryIds: string[] = [];
    for (const [sequence, delegate] of releasable.slice(0, maxDelegatesPerTurn).entries()) {
      const result = await releaseStagedPostCompactionDelegateToQueue({
        sessionKey,
        delegate: toSessionPostCompactionDelegate(delegate, now),
        sourceSessionId: entry.sessionId,
        ...(entry.lifecycleRevision ? { sourceLifecycleRevision: entry.lifecycleRevision } : {}),
        sequence,
        ...(entry.compactionCount !== undefined ? { compactionCount: entry.compactionCount } : {}),
        ...(deliveryContext ? { deliveryContext } : {}),
      });
      if (result.released) {
        entryIds.push(result.entryId);
        released++;
      } else {
        postCompactionRecoveryLog.warn(
          `[continuation:post-compaction-recovery-release-not-committed] flowId=${delegate.flowId ?? "none"} session=${sessionKey} reason=${result.reason}`,
        );
      }
    }
    if (entryIds.length > 0) {
      const { drainPostCompactionDelegateDeliveries } =
        await import("../reply/post-compaction-delegate-dispatch.js");
      await drainPostCompactionDelegateDeliveries({ sessionKey, entryIds });
    }
  }
  return { sessions: recoveredSessions, dispatched: released, failed };
}
