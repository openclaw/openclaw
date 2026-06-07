/** Durable same-session continuation_work dispatch. */

import {
  emitContinuationWorkFireSpan,
  emitContinuationWorkSpan,
} from "../../infra/continuation-tracer.js";
import { isRetryableHeartbeatBusySkipReason } from "../../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { clampDelayMs, resolveContinuationRuntimeConfig } from "./config.js";
import { checkContinuationBudget } from "./scheduler.js";
import type { ChainState, ContinuationRuntimeConfig } from "./types.js";
import {
  consumePendingWork,
  enqueuePendingWork,
  listPendingWorkSessionKeysForRecovery,
  markPendingWorkFailed,
  markPendingWorkTurnGranted,
  peekSoonestUnmaturedWorkDueAt,
  requeuePendingWork,
  type PendingContinuationWork,
} from "./work-store.js";

const log = createSubsystemLogger("continuation/work-dispatch");
const HEDGE_DISPATCH_FAILURE_RETRY_MS = 30_000;
const BUSY_RETRY_MS = 1_000;
const TRANSIENT_ERROR_RETRY_MS = 5_000;
const MAX_TRANSIENT_ERROR_RETRY_COUNT = 8;
const CONTINUATION_TURN_BUSY_REASON = "requests-in-flight";
const CONTINUATION_TURN_DRAINING_REASON = "draining";
const MAIN_COMMAND_LANE = "main";
const RUNNING_WORK_RECOVERY_STALE_MS = 60_000;

const workTimers = new Map<string, NodeJS.Timeout>();

function formatErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function clearWorkTimer(sessionKey: string): void {
  const existing = workTimers.get(sessionKey);
  if (!existing) {
    return;
  }
  clearTimeout(existing);
  workTimers.delete(sessionKey);
}

function armWorkTimer(sessionKey: string, fireAt: number): void {
  clearWorkTimer(sessionKey);
  const fireIn = Math.max(0, fireAt - Date.now());
  log.info(
    `[continuation:work-hedge-armed] fireIn=${fireIn}ms fireAt=${fireAt} session=${sessionKey}`,
  );
  const handle = setTimeout(() => {
    workTimers.delete(sessionKey);
    log.info(`[continuation:work-hedge-fired] session=${sessionKey}`);
    void dispatchPendingContinuationWork({
      sessionKey,
      recoverRunning: true,
      includeRunningUpdatedAtOrBefore: Date.now() - RUNNING_WORK_RECOVERY_STALE_MS,
    })
      .then(() => undefined)
      .catch((err: unknown) => {
        const message = formatErrorMessage(err);
        log.error(`[continuation:work-hedge-error] error=${message} session=${sessionKey}`);
        armWorkTimer(sessionKey, Date.now() + HEDGE_DISPATCH_FAILURE_RETRY_MS);
      });
  }, fireIn);
  handle.unref();
  workTimers.set(sessionKey, handle);
}

export function resetContinuationWorkDispatchForTests(): void {
  for (const handle of workTimers.values()) {
    clearTimeout(handle);
  }
  workTimers.clear();
}

function isRetryableContinuationSkipReason(reason: string): boolean {
  return isRetryableHeartbeatBusySkipReason(reason) || reason === CONTINUATION_TURN_DRAINING_REASON;
}

function requeueWorkForRetry(
  work: PendingContinuationWork,
  params: { dueAt: number; summary: string; retryCount?: number },
): boolean {
  const requeued = requeuePendingWork(work, params);
  if (requeued) {
    armWorkTimer(work.sessionKey, params.dueAt);
  }
  return requeued;
}

function formatContinuationWakeText(work: PendingContinuationWork): string {
  return (
    `[continuation:wake] Turn ${work.hop}/${work.maxChainLength}. ` +
    (work.chainStartedAt !== undefined
      ? `Chain started at ${new Date(work.chainStartedAt).toISOString()}. `
      : "") +
    (work.accumulatedChainTokens !== undefined
      ? `Accumulated tokens: ${work.accumulatedChainTokens}. `
      : "") +
    `The agent elected to continue working.` +
    (work.reason ? ` Reason: ${work.reason}` : "")
  );
}

type ContinuationTurnGrantResult = { status: "ran" } | { status: "skipped"; reason: string };

async function driveContinuationTurn(
  work: PendingContinuationWork,
  wakeText: string,
): Promise<ContinuationTurnGrantResult> {
  const [
    { getRuntimeConfig },
    { resolveStorePath },
    { loadSessionStore },
    { resolveSessionStoreEntry },
    { parseAgentSessionKey },
    { getReplyFromConfig },
    { replyRunRegistry },
    { getQueueSize, isGatewayDraining },
  ] = await Promise.all([
    import("../../config/config.js"),
    import("../../config/sessions/paths.js"),
    import("../../config/sessions/store-load.js"),
    import("../../config/sessions/store-entry.js"),
    import("../../sessions/session-key-utils.js"),
    import("../reply/get-reply.js"),
    import("../reply/reply-run-registry.js"),
    import("../../process/command-queue.js"),
  ]);

  // Same-session continuations grant a normal turn directly. Do not route through
  // heartbeat wake registration/active-hours gates, which are agent-schedule policy
  // and can strand subagent sessions that are otherwise eligible for a turn.
  if (isGatewayDraining()) {
    return { status: "skipped", reason: CONTINUATION_TURN_DRAINING_REASON };
  }
  if (replyRunRegistry.isActive(work.sessionKey)) {
    return { status: "skipped", reason: CONTINUATION_TURN_BUSY_REASON };
  }
  // Direct grants bypass heartbeat policy, but they must not jump ahead of
  // already queued user/main-lane work. Requeue via TaskFlow instead of silently
  // dropping the wake like the heartbeat path did.
  if (getQueueSize(MAIN_COMMAND_LANE) > 0) {
    return { status: "skipped", reason: CONTINUATION_TURN_BUSY_REASON };
  }

  const cfg = getRuntimeConfig();
  const agentId = parseAgentSessionKey(work.sessionKey)?.agentId;
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  const store = loadSessionStore(storePath);
  const resolvedEntry = resolveSessionStoreEntry({ store, sessionKey: work.sessionKey });
  if (!resolvedEntry.existing) {
    return { status: "skipped", reason: "missing-session" };
  }

  await getReplyFromConfig(
    {
      Body: wakeText,
      BodyForCommands: wakeText,
      CommandBody: wakeText,
      Provider: "system",
      Surface: "system",
      From: "system",
      To: "agent",
      SessionKey: work.sessionKey,
      RuntimePolicySessionKey: work.sessionKey,
      ...(agentId ? { AgentId: agentId } : {}),
    },
    {
      continuationTrigger: "work-wake",
      parentRunId: work.parentRunId,
      typingPolicy: "system_event",
      suppressTyping: true,
    },
    cfg,
  );
  if (isGatewayDraining()) {
    return { status: "skipped", reason: CONTINUATION_TURN_DRAINING_REASON };
  }
  return { status: "ran" };
}

export async function dispatchPendingContinuationWork(params: {
  sessionKey: string;
  recoverRunning?: boolean;
  includeRunningUpdatedAtOrBefore?: number;
}): Promise<{ dispatched: number; failed: number }> {
  const works = consumePendingWork(params.sessionKey, {
    includeRunning: params.recoverRunning === true,
    includeRunningUpdatedAtOrBefore: params.includeRunningUpdatedAtOrBefore,
  });
  const soonest = peekSoonestUnmaturedWorkDueAt(params.sessionKey);
  if (soonest !== undefined) {
    armWorkTimer(params.sessionKey, soonest);
  } else {
    clearWorkTimer(params.sessionKey);
  }

  let dispatched = 0;
  let failed = 0;
  for (const work of works) {
    try {
      const fireDeferredMs = Date.now() - work.electedAt;
      const fireChainId = work.chainId ?? work.flowId ?? work.sessionKey;
      emitContinuationWorkFireSpan({
        chainId: fireChainId,
        chainStepRemainingAtDispatch: Math.max(0, work.maxChainLength - work.hop),
        delayMs: work.delayMs,
        fireDeferredMs,
        reason: work.reason,
        log: (message) => log.info(message),
      });
      log.info(
        `[continuation:work-wake] hop=${work.hop}/${work.maxChainLength} session=${work.sessionKey}`,
      );
      const wakeText = formatContinuationWakeText(work);
      const result = await driveContinuationTurn(work, wakeText);
      if (result.status === "ran") {
        markPendingWorkTurnGranted(work);
        dispatched++;
        continue;
      }
      const skippedReason = result.reason;
      log.warn(
        `[continuation:work-drive-skipped] flowId=${work.flowId ?? "none"} session=${work.sessionKey} reason=${skippedReason}`,
      );
      enqueueSystemEvent(
        `[system:continuation-warning] continue_work turn was not granted (${skippedReason}).`,
        { sessionKey: work.sessionKey, trusted: true },
      );
      if (isRetryableContinuationSkipReason(skippedReason)) {
        const retryDueAt = Date.now() + BUSY_RETRY_MS;
        requeueWorkForRetry(work, {
          dueAt: retryDueAt,
          summary: `Retryable continuation skip: ${skippedReason}`,
        });
      } else {
        markPendingWorkFailed(work, `Continuation turn was not granted: ${skippedReason}`);
        failed++;
      }
    } catch (err) {
      const message = formatErrorMessage(err);
      const retryCount = (work.retryCount ?? 0) + 1;
      if (retryCount <= MAX_TRANSIENT_ERROR_RETRY_COUNT) {
        const retryDueAt = Date.now() + TRANSIENT_ERROR_RETRY_MS;
        log.warn(
          `[continuation:work-drive-error-retry] flowId=${work.flowId ?? "none"} session=${work.sessionKey} retry=${retryCount}/${MAX_TRANSIENT_ERROR_RETRY_COUNT} error=${message}`,
        );
        requeueWorkForRetry(work, {
          dueAt: retryDueAt,
          summary: `Transient continuation turn error: ${message}`,
          retryCount,
        });
      } else {
        markPendingWorkFailed(work, message);
        failed++;
      }
    }
  }
  return { dispatched, failed };
}

export async function scheduleContinuationWork(params: {
  sessionKey: string;
  chainState: ChainState;
  request: { delaySeconds: number; reason: string; traceparent?: string };
  config: ContinuationRuntimeConfig;
  parentRunId?: string;
  log?: (message: string) => void;
}): Promise<{ scheduled: boolean; capped: boolean; chainState: ChainState }> {
  const budgetCheck = checkContinuationBudget({
    chainState: params.chainState,
    config: params.config,
    sessionKey: params.sessionKey,
  });
  if (budgetCheck) {
    params.log?.(
      `[continuation:work-rejected] ${budgetCheck} for ${params.sessionKey}: ${params.chainState.currentChainCount}/${params.config.maxChainLength}`,
    );
    return { scheduled: false, capped: true, chainState: params.chainState };
  }

  const hop = params.chainState.currentChainCount + 1;
  const delayMs = clampDelayMs(params.request.delaySeconds * 1000, params.config);
  const electedAt = Date.now();
  const dueAt = electedAt + delayMs;
  const nextState: ChainState = {
    currentChainCount: hop,
    chainStartedAt: params.chainState.chainStartedAt,
    accumulatedChainTokens: params.chainState.accumulatedChainTokens,
    ...(params.chainState.chainId ? { chainId: params.chainState.chainId } : {}),
  };
  const work: PendingContinuationWork = {
    sessionKey: params.sessionKey,
    hop,
    delayMs,
    electedAt,
    dueAt,
    maxChainLength: params.config.maxChainLength,
    chainStartedAt: params.chainState.chainStartedAt,
    accumulatedChainTokens: params.chainState.accumulatedChainTokens,
    ...(params.request.reason ? { reason: params.request.reason } : {}),
    ...(params.parentRunId ? { parentRunId: params.parentRunId } : {}),
    ...(params.chainState.chainId ? { chainId: params.chainState.chainId } : {}),
    ...(params.request.traceparent ? { traceparent: params.request.traceparent } : {}),
  };
  const enqueued = enqueuePendingWork(work);
  if (!enqueued) {
    return { scheduled: false, capped: false, chainState: params.chainState };
  }
  emitContinuationWorkSpan({
    chainId: params.chainState.chainId,
    chainStepRemaining: params.config.maxChainLength - hop,
    delayMs,
    reason: params.request.reason,
    traceparent: params.request.traceparent,
    log: (message) => params.log?.(message),
  });
  const soonestDueAt = peekSoonestUnmaturedWorkDueAt(params.sessionKey);
  const fireAt = soonestDueAt === undefined ? dueAt : Math.min(dueAt, soonestDueAt);
  // Let callers persist the advanced chain state before even zero-delay work
  // can start the next turn; the timer fires on the next event-loop tick.
  armWorkTimer(params.sessionKey, fireAt);
  return { scheduled: true, capped: false, chainState: nextState };
}

export async function recoverPendingContinuationWork(): Promise<{
  sessions: number;
  dispatched: number;
  failed: number;
}> {
  const runtimeConfig = resolveContinuationRuntimeConfig();
  if (!runtimeConfig.enabled) {
    return { sessions: 0, dispatched: 0, failed: 0 };
  }
  const sessionKeys = listPendingWorkSessionKeysForRecovery();
  const includeRunningUpdatedAtOrBefore = Date.now() - RUNNING_WORK_RECOVERY_STALE_MS;
  let dispatched = 0;
  let failed = 0;
  for (const sessionKey of sessionKeys) {
    const result = await dispatchPendingContinuationWork({
      sessionKey,
      recoverRunning: true,
      includeRunningUpdatedAtOrBefore,
    });
    dispatched += result.dispatched;
    failed += result.failed;
  }
  return { sessions: sessionKeys.length, dispatched, failed };
}
