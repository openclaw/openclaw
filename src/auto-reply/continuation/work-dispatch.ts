/** Durable same-session continuation_work dispatch. */

import type { SubagentRunLiveness } from "../../agents/subagent-run-liveness.js";
import {
  emitContinuationWorkFireSpan,
  emitContinuationWorkSpan,
} from "../../infra/continuation-tracer.js";
import { isRetryableHeartbeatBusySkipReason } from "../../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { clampDelayMs, resolveContinuationRuntimeConfig } from "./config.js";
import { checkContinuationBudget } from "./scheduler.js";
import type { ChainState, ContinuationRuntimeConfig, ContinueWorkRequest } from "./types.js";
import {
  consumePendingWork,
  enqueuePendingWork,
  hasPendingIdleRetryWork,
  listPendingWorkSessionKeysForRecovery,
  markPendingWorkDelivered,
  markPendingWorkFailed,
  markPendingWorkReaped,
  markPendingWorkSuperseded,
  markPendingWorkTurnGranted,
  queuedPendingWorkCount,
  peekSoonestQueuedWorkDueAt,
  peekSoonestRunningWorkRecoveryDueAt,
  peekSoonestUnmaturedWorkDueAt,
  requeuePendingWork,
  type ContinuationWorkReasonCategory,
  type PendingContinuationWork,
} from "./work-store.js";

const log = createSubsystemLogger("continuation/work-dispatch");
const HEDGE_DISPATCH_FAILURE_RETRY_MS = 30_000;
const TRANSIENT_ERROR_RETRY_MS = 5_000;
const MAX_TRANSIENT_ERROR_RETRY_COUNT = 8;
const CONTINUATION_TURN_BUSY_REASON = "requests-in-flight";
const CONTINUATION_TURN_COMMAND_QUEUE_BUSY_REASON = "command-queue-busy";
const CONTINUATION_TURN_DRAINING_REASON = "draining";
const MAIN_COMMAND_LANE = "main";
const RUNNING_WORK_RECOVERY_STALE_MS = 60_000;
// #986 Guard 2: a matured backlog member is "stale" (superseded-eligible) when it
// is overdue past this multiple of the configured maxDelayMs. Close bursts stay
// below the grace and are NOT collapsed; only a genuine stale pile is folded.
const SUPERSEDED_GRACE_MULTIPLIER = 2;

const workTimers = new Map<string, NodeJS.Timeout>();
const idleRetryControllers = new Map<string, AbortController>();

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

function clearIdleRetryControllersForTests(): void {
  for (const controller of idleRetryControllers.values()) {
    controller.abort();
  }
  idleRetryControllers.clear();
}

function armWorkTimer(
  sessionKey: string,
  fireAt: number,
  options: { includeIdleRetry?: boolean } = {},
): void {
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
      includeIdleRetry: options.includeIdleRetry === true,
      recoverRunning: true,
      includeRunningUpdatedAtOrBefore: Date.now() - RUNNING_WORK_RECOVERY_STALE_MS,
      includeRunningIdleRetry: true,
    })
      .then(() => undefined)
      .catch((err: unknown) => {
        const message = formatErrorMessage(err);
        log.error(`[continuation:work-hedge-error] error=${message} session=${sessionKey}`);
        armNextWorkTimer(sessionKey, Date.now() + HEDGE_DISPATCH_FAILURE_RETRY_MS, options);
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
  clearIdleRetryControllersForTests();
}

function isRetryableContinuationSkipReason(reason: string): boolean {
  return (
    isRetryableHeartbeatBusySkipReason(reason) ||
    reason === CONTINUATION_TURN_DRAINING_REASON ||
    reason === CONTINUATION_TURN_COMMAND_QUEUE_BUSY_REASON
  );
}

/**
 * #990 rate curve retained for diagnostics/config compatibility.
 *
 * A busy-skip (`requests-in-flight`/`draining`) means the turn never started — a
 * legit defer, never a failed attempt. Older runtime re-armed via this exp-backoff
 * curve; #1088 changed the primary retry to idle events and uses the ceiling as
 * the slow hedge. Keep the pure curve for existing config semantics and tests.
 *
 * `busySkipCount` is the PRE-increment prior-skip count so the first computed
 * step yields `baseMs` (factor^0): base, base·f, base·f², … capped at
 * `ceilingMs`. `factor ** n` overflowing to Infinity is harmless — `Math.min`
 * clamps it to the ceiling.
 */
export type BusySkipBackoffParams = { baseMs: number; ceilingMs: number; factor: number };

export function computeBusySkipBackoffMs(
  busySkipCount: number,
  params: BusySkipBackoffParams,
): number {
  const exponent = Math.max(0, busySkipCount);
  return Math.min(params.ceilingMs, params.baseMs * params.factor ** exponent);
}

/**
 * #990 bucket-1 — orphan-reap verdict for a busy-deferred continuation flow.
 *
 * Pure decision over the delegate-flow-gate + a read-time parent-liveness join.
 * Asymmetric error cost is load-bearing (#952): wrongly culling a busy seat is
 * unrecoverable; parking a zombie is harmless. So ONLY a confident-terminal
 * parent authorizes the cull — `alive`, `uncertain`, and the no-lineage gate all
 * quiesce (rate-cap-forever, the Pillar-0 trickle).
 */
export type BucketOneReapVerdict = "reap" | "rate-cap-forever";

export function bucket1ReapVerdict(
  parentRunId: string | undefined,
  parentLiveness: SubagentRunLiveness,
): BucketOneReapVerdict {
  // Delegate-flow-gate FIRST: a flow with no spawning lineage (same-session
  // continue_work, or a recovered row without parentRunId) is never an orphan we
  // may reap. Never wrongful-reap.
  if (parentRunId == null) {
    return "rate-cap-forever";
  }
  if (parentLiveness === "confident-terminal") {
    return "reap";
  }
  return "rate-cap-forever";
}

/**
 * Read-time parent-liveness join (#990): classify the latest subagent run for a
 * flow's own session against the LIVE registry map. Never persisted — liveness
 * mutates after a flow is classified (a driver can die or finish between the
 * classify and this read). Lazy dynamic import keeps the agents registry off the
 * continuation static import graph (cycle-safe) while the read itself is a
 * synchronous in-process Map lookup.
 */
async function readChildSessionRunLiveness(
  sessionKey: string,
  options: { now: number; staleCutoffMs?: number },
): Promise<SubagentRunLiveness> {
  const [{ subagentRuns }, { classifyChildSessionRunLivenessFromRuns }] = await Promise.all([
    import("../../agents/subagent-registry-memory.js"),
    import("../../agents/subagent-registry-queries.js"),
  ]);
  return classifyChildSessionRunLivenessFromRuns(subagentRuns, sessionKey, options);
}

function requeueWorkForRetry(
  work: PendingContinuationWork,
  params: Parameters<typeof requeuePendingWork>[1],
): boolean {
  const requeued = requeuePendingWork(work, params);
  if (requeued) {
    armNextWorkTimer(work.sessionKey, params.dueAt);
  }
  return requeued;
}

const GATEWAY_RESTARTING_REPLY_TEXT =
  "⚠️ Gateway is restarting. Please wait a few seconds and try again.";

type ReplyPayloadLike = { text?: unknown };

type ContinuationIdleRetryTrigger =
  | { kind: "reply-run-ended" }
  | { kind: "command-lane-idle"; lane: string };

function idleRetryTriggerKey(sessionKey: string, trigger: ContinuationIdleRetryTrigger): string {
  return trigger.kind === "reply-run-ended"
    ? `reply:${sessionKey}`
    : `lane:${trigger.lane}:${sessionKey}`;
}

function idleRetryTriggerLabel(
  trigger: ContinuationIdleRetryTrigger,
): "reply-run-ended" | "command-lane-idle" {
  return trigger.kind;
}

function idleRetryTriggerFromWork(
  work: PendingContinuationWork,
): ContinuationIdleRetryTrigger | undefined {
  if (!work.idleRetry) {
    return undefined;
  }
  return work.idleRetry.trigger === "reply-run-ended"
    ? { kind: "reply-run-ended" }
    : { kind: "command-lane-idle", lane: MAIN_COMMAND_LANE };
}

function clearIdleRetryForWork(work: PendingContinuationWork): void {
  const idleRetry = work.idleRetry;
  const trigger = idleRetryTriggerFromWork(work);
  if (!idleRetry || !trigger) {
    return;
  }
  const key = idleRetryTriggerKey(work.sessionKey, trigger);
  const controller = idleRetryControllers.get(key);
  if (!controller) {
    return;
  }
  if (
    hasPendingIdleRetryWork(work.sessionKey, {
      trigger: idleRetry.trigger,
      ...(work.flowId ? { excludeFlowId: work.flowId } : {}),
    })
  ) {
    return;
  }
  controller.abort();
  idleRetryControllers.delete(key);
}

export function classifyContinuationWorkReason(
  reason: string | undefined,
): ContinuationWorkReasonCategory {
  const normalized = reason?.trim().toLowerCase();
  if (!normalized) {
    return "unknown";
  }
  const waitMarkers = [
    "yield",
    "stand by",
    "standing by",
    "all tasks complete",
    "tasks complete",
    "external wake",
    "holding position",
    "heartbeat",
    "waiting for",
    "wait for",
  ];
  return waitMarkers.some((marker) => normalized.includes(marker))
    ? "wait-shaped"
    : "follow-up-work";
}

function registerIdleRetry(sessionKey: string, trigger: ContinuationIdleRetryTrigger): void {
  const key = idleRetryTriggerKey(sessionKey, trigger);
  if (idleRetryControllers.has(key)) {
    return;
  }
  const controller = new AbortController();
  idleRetryControllers.set(key, controller);
  const armedAt = Date.now();
  log.info(
    `[continuation:work-idle-retry-armed] trigger=${idleRetryTriggerLabel(trigger)} session=${sessionKey}`,
  );
  void (async () => {
    const idle =
      trigger.kind === "reply-run-ended"
        ? await (async () => {
            const { replyRunRegistry } = await import("../reply/reply-run-registry.js");
            return await replyRunRegistry.waitForIdle(sessionKey, undefined, {
              signal: controller.signal,
            });
          })()
        : await (async () => {
            const { waitForCommandLaneIdle } = await import("../../process/command-queue.js");
            return (
              await waitForCommandLaneIdle(trigger.lane, undefined, {
                signal: controller.signal,
              })
            ).idle;
          })();
    idleRetryControllers.delete(key);
    if (!idle || controller.signal.aborted) {
      return;
    }
    log.info(
      `[continuation:work-idle-retry-fired] trigger=${idleRetryTriggerLabel(trigger)} waitMs=${Date.now() - armedAt} session=${sessionKey}`,
    );
    await dispatchPendingContinuationWork({ sessionKey, includeIdleRetry: true });
  })().catch((err: unknown) => {
    idleRetryControllers.delete(key);
    if (controller.signal.aborted) {
      return;
    }
    const message = formatErrorMessage(err);
    log.error(
      `[continuation:work-idle-retry-error] trigger=${idleRetryTriggerLabel(trigger)} error=${message} session=${sessionKey}`,
    );
    armNextWorkTimer(sessionKey, Date.now() + HEDGE_DISPATCH_FAILURE_RETRY_MS, {
      includeIdleRetry: true,
    });
  });
}

function isReplyPayloadLike(value: unknown): value is ReplyPayloadLike {
  return Boolean(value && typeof value === "object");
}

function isGatewayRestartingReplyPayload(value: unknown): boolean {
  return isReplyPayloadLike(value) && value.text === GATEWAY_RESTARTING_REPLY_TEXT;
}

function hasNonDrainReplyPayload(reply: unknown): boolean {
  if (reply === undefined) {
    return false;
  }
  const payloads = Array.isArray(reply) ? reply : [reply];
  return payloads.some((payload) => !isGatewayRestartingReplyPayload(payload));
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

type ContinuationTurnGrantResult =
  | { status: "ran" }
  | { status: "skipped"; reason: string; retryTrigger?: ContinuationIdleRetryTrigger };

async function driveContinuationTurn(
  work: PendingContinuationWork,
  wakeText: string,
): Promise<ContinuationTurnGrantResult> {
  const [
    { getRuntimeConfig },
    { resolveStorePath },
    { loadSessionStore },
    { resolveSessionStoreEntry },
    { parseAgentSessionKey, isSubagentSessionKey },
    { resolveSessionLane },
    { getReplyFromConfig },
    { replyRunRegistry },
    { getQueueSize, isGatewayDraining },
  ] = await Promise.all([
    import("../../config/config.js"),
    import("../../config/sessions/paths.js"),
    import("../../config/sessions/store-load.js"),
    import("../../config/sessions/store-entry.js"),
    import("../../sessions/session-key-utils.js"),
    import("../../agents/embedded-agent-runner/lanes.js"),
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
    return {
      status: "skipped",
      reason: CONTINUATION_TURN_BUSY_REASON,
      retryTrigger: { kind: "reply-run-ended" },
    };
  }
  // Direct grants bypass heartbeat policy, but a main-session continuation must
  // not jump ahead of already queued user/main-lane work. A subagent continues
  // on its own session via a direct grant that never enters the shared main lane;
  // its readiness is the own-session active check above.
  const continuationLane = isSubagentSessionKey(work.sessionKey)
    ? resolveSessionLane(work.sessionKey)
    : undefined;
  if (continuationLane === undefined && getQueueSize(MAIN_COMMAND_LANE) > 0) {
    return {
      status: "skipped",
      reason: CONTINUATION_TURN_COMMAND_QUEUE_BUSY_REASON,
      retryTrigger: { kind: "command-lane-idle", lane: MAIN_COMMAND_LANE },
    };
  }

  const cfg = getRuntimeConfig();
  const agentId = parseAgentSessionKey(work.sessionKey)?.agentId;
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  const store = loadSessionStore(storePath);
  const resolvedEntry = resolveSessionStoreEntry({ store, sessionKey: work.sessionKey });
  if (!resolvedEntry.existing) {
    return { status: "skipped", reason: "missing-session" };
  }

  const reply = await getReplyFromConfig(
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
      lane: continuationLane,
      typingPolicy: "system_event",
      suppressTyping: true,
    },
    cfg,
  );
  if (!hasNonDrainReplyPayload(reply) && isGatewayDraining()) {
    return { status: "skipped", reason: CONTINUATION_TURN_DRAINING_REASON };
  }
  // #990 locus-3: the wake is confirmed delivered (the turn ran). Write the
  // durable delivered-mark NOW — before the persist-gap between here and the
  // dispatch loop's finishFlow — so a crash in that window leaves a row the
  // consume read-guard skips (no restart-gap re-delivery). The mark bumps the
  // revision on `work` so the follow-on markPendingWorkTurnGranted still applies.
  markPendingWorkDelivered(work);
  return { status: "ran" };
}

function earlierDueAt(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) {
    return right;
  }
  return right === undefined ? left : Math.min(left, right);
}

function armNextWorkTimer(
  sessionKey: string,
  dueAt: number,
  options: { includeIdleRetry?: boolean } = {},
): void {
  const soonestQueued = peekSoonestQueuedWorkDueAt(sessionKey);
  const runningRecoveryDueAt = peekSoonestRunningWorkRecoveryDueAt(
    sessionKey,
    RUNNING_WORK_RECOVERY_STALE_MS,
  );
  const soonest = earlierDueAt(earlierDueAt(dueAt, soonestQueued), runningRecoveryDueAt);
  armWorkTimer(sessionKey, soonest ?? dueAt, options);
}

/**
 * #986 Guard 2 — partition a matured drain batch into works to drive vs works
 * superseded by a stale backlog.
 *
 * `consumePendingWork` only returns matured (`now >= dueAt`) works, so a batch of
 * >1 is itself the backlog signal: on-time staggered elections fire one-per-poll
 * and never co-drain. Within such a batch we fold the OLDER members that are
 * stale (overdue past `graceMs`) into the newest-elected member, which carries
 * the live intent. Non-stale members (close bursts) always drive; the
 * newest-elected always drives.
 *
 * #988-P2-1 fold-side write-guard: only `queued` members are supersede-eligible.
 * A recovered `running` member (the recovery path passes `includeRunning`) is a
 * live turn already being driven and ALWAYS drives — it is never folded, even
 * when stale and not newest, so an in-flight turn is never finished-as-superseded
 * out from under itself. Pure for testability.
 */
export function partitionSupersededWork(
  works: readonly PendingContinuationWork[],
  graceMs: number,
  now: number,
): { drive: PendingContinuationWork[]; superseded: PendingContinuationWork[] } {
  if (works.length <= 1 || graceMs <= 0) {
    return { drive: [...works], superseded: [] };
  }
  // Identify the single newest-elected member. A synchronous batch enqueue can
  // stamp identical `electedAt` (the store writes are sync), so ties are broken
  // by `hop` (durable monotonic enqueue order within a chain) — the higher hop
  // is the newer intent. Without the tie-break, same-ms rows fall to array
  // order and the OLDEST stale wake could be kept while the newest is folded
  // (Codex #988 review :252).
  let newestIdx = 0;
  for (let i = 1; i < works.length; i++) {
    const w = works[i];
    const best = works[newestIdx];
    if (w.electedAt > best.electedAt || (w.electedAt === best.electedAt && w.hop > best.hop)) {
      newestIdx = i;
    }
  }
  const drive: PendingContinuationWork[] = [];
  const superseded: PendingContinuationWork[] = [];
  for (let i = 0; i < works.length; i++) {
    const work = works[i];
    // #988-P2-1 fold-side write-guard: a recovered `running` member is live
    // intent already being driven (it may be observing requests-in-flight). It
    // is NEVER supersede-eligible, regardless of staleness or election order —
    // folding it would finish an in-flight turn as superseded out from under
    // itself. Only `queued` backlog members can be coalesced into the newest.
    if (work.status === "running") {
      drive.push(work);
      continue;
    }
    const isNewest = i === newestIdx;
    const isStale = now - work.dueAt > graceMs;
    if (isNewest) {
      // The single newest-elected member always drives (live intent).
      drive.push(work);
    } else if (isStale) {
      superseded.push(work);
    } else {
      drive.push(work);
    }
  }
  return { drive, superseded };
}

export async function dispatchPendingContinuationWork(params: {
  sessionKey: string;
  recoverRunning?: boolean;
  includeRunningUpdatedAtOrBefore?: number;
  includeIdleRetry?: boolean;
  includeRunningIdleRetry?: boolean;
}): Promise<{ dispatched: number; failed: number; reaped: number }> {
  const recoverRunning = params.recoverRunning === true;
  let runningRecoveryBlockedByActiveReply = false;
  if (recoverRunning) {
    const { replyRunRegistry } = await import("../reply/reply-run-registry.js");
    runningRecoveryBlockedByActiveReply = replyRunRegistry.isActive(params.sessionKey);
  }
  const works = consumePendingWork(params.sessionKey, {
    includeRunning: recoverRunning && !runningRecoveryBlockedByActiveReply,
    includeRunningUpdatedAtOrBefore: params.includeRunningUpdatedAtOrBefore,
    includeIdleRetry: params.includeIdleRetry === true,
    includeRunningIdleRetry: params.includeRunningIdleRetry === true,
  });
  // #986 Guard 2: fold a stale backlog. Only matured works reach here, so a
  // batch of >1 means they piled up (the session was busy through the window);
  // on-time staggered elections drain one-per-poll and never co-arrive.
  const runtimeConfig = resolveContinuationRuntimeConfig();
  const supersededGraceMs = runtimeConfig.maxDelayMs * SUPERSEDED_GRACE_MULTIPLIER;
  const { drive: worksToDrive, superseded } = partitionSupersededWork(
    works,
    supersededGraceMs,
    Date.now(),
  );
  if (superseded.length > 0) {
    for (const stale of superseded) {
      clearIdleRetryForWork(stale);
      const overdueMs = Date.now() - stale.dueAt;
      log.info(
        `[continuation:work-superseded] flowId=${stale.flowId ?? "none"} session=${stale.sessionKey} hop=${stale.hop} overdueMs=${overdueMs} — folded into newer election`,
      );
      markPendingWorkSuperseded(
        stale,
        `Superseded by a newer continue_work election after a ${overdueMs}ms stale backlog.`,
      );
    }
    enqueueSystemEvent(
      `[system:continuation-note] ${superseded.length} stale continue_work wake(s) were folded into the newest election (backlog coalesce).`,
      { sessionKey: params.sessionKey, trusted: true },
    );
  }
  const soonestQueued = peekSoonestUnmaturedWorkDueAt(params.sessionKey);
  const runningRecoveryDueAt = peekSoonestRunningWorkRecoveryDueAt(
    params.sessionKey,
    RUNNING_WORK_RECOVERY_STALE_MS,
  );
  const soonestRunningRecovery =
    runningRecoveryDueAt === undefined
      ? undefined
      : recoverRunning && runningRecoveryBlockedByActiveReply
        ? Date.now() + RUNNING_WORK_RECOVERY_STALE_MS
        : runningRecoveryDueAt;
  const soonest = earlierDueAt(soonestQueued, soonestRunningRecovery);
  if (soonest !== undefined) {
    armWorkTimer(params.sessionKey, soonest);
  } else {
    clearWorkTimer(params.sessionKey);
  }

  let dispatched = 0;
  let failed = 0;
  let reaped = 0;
  for (const work of worksToDrive) {
    clearIdleRetryForWork(work);
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
        `[continuation:work-wake] hop=${work.hop}/${work.maxChainLength} session=${work.sessionKey} reasonCategory=${classifyContinuationWorkReason(work.reason)}`,
      );
      const wakeText = formatContinuationWakeText(work);
      const result = await driveContinuationTurn(work, wakeText);
      if (result.status === "ran") {
        markPendingWorkTurnGranted(work);
        dispatched++;
        continue;
      }
      const skippedReason = result.reason;
      const reasonCategory = classifyContinuationWorkReason(work.reason);
      log.warn(
        `[continuation:work-drive-skipped] flowId=${work.flowId ?? "none"} session=${work.sessionKey} reason=${skippedReason} reasonCategory=${reasonCategory}`,
      );
      if (isRetryableContinuationSkipReason(skippedReason)) {
        // #990 bucket-1: a busy-defer is the storm symptom. Before parking for
        // idle-event retry with a slow hedge, check whether
        // this is an ORPHAN whose parent run is confident-terminal and can never
        // rehydrate it. Read-time liveness join (never persisted — liveness
        // mutates after classify). Delegate-flow-gate FIRST: a flow with no
        // parentRunId (same-session continue_work) skips the read entirely and
        // quiesces (#952: never enter the orphan-branch for same-session work).
        // Only a confident-terminal parent authorizes the reap; alive/uncertain
        // all quiesce (asymmetric cost — wrongly-cull-busy is unrecoverable).
        const now = Date.now();
        const parentLiveness: SubagentRunLiveness =
          work.parentRunId == null
            ? "uncertain"
            : await readChildSessionRunLiveness(work.sessionKey, {
                now,
                ...(runtimeConfig.orphanReapStaleCutoffMs !== undefined
                  ? { staleCutoffMs: runtimeConfig.orphanReapStaleCutoffMs }
                  : {}),
              });
        if (bucket1ReapVerdict(work.parentRunId, parentLiveness) === "reap") {
          log.info(
            `[continuation:work-orphan-reaped] flowId=${work.flowId ?? "none"} session=${work.sessionKey} parentRunId=${work.parentRunId} — parent confident-terminal, can never rehydrate`,
          );
          markPendingWorkReaped(
            work,
            `Orphan continuation reaped: parent run ${work.parentRunId} is confident-terminal and can never rehydrate this flow.`,
          );
          reaped++;
          continue;
        }
        // Event-driven primary path: park behind the matching idle event and
        // keep only a slow hedge timer for lost events. busySkipCount remains
        // diagnostic/rate-cap state and never feeds the transient-error fail-bound.
        const priorBusySkips = work.busySkipCount ?? 0;
        // busySkipBackoff is always set by resolveContinuationRuntimeConfig; the
        // fallback only covers hand-built fixtures.
        const backoff = runtimeConfig.busySkipBackoff ?? {
          baseMs: 1_000,
          ceilingMs: runtimeConfig.maxDelayMs,
          factor: 2,
        };
        const retryDelayMs = result.retryTrigger
          ? backoff.ceilingMs
          : computeBusySkipBackoffMs(priorBusySkips, backoff);
        const retryDueAt = now + retryDelayMs;
        const requeued = requeueWorkForRetry(work, {
          dueAt: retryDueAt,
          summary: `Retryable continuation skip: ${skippedReason}`,
          busySkipCount: priorBusySkips + 1,
          ...(result.retryTrigger
            ? {
                idleRetry: {
                  trigger: idleRetryTriggerLabel(result.retryTrigger),
                  reasonCategory,
                  armedAt: now,
                },
              }
            : {}),
        });
        if (requeued && result.retryTrigger) {
          registerIdleRetry(work.sessionKey, result.retryTrigger);
        }
      } else {
        enqueueSystemEvent(
          `[system:continuation-warning] continue_work turn was not granted (${skippedReason}).`,
          { sessionKey: work.sessionKey, trusted: true },
        );
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
  return { dispatched, failed, reaped };
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

  // #986 Guard 1: per-session concurrent pending-work cap. Orthogonal to the
  // chain-depth cap above — this bounds how many undelivered wakes may coexist
  // (the multi-continue_work flood foot-gun). Enforced at enqueue so a flood can
  // never pile up beyond the cap regardless of chain depth. Treated as a cap
  // (capped: true) so the batch ends early with partial-success preserved.
  // Counts only QUEUED (future) wakes — not the currently-driving `running`
  // flow — so a serial chain at maxPendingWork:1 can still schedule its own
  // successor (the active wake is excluded; see queuedPendingWorkCount).
  const pending = queuedPendingWorkCount(params.sessionKey);
  if (pending >= params.config.maxPendingWork) {
    params.log?.(
      `[continuation:work-rejected] pending-capped for ${params.sessionKey}: ${pending}/${params.config.maxPendingWork}`,
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
  // Let callers persist the advanced chain state before even zero-delay work
  // can start the next turn; the timer fires on the next event-loop tick.
  armNextWorkTimer(params.sessionKey, dueAt);
  return { scheduled: true, capped: false, chainState: nextState };
}

export type ContinuationWorkBatchResult = {
  /** Elections that successfully enqueued a durable wake. */
  scheduledCount: number;
  /** Elections rejected once the cumulative chain/cost cap was reached. */
  cappedCount: number;
  /** True when a cap rejection ended the batch early. */
  capped: boolean;
  /** Chain state after the last scheduled election; persist this once. */
  chainState: ChainState;
};

/**
 * Schedule every continue_work election captured in a single model turn.
 *
 * A single model response can emit N `continue_work` tool calls; each is its
 * own flow with its own delay/reason and must deliver its own wake. The chain
 * state is threaded across elections so chain/cost caps apply cumulatively.
 *
 * Partial success is load-bearing (#982): when a later election trips the cap,
 * the earlier valid elections MUST stay scheduled — silently dropping them is
 * exactly the regression this batches against. A cap rejection ends the batch
 * because the cumulative chain count only grows, so every later election would
 * hit the same cap.
 */
export async function scheduleContinuationWorkBatch(params: {
  sessionKey: string;
  chainState: ChainState;
  requests: readonly ContinueWorkRequest[];
  config: ContinuationRuntimeConfig;
  parentRunId?: string;
  log?: (message: string) => void;
}): Promise<ContinuationWorkBatchResult> {
  let chainState = params.chainState;
  let scheduledCount = 0;
  for (const request of params.requests) {
    const result = await scheduleContinuationWork({
      sessionKey: params.sessionKey,
      chainState,
      request,
      config: params.config,
      ...(params.parentRunId !== undefined ? { parentRunId: params.parentRunId } : {}),
      ...(params.log ? { log: params.log } : {}),
    });
    if (!result.scheduled) {
      return {
        scheduledCount,
        cappedCount: params.requests.length - scheduledCount,
        capped: result.capped,
        chainState,
      };
    }
    chainState = result.chainState;
    scheduledCount += 1;
  }
  return { scheduledCount, cappedCount: 0, capped: false, chainState };
}

export async function recoverPendingContinuationWork(): Promise<{
  sessions: number;
  dispatched: number;
  failed: number;
  reaped: number;
}> {
  const runtimeConfig = resolveContinuationRuntimeConfig();
  if (!runtimeConfig.enabled) {
    return { sessions: 0, dispatched: 0, failed: 0, reaped: 0 };
  }
  const sessionKeys = listPendingWorkSessionKeysForRecovery();
  const includeRunningUpdatedAtOrBefore = Date.now() - RUNNING_WORK_RECOVERY_STALE_MS;
  let dispatched = 0;
  let failed = 0;
  let reaped = 0;
  for (const sessionKey of sessionKeys) {
    const result = await dispatchPendingContinuationWork({
      sessionKey,
      recoverRunning: true,
      includeRunningUpdatedAtOrBefore,
      includeIdleRetry: true,
    });
    dispatched += result.dispatched;
    failed += result.failed;
    reaped += result.reaped;
  }
  return { sessions: sessionKeys.length, dispatched, failed, reaped };
}
