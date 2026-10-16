import { isDeepStrictEqual } from "node:util";
import { normalizeOptionalString as normalizeLifecycleRunId } from "@openclaw/normalization-core/string-coerce";
import { isAgentLifecycleYieldedWaiting } from "../../agents/agent-lifecycle-parent-state.js";
import {
  buildAgentRunTerminalOutcomeFromLifecycleEvent,
  classifyAgentRunTerminalOutcome,
  type AgentRunTerminalOutcome,
} from "../../agents/agent-run-terminal-outcome.js";
import { projectMainSessionRecoveryLifecycle } from "../../agents/main-session-recovery/main-session-recovery-lifecycle.js";
import type { ProviderReviewTerminalFact } from "../../sessions/provider-review-terminal.js";
import { buildUpdatedSessionGoalStatus } from "./goals-transitions.js";
import { isMainRestartRecoveryCandidate, recordLifecycleFence } from "./restart-recovery-state.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

export type SessionLifecycleProviderReview = Pick<
  ProviderReviewTerminalFact,
  "target" | "expectedWriterRunId" | "review"
>;

export type SessionLifecyclePatchInput = {
  event: LifecycleEventLike;
  currentLifecycleGeneration: string;
  lastRunError?: string;
  canonicalKey: string;
  lifecycleRevision?: string;
  exactCronRun: boolean;
  providerReview?: SessionLifecycleProviderReview;
  expectedWriter?: {
    requireYielded?: true;
    runId: string;
    sessionId: string;
    lifecycleRevision?: string;
  };
};

export type SessionLifecyclePatchEffects = {
  terminalRecovery?: { runId: string; outcome: AgentRunTerminalOutcome };
  failedRun?: {
    runId: string;
    error: unknown;
    errorKind?: "state_contention";
    suppressErrorNotice?: boolean;
  };
};

export type LifecyclePhase = "start" | "end" | "error";

export type LifecycleEventLike = { ts: number; sessionId?: string } & {
  controlUiVisible?: boolean;
  isHeartbeat?: boolean;
  contextClaimId?: string;
  runId?: string;
  clientRunId?: string;
  lifecycleGeneration?: string;
  mainSessionRestartRecovery?: true;
  data?: {
    phase?: unknown;
    startedAt?: unknown;
    endedAt?: unknown;
    aborted?: unknown;
    stopReason?: unknown;
    error?: unknown;
    errorKind?: unknown;
    suppressErrorNotice?: unknown;
    executionStarted?: unknown;
    livenessState?: unknown;
    timeoutPhase?: unknown;
    providerStarted?: unknown;
    yielded?: unknown;
    status?: unknown;
  };
};

type LifecycleSessionShape = Pick<
  SessionEntry,
  | "updatedAt"
  | "lastRunError"
  | "suppressErrorNotice"
  | "lastRunId"
  | "startedAt"
  | "endedAt"
  | "runtimeMs"
  | "lastActivityAt"
  | "abortedLastRun"
>;

type PersistedLifecycleSessionShape = Pick<
  SessionEntry,
  | keyof LifecycleSessionShape
  | "status"
  | "restartRecoveryRuns"
  | "restartRecoveryForceSafeTools"
  | "mainRestartRecovery"
  | "lifecycleRunId"
>;

type GatewaySessionLifecycleSnapshot = Partial<
  Pick<SessionEntry, keyof LifecycleSessionShape | "status">
>;

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function resolveLifecyclePhase(
  event: Pick<LifecycleEventLike, "data">,
): LifecyclePhase | null {
  const phase = event.data?.phase;
  return phase === "start" || phase === "end" || phase === "error" ? phase : null;
}

const SESSION_STATUS_BY_TERMINAL_CLASSIFICATION = {
  success: "done",
  timeout: "timeout",
  cancellation: "killed",
  failure: "failed",
} as const satisfies Record<
  ReturnType<typeof classifyAgentRunTerminalOutcome>,
  NonNullable<SessionEntry["status"]>
>;

function resolveTerminalOutcome(event: LifecycleEventLike): AgentRunTerminalOutcome {
  return buildAgentRunTerminalOutcomeFromLifecycleEvent({
    phase: event.data?.phase === "error" ? "error" : "end",
    data: event.data,
    endedAt: event.data?.endedAt ?? event.ts,
  });
}

function resolveSettledLifecycleTerminalOutcome(
  event: LifecycleEventLike,
): AgentRunTerminalOutcome | undefined {
  const phase = resolveLifecyclePhase(event);
  if (phase !== "end" && phase !== "error") {
    return undefined;
  }
  const outcome = resolveTerminalOutcome(event);
  return isAgentLifecycleYieldedWaiting({
    ...event.data,
    phase,
    stopReason: outcome.stopReason,
  })
    ? undefined
    : outcome;
}

function resolveLifecycleTimestamp(...values: unknown[]): number | undefined {
  return values.find(isFiniteTimestamp);
}

function resolveRuntimeMs(params: {
  startedAt?: number;
  endedAt?: number;
  existingRuntimeMs?: number;
}): number | undefined {
  const { startedAt, endedAt, existingRuntimeMs } = params;
  if (isFiniteTimestamp(startedAt) && isFiniteTimestamp(endedAt)) {
    return Math.max(0, endedAt - startedAt);
  }
  if (
    typeof existingRuntimeMs === "number" &&
    Number.isFinite(existingRuntimeMs) &&
    existingRuntimeMs >= 0
  ) {
    return existingRuntimeMs;
  }
  return undefined;
}

export function resolveSessionLifecycleTerminal(event: LifecycleEventLike) {
  // Cancellation must preserve recovery even when the bulk shutdown marker failed.
  // Use the normalized outcome so a prior hard timeout still owns the terminal state.
  const terminal = resolveSettledLifecycleTerminalOutcome(event);
  const interruptedForRestart =
    terminal?.reason === "cancelled" && terminal.stopReason === "restart";
  const status: SessionEntry["status"] = interruptedForRestart
    ? "interrupted"
    : terminal
      ? SESSION_STATUS_BY_TERMINAL_CLASSIFICATION[classifyAgentRunTerminalOutcome(terminal)]
      : undefined;
  return { terminal, status, interruptedForRestart };
}

export function deriveSessionLifecycleSnapshot(params: {
  session?: Partial<Pick<SessionEntry, keyof LifecycleSessionShape>> | null;
  event: LifecycleEventLike;
  lastRunError?: string;
}): GatewaySessionLifecycleSnapshot {
  const phase = resolveLifecyclePhase(params.event);
  if (!phase) {
    return {};
  }

  const existing = params.session ?? undefined;
  const startedAt = resolveLifecycleTimestamp(
    params.event.data?.startedAt,
    existing?.startedAt,
    params.event.ts,
  );
  if (phase === "start") {
    // A start event clears terminal fields from the previous run so UI rows do
    // not show stale runtime/end state while the new run is active.
    const updatedAt = startedAt ?? existing?.updatedAt;
    return {
      updatedAt,
      status: undefined,
      lastRunError: undefined,
      suppressErrorNotice: false,
      startedAt,
      endedAt: undefined,
      runtimeMs: undefined,
      abortedLastRun: false,
    };
  }

  const endedAt = resolveLifecycleTimestamp(params.event.data?.endedAt, params.event.ts);
  const updatedAt = endedAt ?? existing?.updatedAt;
  const { terminal, status, interruptedForRestart } = resolveSessionLifecycleTerminal(params.event);
  return {
    updatedAt,
    status,
    suppressErrorNotice: params.event.data?.suppressErrorNotice === true,
    lastRunError: interruptedForRestart
      ? "Run interrupted by a Gateway restart."
      : terminal && status
        ? params.lastRunError
        : undefined,
    startedAt,
    endedAt,
    runtimeMs: resolveRuntimeMs({ startedAt, endedAt, existingRuntimeMs: existing?.runtimeMs }),
    ...(terminal &&
    !interruptedForRestart &&
    params.event.controlUiVisible === true &&
    params.event.isHeartbeat !== true &&
    endedAt !== undefined
      ? { lastActivityAt: Math.max(existing?.lastActivityAt ?? 0, endedAt) }
      : {}),
    abortedLastRun: interruptedForRestart || status === "killed",
  };
}

export function derivePersistedSessionLifecyclePatch(params: {
  entry?: Partial<Omit<PersistedLifecycleSessionShape, "status">> | null;
  event: LifecycleEventLike;
  currentLifecycleGeneration: string;
  lastRunError?: string;
}): Partial<PersistedLifecycleSessionShape> {
  const phase = resolveLifecyclePhase(params.event);
  // Queued request settlement cannot end the turn that owns this session.
  if ((phase === "end" || phase === "error") && params.event.data?.executionStarted === false) {
    return {};
  }
  const snapshot = deriveSessionLifecycleSnapshot({
    session: params.entry,
    event: params.event,
    lastRunError: params.lastRunError,
  });
  const runId = normalizeLifecycleRunId(params.event.runId);
  const snapshotPatch: Partial<PersistedLifecycleSessionShape> = {
    ...snapshot,
    ...(snapshot.status === "interrupted" ? { restartRecoveryForceSafeTools: true } : {}),
  };
  const projection = projectMainSessionRecoveryLifecycle({
    currentLifecycleGeneration: params.currentLifecycleGeneration,
    entry: params.entry,
    event: params.event,
    snapshotPatch,
  });
  if (projection.action === "suppress") {
    return {};
  }
  const clientRunId = normalizeLifecycleRunId(params.event.clientRunId) ?? runId;
  // Execution ownership survives yielded outcomes until the continuation settles.
  return {
    ...projection.patch,
    ...(phase === "start"
      ? { lifecycleRunId: runId, lastRunId: undefined }
      : projection.patch.status && resolveSettledLifecycleTerminalOutcome(params.event)
        ? { lifecycleRunId: undefined, lastRunId: clientRunId }
        : {}),
  };
}

/**
 * Reject pre-reset runs and explicitly older runs sharing one session so late
 * lifecycle events cannot overwrite a newer run's authoritative state.
 */
export function isStaleLifecycleEventForSession(params: {
  owningSessionId?: string;
  currentSessionId?: string;
  eventRunId?: unknown;
  currentRunId?: unknown;
  eventStartedAt?: unknown;
  currentStartedAt?: number;
}): boolean {
  if (
    params.owningSessionId &&
    params.currentSessionId &&
    params.owningSessionId !== params.currentSessionId
  ) {
    return true;
  }
  const eventRunId = normalizeLifecycleRunId(params.eventRunId);
  const currentRunId = normalizeLifecycleRunId(params.currentRunId);
  // Matching ownership is stronger than producer timestamps. Missing or
  // different identities retain the legacy timestamp fence.
  if (eventRunId && currentRunId && eventRunId === currentRunId) {
    return false;
  }
  return (
    isFiniteTimestamp(params.eventStartedAt) &&
    isFiniteTimestamp(params.currentStartedAt) &&
    params.eventStartedAt < params.currentStartedAt
  );
}

function acceptsCronRunContinuationLifecycleEvent(params: {
  entry: SessionEntry;
  event: LifecycleEventLike;
}): boolean {
  const marker = params.entry.cronRunContinuation;
  if (marker?.phase === "running") {
    return true;
  }
  const runId = params.event.runId?.trim();
  return Boolean(marker?.phase === "continuing" && runId && marker.ownerRunId === runId);
}

export function matchesProviderReviewWriter(
  entry: SessionEntry,
  fact: SessionLifecycleProviderReview,
): boolean {
  return (
    entry.sessionId === fact.target.sessionId &&
    entry.lifecycleRevision === fact.target.lifecycleRevision &&
    (entry.activeWriterRunId === fact.expectedWriterRunId ||
      entry.lifecycleRunId === fact.expectedWriterRunId) &&
    (entry.activeWriterRunId === undefined ||
      entry.activeWriterRunId === fact.expectedWriterRunId) &&
    (entry.lifecycleRunId === undefined || entry.lifecycleRunId === fact.expectedWriterRunId) &&
    (!entry.providerReview || isDeepStrictEqual(entry.providerReview, fact.review))
  );
}

export function projectSessionLifecyclePatch(
  entry: SessionEntry,
  params: SessionLifecyclePatchInput,
): { patch: Partial<SessionEntry> | null; effects?: SessionLifecyclePatchEffects } {
  const phase = resolveLifecyclePhase(params.event);
  if (!phase) {
    return { patch: null };
  }
  const { providerReview, lifecycleRevision, exactCronRun } = params;
  const owningSessionId = params.event.sessionId || undefined;
  const effects: SessionLifecyclePatchEffects = {};
  if (providerReview && !matchesProviderReviewWriter(entry, providerReview)) {
    return { patch: null };
  }
  const expected = params.expectedWriter;
  if (
    expected &&
    (entry.sessionId !== expected.sessionId ||
      entry.lifecycleRevision !== expected.lifecycleRevision ||
      (entry.activeWriterRunId !== expected.runId && entry.lifecycleRunId !== expected.runId) ||
      (entry.activeWriterRunId !== undefined && entry.activeWriterRunId !== expected.runId) ||
      (entry.lifecycleRunId !== undefined && entry.lifecycleRunId !== expected.runId))
  ) {
    return { patch: null };
  }
  if (
    expected?.requireYielded &&
    (entry.status !== undefined ||
      !Number.isFinite(entry.endedAt) ||
      entry.pendingFinalDelivery !== undefined)
  ) {
    return { patch: null };
  }
  if (exactCronRun && !acceptsCronRunContinuationLifecycleEvent({ entry, event: params.event })) {
    // Exact cron rows transfer lifecycle ownership from the initial run to
    // one claimed continuation. Ready or replaced claims reject late events.
    return { patch: null };
  }
  if (
    (phase !== "start" && entry.lifecycleRevision !== lifecycleRevision) ||
    isStaleLifecycleEventForSession({
      owningSessionId,
      currentSessionId: entry.sessionId,
      eventRunId: params.event.runId,
      currentRunId: entry.lifecycleRunId,
      eventStartedAt: params.event.data?.startedAt,
      currentStartedAt: entry.startedAt,
    })
  ) {
    return { patch: null };
  }
  const eventRunId = normalizeLifecycleRunId(params.event.runId);
  const eventClientRunId = normalizeLifecycleRunId(params.event.clientRunId);
  const terminalRunId = normalizeLifecycleRunId(entry.lastRunId);
  if (
    phase === "start" &&
    terminalRunId !== undefined &&
    (eventRunId === terminalRunId || eventClientRunId === terminalRunId)
  ) {
    // A delayed start from a terminalized run must not reopen the row after
    // its end write commits; lifecycle events are delivered in order, but
    // their async persistence can settle out of order.
    return { patch: null };
  }
  const patch: Partial<PersistedLifecycleSessionShape> &
    Pick<SessionEntry, "providerReview" | "goal"> = derivePersistedSessionLifecyclePatch({
    entry,
    event: params.event,
    currentLifecycleGeneration: params.currentLifecycleGeneration,
    lastRunError: params.lastRunError,
  });
  if (
    eventRunId &&
    isMainRestartRecoveryCandidate(entry, params.canonicalKey) &&
    (patch.status === "interrupted" || (phase === "start" && patch.lifecycleRunId === eventRunId))
  ) {
    // Source-less starts and restart aborts arm custody in their existing write.
    patch.restartRecoveryRuns = entry.restartRecoveryRuns;
    recordLifecycleFence(patch, {
      runId: eventRunId,
      lifecycleGeneration: params.event.lifecycleGeneration ?? params.currentLifecycleGeneration,
    });
  }
  if (providerReview && Object.keys(patch).length > 0) {
    patch.providerReview = providerReview.review;
  }
  const endedAt = patch.endedAt ?? params.event.ts;
  if (
    (patch.status === "failed" || patch.status === "timeout") &&
    entry.goal?.status === "active" &&
    entry.goal.updatedAt <= endedAt
  ) {
    // The terminal owner has exhausted retries. Commit the pause with the run
    // failure so every client sees the same stopped goal and frozen timer.
    // A delayed failure must not undo a newer resume or replacement goal.
    patch.goal = buildUpdatedSessionGoalStatus(
      entry,
      {
        status: "paused",
        note: `Paused after an error. Resume to continue. ${patch.lastRunError ?? (patch.status === "timeout" ? "Run timed out." : "Run failed.")}`,
      },
      endedAt,
    );
  }
  if (
    (phase === "error" || phase === "end") &&
    eventRunId &&
    (patch.status === "failed" || patch.status === "timeout")
  ) {
    effects.failedRun = {
      runId: eventRunId,
      suppressErrorNotice: params.event.data?.suppressErrorNotice === true,
      errorKind:
        params.event.data?.errorKind === "state_contention" ? "state_contention" : undefined,
      error:
        resolveTerminalOutcome(params.event).error ??
        (patch.status === "timeout" ? "Run timed out" : undefined),
    };
  }
  const recoveryTerminalIsCurrent =
    params.event.mainSessionRestartRecovery === true &&
    params.event.lifecycleGeneration === params.currentLifecycleGeneration &&
    eventRunId !== undefined &&
    (phase === "end" || phase === "error");
  const terminalOutcome = recoveryTerminalIsCurrent
    ? resolveSettledLifecycleTerminalOutcome(params.event)
    : undefined;
  if (terminalOutcome && eventRunId && Object.keys(patch).length > 0) {
    effects.terminalRecovery = {
      runId: eventRunId,
      outcome: terminalOutcome,
    };
  }
  return {
    patch: Object.keys(patch).length > 0 ? patch : null,
    effects: effects.failedRun || effects.terminalRecovery ? effects : undefined,
  };
}
