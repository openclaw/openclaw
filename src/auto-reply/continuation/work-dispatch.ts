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
const CONTINUATION_TURN_BUSY_REASON = "requests-in-flight";

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
    void dispatchPendingContinuationWork({ sessionKey, recoverRunning: true })
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
    { parseAgentSessionKey },
    { getReplyFromConfig },
    { replyRunRegistry },
  ] = await Promise.all([
    import("../../config/config.js"),
    import("../../config/sessions/paths.js"),
    import("../../config/sessions/store-load.js"),
    import("../../sessions/session-key-utils.js"),
    import("../reply/get-reply.js"),
    import("../reply/reply-run-registry.js"),
  ]);

  // Same-session continuations grant a normal turn directly. Do not route through
  // heartbeat wake registration/active-hours gates, which are agent-schedule policy
  // and can strand subagent sessions that are otherwise eligible for a turn.
  if (replyRunRegistry.isActive(work.sessionKey)) {
    return { status: "skipped", reason: CONTINUATION_TURN_BUSY_REASON };
  }

  const cfg = getRuntimeConfig();
  const agentId = parseAgentSessionKey(work.sessionKey)?.agentId;
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  const store = loadSessionStore(storePath);
  const entry = store[work.sessionKey];
  if (!entry) {
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
      enqueueSystemEvent(wakeText, { sessionKey: work.sessionKey, trusted: true });
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
      if (isRetryableHeartbeatBusySkipReason(skippedReason)) {
        const retryDueAt = Date.now() + BUSY_RETRY_MS;
        const requeued = requeuePendingWork(work, {
          dueAt: retryDueAt,
          summary: `Retryable busy skip: ${skippedReason}`,
        });
        if (requeued) {
          armWorkTimer(work.sessionKey, retryDueAt);
        }
      } else {
        markPendingWorkFailed(work, `Continuation turn was not granted: ${skippedReason}`);
        failed++;
      }
    } catch (err) {
      const message = formatErrorMessage(err);
      markPendingWorkFailed(work, message);
      failed++;
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
  await dispatchPendingContinuationWork({ sessionKey: params.sessionKey });
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
  const includeRunningUpdatedAtOrBefore = Date.now();
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
