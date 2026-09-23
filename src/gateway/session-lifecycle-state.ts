import { isDeepStrictEqual } from "node:util";
import { normalizeOptionalString as normalizeLifecycleRunId } from "@openclaw/normalization-core/string-coerce";
import type { SessionRunStatus } from "../../packages/gateway-protocol/src/schema/sessions-row.js";
import { isAgentLifecycleYieldedWaiting } from "../agents/agent-lifecycle-parent-state.js";
import {
  buildAgentRunTerminalOutcomeFromLifecycleEvent,
  classifyAgentRunTerminalOutcome,
  type AgentRunTerminalOutcome,
} from "../agents/agent-run-terminal-outcome.js";
import {
  isMainSessionRecoveryLifecycleEvent,
  projectMainSessionRecoveryLifecycle,
} from "../agents/main-session-recovery/main-session-recovery-lifecycle.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";
import { buildUpdatedSessionGoalStatus } from "../config/sessions/goals-transitions.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import { getAgentEventLifecycleGeneration, type AgentEventPayload } from "../infra/agent-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  readAgentRunProviderReview,
  type ProviderReviewTerminalFact,
} from "../sessions/provider-review-terminal.js";
import { parseCronRunScopeSuffix } from "../sessions/session-key-utils.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import {
  recordGatewaySessionRunFailure,
  resolveSessionRunError,
} from "../sessions/session-run-error.js";
import { isIncognitoSessionKey } from "../shared/incognito-session-key.js";
import { loadSessionEntry } from "./session-utils.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

const restartRecoveryLog = createSubsystemLogger("main-session-restart-recovery");

type LifecyclePhase = "start" | "end" | "error";

type LifecycleEventLike = Pick<AgentEventPayload, "ts" | "sessionId"> & {
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
    livenessState?: unknown;
    timeoutPhase?: unknown;
    providerStarted?: unknown;
    yielded?: unknown;
    status?: unknown;
  };
};

type LifecycleSessionShape = Pick<
  GatewaySessionRow,
  | "updatedAt"
  | "status"
  | "lastRunError"
  | "lastRunId"
  | "startedAt"
  | "endedAt"
  | "runtimeMs"
  | "lastActivityAt"
  | "abortedLastRun"
>;

type PersistedLifecycleSessionShape = Pick<
  SessionEntry,
  | "updatedAt"
  | "status"
  | "lastRunError"
  | "lastRunId"
  | "startedAt"
  | "endedAt"
  | "runtimeMs"
  | "lastActivityAt"
  | "abortedLastRun"
  | "restartRecoveryRuns"
  | "restartRecoveryForceSafeTools"
  | "mainRestartRecovery"
  | "lifecycleRunId"
>;

type GatewaySessionLifecycleSnapshot = Partial<
  Omit<Pick<SessionEntry, keyof LifecycleSessionShape>, "status"> & { status: SessionRunStatus }
>;

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function resolveLifecyclePhase(event: Pick<LifecycleEventLike, "data">): LifecyclePhase | null {
  const phase = event.data?.phase;
  return phase === "start" || phase === "end" || phase === "error" ? phase : null;
}

const SESSION_STATUS_BY_TERMINAL_CLASSIFICATION = {
  success: "done",
  timeout: "timeout",
  cancellation: "killed",
  failure: "failed",
} as const satisfies Record<ReturnType<typeof classifyAgentRunTerminalOutcome>, SessionRunStatus>;

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
    phase,
    yielded: event.data?.yielded,
    livenessState: event.data?.livenessState,
    stopReason: outcome.stopReason,
    aborted: event.data?.aborted,
    status: event.data?.status,
    timeoutPhase: event.data?.timeoutPhase,
    error: event.data?.error,
  })
    ? undefined
    : outcome;
}

function resolveLifecycleStartedAt(
  existingStartedAt: number | undefined,
  event: LifecycleEventLike,
): number | undefined {
  if (isFiniteTimestamp(event.data?.startedAt)) {
    return event.data.startedAt;
  }
  if (isFiniteTimestamp(existingStartedAt)) {
    return existingStartedAt;
  }
  return isFiniteTimestamp(event.ts) ? event.ts : undefined;
}

function resolveLifecycleEndedAt(event: LifecycleEventLike): number | undefined {
  if (isFiniteTimestamp(event.data?.endedAt)) {
    return event.data.endedAt;
  }
  return isFiniteTimestamp(event.ts) ? event.ts : undefined;
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

export function deriveGatewaySessionLifecycleSnapshot(params: {
  session?: Partial<Pick<SessionEntry, keyof LifecycleSessionShape>> | null;
  event: LifecycleEventLike;
}): GatewaySessionLifecycleSnapshot {
  const phase = resolveLifecyclePhase(params.event);
  if (!phase) {
    return {};
  }

  const existing = params.session ?? undefined;
  if (phase === "start") {
    // A start event clears terminal fields from the previous run so UI rows do
    // not show stale runtime/end state while the new run is active.
    const startedAt = resolveLifecycleStartedAt(existing?.startedAt, params.event);
    const updatedAt = startedAt ?? existing?.updatedAt;
    return {
      updatedAt,
      status: "running",
      lastRunError: undefined,
      startedAt,
      endedAt: undefined,
      runtimeMs: undefined,
      abortedLastRun: false,
    };
  }

  const startedAt = resolveLifecycleStartedAt(existing?.startedAt, params.event);
  const endedAt = resolveLifecycleEndedAt(params.event);
  const updatedAt = endedAt ?? existing?.updatedAt;
  const terminal = resolveSettledLifecycleTerminalOutcome(params.event);
  // Cancellation must preserve recovery even when the bulk shutdown marker failed.
  // Use the normalized outcome so a prior hard timeout still owns the terminal state.
  const interruptedForRestart =
    terminal?.reason === "cancelled" && terminal.stopReason === "restart";
  const status =
    terminal && !interruptedForRestart
      ? SESSION_STATUS_BY_TERMINAL_CLASSIFICATION[classifyAgentRunTerminalOutcome(terminal)]
      : "running";
  return {
    updatedAt,
    status,
    lastRunError: terminal
      ? resolveSessionRunError({ ...terminal, errorKind: params.event.data?.errorKind }, status)
      : undefined,
    startedAt,
    endedAt: interruptedForRestart ? undefined : endedAt,
    runtimeMs: interruptedForRestart
      ? undefined
      : resolveRuntimeMs({ startedAt, endedAt, existingRuntimeMs: existing?.runtimeMs }),
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

function derivePersistedSessionLifecyclePatch(params: {
  entry?: Partial<PersistedLifecycleSessionShape> | null;
  event: LifecycleEventLike;
}): Partial<PersistedLifecycleSessionShape> {
  const snapshot = deriveGatewaySessionLifecycleSnapshot({
    session: params.entry
      ? {
          ...params.entry,
          status: params.entry.status === "interrupted" ? "failed" : params.entry.status,
        }
      : undefined,
    event: params.event,
  });
  const snapshotPatch: Partial<PersistedLifecycleSessionShape> = {
    ...snapshot,
    updatedAt: typeof snapshot.updatedAt === "number" ? snapshot.updatedAt : undefined,
    ...(snapshot.status === "running" && snapshot.abortedLastRun === true
      ? { restartRecoveryForceSafeTools: true }
      : {}),
  };
  const projection = projectMainSessionRecoveryLifecycle({
    currentLifecycleGeneration: getAgentEventLifecycleGeneration(),
    entry: params.entry,
    event: params.event,
    snapshotPatch,
  });
  if (projection.action === "suppress") {
    return {};
  }
  const phase = resolveLifecyclePhase(params.event);
  const runId = normalizeLifecycleRunId(params.event.runId);
  const clientRunId = normalizeLifecycleRunId(params.event.clientRunId) ?? runId;
  // Run ownership follows the durable running projection. Terminal settlement
  // releases it; yielded parents retain it for their continuation lifecycle.
  return {
    ...projection.patch,
    ...(phase === "start"
      ? { lifecycleRunId: runId, lastRunId: undefined }
      : projection.patch.status && projection.patch.status !== "running"
        ? { lifecycleRunId: undefined, lastRunId: clientRunId }
        : {}),
  };
}

export function deriveGatewaySessionLifecycleProjectionPatch(params: {
  entry?: Partial<PersistedLifecycleSessionShape> | null;
  event: LifecycleEventLike;
}): GatewaySessionLifecycleSnapshot {
  const {
    restartRecoveryRuns: _restartRecoveryRuns,
    restartRecoveryForceSafeTools: _restartRecoveryForceSafeTools,
    lifecycleRunId: _lifecycleRunId,
    ...patch
  } = derivePersistedSessionLifecyclePatch(params);
  const { status, ...fields } = patch;
  // Suppressed events are no-ops; present undefined fields still intentionally clear state.
  return Object.hasOwn(patch, "status")
    ? { ...fields, status: status === "interrupted" ? "failed" : status }
    : fields;
}

export function isRestartRecoveryLifecycleEvent(params: {
  entry?: Pick<SessionEntry, "restartRecoveryRuns"> | null;
  event: Pick<LifecycleEventLike, "runId" | "lifecycleGeneration" | "data">;
}): boolean {
  return isMainSessionRecoveryLifecycleEvent(params);
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

function matchesProviderReviewWriter(
  entry: SessionEntry,
  fact: ProviderReviewTerminalFact,
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

export async function persistGatewaySessionLifecycleEvent(params: {
  sessionKey: string;
  agentId?: string;
  event: LifecycleEventLike;
  assertCommitAllowed?: () => void;
  expectedWriter?: {
    runId: string;
    sessionId: string;
    lifecycleRevision?: string;
  };
}): Promise<void> {
  const phase = resolveLifecyclePhase(params.event);
  if (!phase) {
    return;
  }

  const sessionEntry = loadSessionEntry(params.sessionKey, {
    ...(params.agentId ? { agentId: params.agentId } : {}),
    clone: false,
  });
  if (!sessionEntry.entry) {
    return;
  }
  // Incognito keeps its existing native lifecycle writer. The runtime's private fact
  // joins that same entry update; public event data cannot introduce a review pause.
  const terminalReview =
    (phase === "error" || (phase === "end" && params.event.data?.stopReason === "error")) &&
    isIncognitoSessionKey(sessionEntry.canonicalKey) &&
    params.event.runId
      ? readAgentRunProviderReview(params.event.runId)
      : undefined;
  const providerReview =
    terminalReview &&
    terminalReview.target.sessionKey === sessionEntry.canonicalKey &&
    terminalReview.target.storePath === sessionEntry.storePath &&
    terminalReview.target.sessionId === params.event.sessionId &&
    terminalReview.review.runId === params.event.runId &&
    terminalReview.lifecycleGeneration === params.event.lifecycleGeneration &&
    params.event.ts >= terminalReview.capturedAtMs &&
    (terminalReview.lifecycleStartedAt === undefined ||
      terminalReview.lifecycleStartedAt === params.event.data?.startedAt) &&
    matchesProviderReviewWriter(sessionEntry.entry, terminalReview)
      ? terminalReview
      : undefined;
  const owningSessionId =
    typeof params.event.sessionId === "string" && params.event.sessionId
      ? params.event.sessionId
      : undefined;

  const exactCronRun = parseCronRunScopeSuffix(sessionEntry.canonicalKey).runId !== undefined;
  let terminalRecovery: { runId: string; outcome: AgentRunTerminalOutcome } | undefined;
  let failedRun: { runId: string; error: unknown; errorKind?: "state_contention" } | undefined;
  const persisted = await patchSessionEntryCore(
    {
      storePath: sessionEntry.storePath,
      sessionKey: sessionEntry.canonicalKey,
    },
    async (storedEntry) => {
      terminalRecovery = undefined;
      failedRun = undefined;
      const entry = storedEntry as SessionEntry;
      if (providerReview && !matchesProviderReviewWriter(entry, providerReview)) {
        return null;
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
        return null;
      }
      if (
        exactCronRun &&
        !acceptsCronRunContinuationLifecycleEvent({ entry, event: params.event })
      ) {
        // Exact cron rows transfer lifecycle ownership from the initial run to
        // one claimed continuation. Ready or replaced claims reject late events.
        return null;
      }
      if (
        isStaleLifecycleEventForSession({
          owningSessionId,
          currentSessionId: entry.sessionId,
          eventRunId: params.event.runId,
          currentRunId: entry.lifecycleRunId,
          eventStartedAt: params.event.data?.startedAt,
          currentStartedAt: entry.startedAt,
        })
      ) {
        return null;
      }
      const eventRunId = normalizeLifecycleRunId(params.event.runId);
      const eventClientRunId = normalizeLifecycleRunId(params.event.clientRunId);
      const terminalRunId = normalizeLifecycleRunId(entry.lastRunId);
      if (
        phase === "start" &&
        entry.status !== "running" &&
        terminalRunId !== undefined &&
        (eventRunId === terminalRunId || eventClientRunId === terminalRunId)
      ) {
        // A delayed start from a terminalized run must not reopen the row after
        // its end write commits; lifecycle events are delivered in order, but
        // their async persistence can settle out of order.
        return null;
      }
      const patch: Partial<PersistedLifecycleSessionShape> &
        Pick<SessionEntry, "providerReview" | "goal"> = derivePersistedSessionLifecyclePatch({
        entry,
        event: params.event,
      });
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
        failedRun = {
          runId: eventRunId,
          errorKind:
            params.event.data?.errorKind === "state_contention" ? "state_contention" : undefined,
          error:
            resolveTerminalOutcome(params.event).error ??
            (patch.status === "timeout" ? "Run timed out" : undefined),
        };
      }
      const recoveryTerminalIsCurrent =
        params.event.mainSessionRestartRecovery === true &&
        params.event.lifecycleGeneration === getAgentEventLifecycleGeneration() &&
        eventRunId !== undefined &&
        (phase === "end" || phase === "error");
      const terminalOutcome = recoveryTerminalIsCurrent
        ? resolveSettledLifecycleTerminalOutcome(params.event)
        : undefined;
      if (terminalOutcome && eventRunId && Object.keys(patch).length > 0) {
        terminalRecovery = {
          runId: eventRunId,
          outcome: terminalOutcome,
        };
      }
      return Object.keys(patch).length > 0 ? patch : null;
    },
    {
      skipMaintenance: true,
      takeCacheOwnership: true,
      requireWriteSuccess: true,
      ...(providerReview ? { providerReviewMutation: true } : {}),
      onCommitted: () =>
        sessionChanges.emit({
          sessionKey: sessionEntry.canonicalKey,
          agentId: sessionEntry.agentId,
          storePath: sessionEntry.storePath,
        }),
      ...(params.assertCommitAllowed || providerReview
        ? {
            assertCommitAllowed: () => {
              params.assertCommitAllowed?.();
              providerReview?.assertCurrent();
            },
          }
        : {}),
    },
  );
  if (persisted && terminalRecovery) {
    const message = `main-session restart recovery terminal: session=${sessionEntry.canonicalKey} run=${terminalRecovery.runId} status=${terminalRecovery.outcome.status} reason=${terminalRecovery.outcome.reason}`;
    restartRecoveryLog[terminalRecovery.outcome.status === "ok" ? "info" : "warn"](message);
  }
  if (persisted && failedRun) {
    const { runId, error, errorKind } = failedRun;
    // Only accepted errors pay for branch navigation; assistant detection and
    // report deduplication share the appender's authoritative write snapshot.
    await recordGatewaySessionRunFailure({
      target: {
        agentId: sessionEntry.agentId,
        storePath: sessionEntry.storePath,
        sessionKey: sessionEntry.canonicalKey,
        sessionId: persisted.sessionId,
        expectedLifecycleRevision: persisted.lifecycleRevision,
      },
      runId,
      error,
      errorKind,
      assertCommitAllowed: params.assertCommitAllowed,
    });
  }
}
