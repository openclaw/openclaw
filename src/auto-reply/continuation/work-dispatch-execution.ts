/** Per-row execution for durable same-session continuation work. */

import { randomUUID } from "node:crypto";
import type { SubagentRunLiveness } from "../../agents/subagents/registry/subagent-run-liveness.js";
import {
  emitContinuationWorkFireSpan,
  resolveContinuationTraceparent,
} from "../../infra/continuation-tracer.js";
import { runWithDiagnosticTraceparent } from "../../infra/diagnostic-trace-context.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { enqueueSystemEventRaw as enqueueSystemEvent } from "../../infra/system-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { evaluateNoOpRearmAdmission, type NoOpRearmDecision } from "../reply/no-op-rearm-guard.js";
import type { ContinuationWorkReasonCategory, PendingContinuationWork } from "./work-flow-state.js";
import { refuseStaleContinuationWork } from "./work-recipient-authority.js";
import {
  markPendingWorkDelivered,
  markPendingWorkFailed,
  markPendingWorkFoldDelivered,
  markPendingWorkFolded,
  markPendingWorkReaped,
  markPendingWorkSuperseded,
  markPendingWorkTurnGranted,
  markPendingWorkTurnStarted,
  reconcileUndeliverableGrantedWork,
  requeuePendingWork,
} from "./work-store.js";
import { deliverPendingTerminalNoticeWithRetry } from "./work-terminal-notice.js";
import { buildFoldedProvenanceNote, formatContinuationWakeText } from "./work-wake-text.js";

const log = createSubsystemLogger("continuation/work-dispatch");
const TRANSIENT_ERROR_RETRY_MS = 5_000;
const MAX_TRANSIENT_ERROR_RETRY_COUNT = 8;
const CONTINUATION_TURN_BUSY_REASON = "requests-in-flight";
const CONTINUATION_TURN_COMMAND_QUEUE_BUSY_REASON = "command-queue-busy";
const CONTINUATION_TURN_DRAINING_REASON = "draining";
// Non-retryable: the no-op replay guard tripped. The row is
// terminal-parked (superseded) so the self-rearm loop stops; never requeued.
const CONTINUATION_TURN_NOOP_REARM_BLOCKED_REASON = "noop-rearm-blocked";
const CONTINUATION_TURN_REPLY_RUN_FAILED_REASON = "reply-run-failed";
const CONTINUATION_TURN_RESET_REASON = "session-reset";
const CONTINUATION_TURN_LIFECYCLE_CHANGED_REASON = "session-lifecycle-changed";
const CONTINUATION_TURN_STALE_CLAIM_REASON = "stale-claim";
// Terminal: the record was already failed with its refusal reason; nothing reaches the session.
const CONTINUATION_TURN_RECIPIENT_REFUSED_REASON = "recipient-refused";
const GATEWAY_RESTARTING_REPLY_TEXT =
  "⚠️ Gateway is restarting. Please wait a few seconds and try again.";

/** The session-controller reads continuation admission, election, and idle waits share. */
type ContinuationSessionRuns = {
  isActive: (sessionKey: string) => boolean;
  resolveSessionId: (sessionKey: string) => string | undefined;
  waitForIdle: (typeof import("../../sessions/session-controller.js"))["waitForSessionRunIdle"];
};

// The dynamic edge keeps the session-controller graph out of the continuation static
// graph. One promise is load-bearing: admission, election, and idle waits must observe
// the same controller modules even while the imports are still in flight.
let continuationSessionRunsPromise: Promise<ContinuationSessionRuns> | undefined;

export async function getContinuationReplyRunRegistry(): Promise<ContinuationSessionRuns> {
  continuationSessionRunsPromise ??= Promise.all([
    import("../../sessions/session-controller.queries.js"),
    import("../../sessions/session-controller.js"),
  ]).then(([queries, controller]) => ({
    isActive: queries.isSessionRunActiveForKey,
    resolveSessionId: (sessionKey) => queries.resolveActiveSessionRunId(sessionKey),
    waitForIdle: controller.waitForSessionRunIdle,
  }));
  return await continuationSessionRunsPromise;
}

export type ContinuationWorkIdleRetryTrigger =
  | { kind: "reply-run-ended" }
  | { kind: "command-lane-idle"; lane: string };

type ContinuationWorkExecutionPolicy = Readonly<{
  reasonCategory: ContinuationWorkReasonCategory;
  busyRetryDelayMs: number;
  idleRetryHedgeMs: number;
  mainCommandLane: string;
  orphanReapStaleCutoffMs?: number;
}>;

export type ContinuationWorkExecutionDirective = Readonly<
  | { kind: "dispatched" }
  | { kind: "failed" }
  | { kind: "cancelled" }
  | { kind: "reaped" }
  | {
      kind: "requeued";
      sessionKey: string;
      dueAt: number;
      retryTrigger?: ContinuationWorkIdleRetryTrigger;
    }
  | { kind: "unchanged" }
>;

type ContinuationWorkFoldExecutionResult = Readonly<{
  folded: number;
  requeues: readonly Extract<ContinuationWorkExecutionDirective, { kind: "requeued" }>[];
}>;

type ContinuationWorkFoldCandidate = Readonly<{
  work: PendingContinuationWork;
  reasonCategory: ContinuationWorkReasonCategory;
}>;

type ContinuationWorkFoldAttempt = Readonly<{
  now: number;
  retryDelayMs: number;
  /** The candidates' works the adoption boundary kept; a refused work's record already failed. */
  kept: ReadonlySet<PendingContinuationWork>;
  delivery: { delivered: true; deliveredAt: number } | { delivered: false; reason: string };
}>;

type ContinuationWorkFoldPolicy = Readonly<{
  deliveryTimeoutMs: number;
  retryDelayMs: number;
}>;

function isRetryableContinuationSkipReason(reason: string): boolean {
  return (
    reason === CONTINUATION_TURN_BUSY_REASON ||
    reason === CONTINUATION_TURN_DRAINING_REASON ||
    reason === CONTINUATION_TURN_COMMAND_QUEUE_BUSY_REASON ||
    reason === CONTINUATION_TURN_LIFECYCLE_CHANGED_REASON
  );
}

/** Emit the guard's single per-episode suppression diagnostic, when present. */
function emitNoOpRearmBlockedDiagnostic(decision: NoOpRearmDecision): void {
  if (!decision.admit && decision.diagnostic) {
    log.warn(decision.diagnostic.message);
  }
}

/** Read the latest parent liveness from the live registry; never persist it. */
async function readChildSessionRunLiveness(
  sessionKey: string,
  options: { now: number; staleCutoffMs?: number },
): Promise<SubagentRunLiveness> {
  const [{ subagentRuns }, { classifyChildSessionRunLivenessFromRuns }] = await Promise.all([
    import("../../agents/subagents/registry/subagent-registry-memory.js"),
    import("../../agents/subagents/registry/subagent-registry-queries.continuation.js"),
  ]);
  return classifyChildSessionRunLivenessFromRuns(subagentRuns, sessionKey, options);
}

type ReplyPayloadLike = { text?: unknown };

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

/**
 * One claimed wake as its execution sees it: the record at its latest committed revision (the
 * turn-start fence advances it), and whether its run reported a start. A started run is never
 * requeued (RFC §5.4.2): it records its delivery, or its fenced record is left to recovery.
 */
type ContinuationWorkClaim = { work: PendingContinuationWork; runStarted: boolean };

type ContinuationTurnGrantResult =
  | { status: "ran"; work: PendingContinuationWork }
  // Turn ran, but the durable delivered-mark lost the revision race and the row
  // was reconciled here. The caller must not finish with the stale revision.
  | { status: "ran-finalized" }
  | { status: "skipped"; reason: string; retryTrigger?: ContinuationWorkIdleRetryTrigger };

async function driveContinuationTurn(
  claim: ContinuationWorkClaim,
  wakeText: string,
  mainCommandLane: string,
  signal: AbortSignal,
): Promise<ContinuationTurnGrantResult> {
  const { work } = claim;
  const [
    { getRuntimeConfig },
    { resolveSessionStorePathCore },
    { loadSessionEntry },
    { parseAgentSessionKey, isSubagentSessionKey },
    { AGENT_LANE_SUBAGENT },
    { getReplyFromConfig },
    replyRunRegistry,
    { getQueueSize, isGatewayDraining },
  ] = await Promise.all([
    import("../../config/config.js"),
    import("../../config/sessions/paths.js"),
    import("../../config/sessions/session-accessor.js"),
    import("../../sessions/session-key-utils.js"),
    import("../../agents/lanes.js"),
    import("../reply/get-reply.js"),
    getContinuationReplyRunRegistry(),
    import("../../process/command-queue.js"),
  ]);

  // Direct continuation grants bypass heartbeat policy, but still respect
  // gateway drain, the session's active reply, and queued main-lane work.
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
  // Since #175837 runs serialize per session in its controller; a subagent's continuation
  // turn takes the subagent lane its own runs use instead of queueing behind main.
  const continuationLane = isSubagentSessionKey(work.sessionKey) ? AGENT_LANE_SUBAGENT : undefined;
  if (continuationLane === undefined && getQueueSize(mainCommandLane) > 0) {
    return {
      status: "skipped",
      reason: CONTINUATION_TURN_COMMAND_QUEUE_BUSY_REASON,
      retryTrigger: { kind: "command-lane-idle", lane: mainCommandLane },
    };
  }

  const cfg = getRuntimeConfig();
  const agentId = parseAgentSessionKey(work.sessionKey)?.agentId;
  const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
  const agentSessionEntry = loadSessionEntry({
    clone: false,
    hydrateSkillPromptRefs: false,
    readConsistency: "latest",
    sessionKey: work.sessionKey,
    storePath,
  });
  if (!agentSessionEntry) {
    return { status: "skipped", reason: "missing-session" };
  }
  const admittedSessionIdentity = {
    sessionId: agentSessionEntry.sessionId,
    lifecycleRevision: agentSessionEntry.lifecycleRevision,
  };

  const admission = evaluateNoOpRearmAdmission({
    sessionKey: work.sessionKey,
    isContinuationWake: true,
    ...(work.parentRunId ? { parentRunId: work.parentRunId } : {}),
  });
  if (!admission.admit) {
    emitNoOpRearmBlockedDiagnostic(admission);
    return { status: "skipped", reason: CONTINUATION_TURN_NOOP_REARM_BLOCKED_REASON };
  }

  if (signal.aborted) {
    return { status: "skipped", reason: CONTINUATION_TURN_RESET_REASON };
  }
  // The adoption boundary, before the final fence: never run the turn for a moved recipient.
  if ((await refuseStaleContinuationWork([work], "adoption")).length === 0) {
    return { status: "skipped", reason: CONTINUATION_TURN_RECIPIENT_REFUSED_REASON };
  }
  // The durable turn-start fence is the final admission boundary (RFC §5.4.2): it commits before
  // getReplyFromConfig, under the run id the turn runs with. The run reports its start only through
  // onPreparedAgentRunStart, a synchronous observer it never awaits that fires at its first
  // execution phase, and an inline tool command can run without firing it: no later point precedes
  // every effect.
  const turnRunId = randomUUID();
  const turnFence = await markPendingWorkTurnStarted(work, turnRunId);
  // The fence write yielded; a reset or lifecycle rotation in that window aborted this claim.
  // Accepted edge (see session-reset.ts): its committed fence makes recovery interrupt a turn that
  // never ran.
  if (signal.aborted) {
    return { status: "skipped", reason: CONTINUATION_TURN_RESET_REASON };
  }
  if (!turnFence.allowed) {
    return {
      status: "skipped",
      reason:
        turnFence.reason === "cancelled"
          ? CONTINUATION_TURN_RESET_REASON
          : CONTINUATION_TURN_STALE_CLAIM_REASON,
    };
  }
  claim.work = turnFence.work;
  const currentSessionEntry = loadSessionEntry({
    clone: false,
    hydrateSkillPromptRefs: false,
    readConsistency: "latest",
    sessionKey: work.sessionKey,
    storePath,
  });
  if (
    currentSessionEntry?.sessionId !== admittedSessionIdentity.sessionId ||
    currentSessionEntry?.lifecycleRevision !== admittedSessionIdentity.lifecycleRevision
  ) {
    return { status: "skipped", reason: CONTINUATION_TURN_LIFECYCLE_CHANGED_REASON };
  }
  let replyRunId: string | undefined;
  let replyRunTerminalOutcome: "completed" | "failed" | undefined;
  let reply: Awaited<ReturnType<typeof getReplyFromConfig>>;
  try {
    reply = await runWithDiagnosticTraceparent(work.traceparent, () =>
      getReplyFromConfig(
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
          runId: turnRunId,
          continuationTrigger: "work-wake",
          abortSignal: signal,
          parentRunId: work.parentRunId,
          lane: continuationLane,
          typingPolicy: "system_event",
          suppressTyping: true,
          onPreparedAgentRunStart: ({ runId }) => {
            replyRunId = runId;
            claim.runStarted = true;
            replyRunTerminalOutcome = undefined;
          },
          onAgentRunTerminalOutcome: (outcome) => {
            replyRunTerminalOutcome = outcome;
          },
        },
        cfg,
      ),
    );
  } catch (error) {
    // A started run may already have spawned children or committed tools. Never
    // replay that hop merely because its reply path threw after admission.
    if (!replyRunId || signal.aborted) {
      throw error;
    }
    log.warn(
      `[continuation:work-reply-run-failed] flowId=${work.flowId ?? "none"} session=${work.sessionKey} runId=${replyRunId} terminal=${replyRunTerminalOutcome ?? "none"}`,
    );
    return { status: "skipped", reason: CONTINUATION_TURN_REPLY_RUN_FAILED_REASON };
  }
  if (replyRunId && replyRunTerminalOutcome !== "completed") {
    return { status: "skipped", reason: CONTINUATION_TURN_REPLY_RUN_FAILED_REASON };
  }
  if (!hasNonDrainReplyPayload(reply)) {
    // Only a turn that never started may be requeued; a completed run is a granted wake.
    if (!replyRunId && isGatewayDraining()) {
      return { status: "skipped", reason: CONTINUATION_TURN_DRAINING_REASON };
    }
    log.info(
      `[continuation:work-empty-reply] flowId=${work.flowId ?? "none"} session=${work.sessionKey} runId=${replyRunId ?? "none"} terminal=${replyRunTerminalOutcome ?? "none"}`,
    );
    // Silent continuation and message-tool-only turns may legitimately return no
    // payload. Only a completed reply run proves that such a wake was granted.
    if (!replyRunId) {
      throw new Error("Continuation reply returned without a completed reply run");
    }
  }
  // The provider ran. Persist the replay guard before finishing, then advance
  // only with the committed revision-bearing value returned by the CAS.
  const deliveredMark = await markPendingWorkDelivered(claim.work);
  if (!deliveredMark.applied) {
    await reconcileUndeliverableGrantedWork(claim.work);
    return { status: "ran-finalized" };
  }
  return { status: "ran", work: deliveredMark.work };
}

async function deliverFoldedProvenanceNoteToActiveTurn(params: {
  sessionKey: string;
  note: string;
  deliveryTimeoutMs: number;
}): Promise<{ delivered: true; deliveredAt: number } | { delivered: false; reason: string }> {
  const replyRunRegistry = await getContinuationReplyRunRegistry();
  const sessionId = replyRunRegistry.resolveSessionId(params.sessionKey);
  if (!sessionId) {
    return { delivered: false, reason: "missing-active-session-id" };
  }
  const [{ isEmbeddedAgentRunHandleActive }, { resolveActiveReplyOperationForSessionId }, steer] =
    await Promise.all([
      import("../../agents/embedded-agent-runner/runs.js"),
      import("../../sessions/session-controller.queries.js"),
      import("../../sessions/session-controller.steer.js"),
    ]);
  if (!isEmbeddedAgentRunHandleActive(sessionId)) {
    return { delivered: false, reason: "active-embedded-run-required-for-transcript-proof" };
  }
  const outcome = await steer.steerSessionControllerOperation({
    operation: resolveActiveReplyOperationForSessionId(sessionId),
    text: params.note,
    options: {
      steeringMode: "all",
      debounceMs: 0,
      deliveryTimeoutMs: params.deliveryTimeoutMs,
      waitForTranscriptCommit: true,
    },
  });
  if (outcome.status === "accepted") {
    // With waitForTranscriptCommit, acceptance without a result means the transcript committed.
    return outcome.result
      ? {
          delivered: false,
          reason: `queued-without-transcript-commit:${outcome.result.errorMessage}`,
        }
      : { delivered: true, deliveredAt: Date.now() };
  }
  if (outcome.status === "indeterminate") {
    return { delivered: false, reason: `indeterminate:${outcome.errorMessage}` };
  }
  return { delivered: false, reason: outcome.reason };
}

export async function prepareFoldedContinuationWork(
  sessionKey: string,
  candidates: readonly ContinuationWorkFoldCandidate[],
  policy: ContinuationWorkFoldPolicy,
): Promise<ContinuationWorkFoldAttempt> {
  // The adoption boundary: the active turn adopts the note, so a moved recipient never gets it. An
  // unreadable authority delivers nothing; the commit requeues the candidates for a retry.
  const candidateWorks = candidates.map((candidate) => candidate.work);
  let works: PendingContinuationWork[];
  try {
    works = await refuseStaleContinuationWork(candidateWorks, "adoption");
  } catch (err) {
    const delivery = { delivered: false, reason: formatErrorMessage(err) } as const;
    const kept = new Set(candidateWorks);
    return { now: Date.now(), retryDelayMs: policy.retryDelayMs, kept, delivery };
  }
  const kept = new Set(works);
  const now = Date.now();
  if (works.length === 0) {
    const delivery = {
      delivered: false,
      reason: CONTINUATION_TURN_RECIPIENT_REFUSED_REASON,
    } as const;
    return { now, retryDelayMs: policy.retryDelayMs, kept, delivery };
  }
  const note = buildFoldedProvenanceNote(works, now);
  let delivery: Awaited<ReturnType<typeof deliverFoldedProvenanceNoteToActiveTurn>>;
  try {
    delivery = await deliverFoldedProvenanceNoteToActiveTurn({
      sessionKey,
      note,
      deliveryTimeoutMs: policy.deliveryTimeoutMs,
    });
  } catch (err) {
    delivery = { delivered: false, reason: formatErrorMessage(err) };
  }
  return { now, retryDelayMs: policy.retryDelayMs, kept, delivery };
}

export async function commitFoldedContinuationWork(
  sessionKey: string,
  candidates: readonly ContinuationWorkFoldCandidate[],
  attempt: ContinuationWorkFoldAttempt,
): Promise<ContinuationWorkFoldExecutionResult> {
  const adopted = candidates.filter((candidate) => attempt.kept.has(candidate.work));
  const works = adopted.map((candidate) => candidate.work);
  const { delivery, now } = attempt;
  if (works.length === 0) {
    return { folded: 0, requeues: [] };
  }
  if (!delivery.delivered) {
    const retryDueAt = now + attempt.retryDelayMs;
    const retryAfterActiveRun =
      delivery.reason === "active-embedded-run-required-for-transcript-proof" ||
      delivery.reason.startsWith("queued-without-transcript-commit:");
    const requeues: Extract<ContinuationWorkExecutionDirective, { kind: "requeued" }>[] = [];
    for (const candidate of adopted) {
      const { work } = candidate;
      const retryTrigger = retryAfterActiveRun ? ({ kind: "reply-run-ended" } as const) : undefined;
      const requeued = await requeuePendingWork(work, {
        dueAt: retryDueAt,
        summary: `Continuation fold-note delivery failed (${delivery.reason}); keeping row recoverable.`,
        ...(retryAfterActiveRun
          ? {
              idleRetry: {
                trigger: "reply-run-ended",
                reasonCategory: candidate.reasonCategory,
                armedAt: now,
              },
            }
          : {}),
      });
      if (requeued) {
        requeues.push({
          kind: "requeued",
          sessionKey: work.sessionKey,
          dueAt: retryDueAt,
          ...(retryTrigger ? { retryTrigger } : {}),
        });
      }
    }
    log.warn(
      `[continuation:work-fold-note-undelivered] session=${sessionKey} count=${works.length} reason=${delivery.reason} rows kept recoverable, not terminalized`,
    );
    return { folded: 0, requeues };
  }
  let folded = 0;
  for (const work of works) {
    const overdueByMs = Math.max(0, now - work.dueAt);
    log.info(
      `[continuation:work-folded-active] flowId=${work.flowId ?? "none"} session=${sessionKey} hop=${work.hop} overdueMs=${overdueByMs} folded into active turn`,
    );
    const deliveredMark = await markPendingWorkFoldDelivered(work, {
      foldedAt: delivery.deliveredAt,
      overdueByMs,
    });
    if (!deliveredMark.applied) {
      continue;
    }
    await markPendingWorkFolded(deliveredMark.work, {
      summary: "matured while a later turn was active",
      foldedAt: delivery.deliveredAt,
      overdueByMs,
    });
    folded++;
  }
  return { folded, requeues: [] };
}

export async function executePendingContinuationWork(
  work: PendingContinuationWork,
  policy: ContinuationWorkExecutionPolicy,
  signal: AbortSignal,
): Promise<ContinuationWorkExecutionDirective> {
  // Store writes after the drive use the claim: the turn-start fence advanced its revision.
  const claim: ContinuationWorkClaim = { work, runStarted: false };
  try {
    const fireDeferredMs = Date.now() - work.electedAt;
    const fireChainId = work.chainId ?? work.flowId ?? work.sessionKey;
    const outboundTraceparent = resolveContinuationTraceparent(work.traceparent);
    emitContinuationWorkFireSpan({
      chainId: fireChainId,
      chainStepRemainingAtDispatch: Math.max(0, work.maxChainLength - work.hop),
      delayMs: work.delayMs,
      fireDeferredMs,
      reason: work.reason,
      traceparent: outboundTraceparent,
      log: (message) => log.info(message),
    });
    log.info(
      `[continuation:work-wake] hop=${work.hop}/${work.maxChainLength} session=${work.sessionKey} reasonCategory=${policy.reasonCategory}`,
    );
    const result = await driveContinuationTurn(
      claim,
      formatContinuationWakeText(work),
      policy.mainCommandLane,
      signal,
    );
    if (result.status === "ran") {
      await markPendingWorkTurnGranted(result.work);
      return { kind: "dispatched" };
    }
    if (result.status === "ran-finalized") {
      return { kind: "dispatched" };
    }

    const skippedReason = result.reason;
    log.warn(
      `[continuation:work-drive-skipped] flowId=${work.flowId ?? "none"} session=${work.sessionKey} reason=${skippedReason} reasonCategory=${policy.reasonCategory}`,
    );
    if (skippedReason === CONTINUATION_TURN_RESET_REASON) {
      log.info(
        `[continuation:work-drive-cancelled] flowId=${work.flowId ?? "none"} session=${work.sessionKey} reason=${skippedReason}`,
      );
      return { kind: "cancelled" };
    }
    if (skippedReason === CONTINUATION_TURN_STALE_CLAIM_REASON) {
      return { kind: "unchanged" };
    }
    if (skippedReason === CONTINUATION_TURN_RECIPIENT_REFUSED_REASON) {
      return { kind: "failed" };
    }
    if (skippedReason === CONTINUATION_TURN_NOOP_REARM_BLOCKED_REASON) {
      await markPendingWorkSuperseded(
        claim.work,
        `No-op replay guard suppressed continuation turn (${skippedReason}).`,
      );
      return { kind: "failed" };
    }
    if (isRetryableContinuationSkipReason(skippedReason)) {
      const now = Date.now();
      const parentLiveness: SubagentRunLiveness =
        work.parentRunId == null
          ? "uncertain"
          : await readChildSessionRunLiveness(work.sessionKey, {
              now,
              ...(policy.orphanReapStaleCutoffMs !== undefined
                ? { staleCutoffMs: policy.orphanReapStaleCutoffMs }
                : {}),
            });
      if (work.parentRunId != null && parentLiveness === "confident-terminal") {
        log.info(
          `[continuation:work-orphan-reaped] flowId=${work.flowId ?? "none"} session=${work.sessionKey} parentRunId=${work.parentRunId} — parent confident-terminal, can never rehydrate`,
        );
        await markPendingWorkReaped(
          claim.work,
          `Orphan continuation reaped: parent run ${work.parentRunId} is confident-terminal and can never rehydrate this flow.`,
        );
        return { kind: "reaped" };
      }
      const priorBusySkips = work.busySkipCount ?? 0;
      const retryDueAt =
        now + (result.retryTrigger ? policy.idleRetryHedgeMs : policy.busyRetryDelayMs);
      const requeued = await requeuePendingWork(claim.work, {
        dueAt: retryDueAt,
        summary: `Retryable continuation skip: ${skippedReason}`,
        busySkipCount: priorBusySkips + 1,
        ...(result.retryTrigger
          ? {
              idleRetry: {
                trigger: result.retryTrigger.kind,
                reasonCategory: policy.reasonCategory,
                armedAt: now,
              },
            }
          : {}),
      });
      return requeued
        ? {
            kind: "requeued",
            sessionKey: work.sessionKey,
            dueAt: retryDueAt,
            ...(result.retryTrigger ? { retryTrigger: result.retryTrigger } : {}),
          }
        : { kind: "unchanged" };
    }

    enqueueSystemEvent(
      `[system:continuation-warning] continue_work turn was not granted (${skippedReason}).`,
      { sessionKey: work.sessionKey, trusted: true },
    );
    await markPendingWorkFailed(claim.work, `Continuation turn was not granted: ${skippedReason}`);
    return { kind: "failed" };
  } catch (err) {
    if (signal.aborted) {
      log.info(
        `[continuation:work-drive-cancelled] flowId=${work.flowId ?? "none"} session=${work.sessionKey} reason=${CONTINUATION_TURN_RESET_REASON}`,
      );
      return { kind: "cancelled" };
    }
    const message = formatErrorMessage(err);
    if (claim.runStarted) {
      // The run started, so its delivery is unconfirmed: never requeue it. The fenced record stays
      // running for recovery, which interrupts it with one notice (RFC §5.4.2).
      log.warn(
        `[continuation:work-drive-error-after-start] flowId=${work.flowId ?? "none"} session=${work.sessionKey} error=${message} left to recovery`,
      );
      return { kind: "unchanged" };
    }
    const retryCount = (work.retryCount ?? 0) + 1;
    if (retryCount <= MAX_TRANSIENT_ERROR_RETRY_COUNT) {
      const retryDueAt = Date.now() + TRANSIENT_ERROR_RETRY_MS;
      log.warn(
        `[continuation:work-drive-error-retry] flowId=${work.flowId ?? "none"} session=${work.sessionKey} retry=${retryCount}/${MAX_TRANSIENT_ERROR_RETRY_COUNT} error=${message}`,
      );
      const requeued = await requeuePendingWork(claim.work, {
        dueAt: retryDueAt,
        summary: `Transient continuation turn error: ${message}`,
        retryCount,
      });
      return requeued
        ? { kind: "requeued", sessionKey: work.sessionKey, dueAt: retryDueAt }
        : { kind: "unchanged" };
    }
    // Retries are exhausted: this wake will never run. The notice obligation is
    // persisted in the SAME CAS that fails the row, so a crash before the agent
    // is told leaves the obligation readable in the store rather than lost with
    // the in-memory event queue. The CAS result stays the dedupe authority: a
    // re-entrant or recovered caller holding a stale claim loses it and reports
    // nothing.
    const terminalized = await markPendingWorkFailed(claim.work, message, {
      terminalNoticePending: "retry-exhausted",
    });
    if (terminalized) {
      log.error(
        `[continuation:work-drive-error-exhausted] flowId=${work.flowId ?? "none"} session=${work.sessionKey} hop=${work.hop} attempts=${retryCount} maxRetries=${MAX_TRANSIENT_ERROR_RETRY_COUNT} error=${message}`,
      );
      // Hand the persisted obligation to the durable delivery queue. A failure
      // arms a bounded live retry and leaves the flag set, so the outcome never
      // depends on unrelated traffic or another restart.
      await deliverPendingTerminalNoticeWithRetry(claim.work);
    }
    return { kind: "failed" };
  }
}
