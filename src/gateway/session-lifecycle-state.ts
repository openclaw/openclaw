import { isDeepStrictEqual } from "node:util";
import { normalizeOptionalString as normalizeLifecycleRunId } from "@openclaw/normalization-core/string-coerce";
import { isAgentLifecycleYieldedWaiting } from "../agents/agent-lifecycle-parent-state.js";
import {
  buildAgentRunTerminalOutcomeFromLifecycleEvent,
  classifyAgentRunTerminalOutcome,
  type AgentRunTerminalOutcome,
} from "../agents/agent-run-terminal-outcome.js";
import { projectMainSessionRecoveryLifecycle } from "../agents/main-session-recovery/main-session-recovery-lifecycle.js";
import { recordLifecycleFence } from "../agents/main-session-recovery/main-session-recovery-state.js";
import { getRuntimeConfig } from "../config/io.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";
import { buildUpdatedSessionGoalStatus } from "../config/sessions/goals-transitions.js";
import { isMainRestartRecoveryCandidate } from "../config/sessions/restart-recovery-state.js";
import { patchSessionEntryTarget } from "../config/sessions/session-accessor.js";
import { composeSessionSourceAssertion } from "../config/sessions/session-source-authority.js";
import { withOwnedSessionTranscriptWrites } from "../config/sessions/transcript-write-context.js";
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
import { runOutsideAsyncWorkScope, trackAsyncWork } from "../shared/async-work-scope.js";
import { isIncognitoSessionKey } from "../shared/incognito-session-key.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "./session-utils-store-worker.js";
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
    executionStarted?: unknown;
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

function resolveLifecyclePhase(event: Pick<LifecycleEventLike, "data">): LifecyclePhase | null {
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

export function deriveGatewaySessionLifecycleSnapshot(params: {
  session?: Partial<Pick<SessionEntry, keyof LifecycleSessionShape>> | null;
  event: LifecycleEventLike;
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
      startedAt,
      endedAt: undefined,
      runtimeMs: undefined,
      abortedLastRun: false,
    };
  }

  const endedAt = resolveLifecycleTimestamp(params.event.data?.endedAt, params.event.ts);
  const updatedAt = endedAt ?? existing?.updatedAt;
  const terminal = resolveSettledLifecycleTerminalOutcome(params.event);
  // Cancellation must preserve recovery even when the bulk shutdown marker failed.
  // Use the normalized outcome so a prior hard timeout still owns the terminal state.
  const interruptedForRestart =
    terminal?.reason === "cancelled" && terminal.stopReason === "restart";
  const status = interruptedForRestart
    ? "interrupted"
    : terminal
      ? SESSION_STATUS_BY_TERMINAL_CLASSIFICATION[classifyAgentRunTerminalOutcome(terminal)]
      : undefined;
  return {
    updatedAt,
    status,
    lastRunError: interruptedForRestart
      ? "Run interrupted by a Gateway restart."
      : terminal && status
        ? resolveSessionRunError({ ...terminal, errorKind: params.event.data?.errorKind }, status)
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

function derivePersistedSessionLifecyclePatch(params: {
  entry?: Partial<Omit<PersistedLifecycleSessionShape, "status">> | null;
  event: LifecycleEventLike;
}): Partial<PersistedLifecycleSessionShape> {
  const phase = resolveLifecyclePhase(params.event);
  // Queued request settlement cannot end the turn that owns this session.
  if ((phase === "end" || phase === "error") && params.event.data?.executionStarted === false) {
    return {};
  }
  const snapshot = deriveGatewaySessionLifecycleSnapshot({
    session: params.entry,
    event: params.event,
  });
  const runId = normalizeLifecycleRunId(params.event.runId);
  const snapshotPatch: Partial<PersistedLifecycleSessionShape> = {
    ...snapshot,
    ...(snapshot.status === "interrupted" ? { restartRecoveryForceSafeTools: true } : {}),
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

export function deriveGatewaySessionLifecycleProjectionPatch(params: {
  entry?: Partial<Omit<PersistedLifecycleSessionShape, "status">> | null;
  event: LifecycleEventLike;
}): GatewaySessionLifecycleSnapshot {
  const {
    restartRecoveryRuns: _restartRecoveryRuns,
    restartRecoveryForceSafeTools: _restartRecoveryForceSafeTools,
    lifecycleRunId: _lifecycleRunId,
    ...patch
  } = derivePersistedSessionLifecyclePatch(params);
  return patch;
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

type GatewaySessionLifecycleEventParams = {
  sessionKey: string;
  agentId?: string;
  event: LifecycleEventLike;
  assertCommitAllowed?: () => void;
  expectedWriter?: {
    runId: string;
    sessionId: string;
    lifecycleRevision?: string;
  };
};

export async function persistGatewaySessionLifecycleEvent(
  params: GatewaySessionLifecycleEventParams,
): Promise<void> {
  await runOutsideAsyncWorkScope(() => prepareGatewaySessionLifecycleEvent(params)());
}

/** Capture lookup custody before the lifecycle owner waits for an earlier event. */
export function prepareGatewaySessionLifecycleEvent(params: GatewaySessionLifecycleEventParams) {
  const phase = resolveLifecyclePhase(params.event);
  if (!phase) {
    return async () => {};
  }
  const prepared = loadGatewaySessionEntryReadOnlyInWorker({
    cfg: getRuntimeConfig(),
    key: params.sessionKey,
    excludeInternalEffects: true,
    ...(params.agentId ? { agentId: params.agentId } : {}),
  });
  // Queue waits must not leave an early read rejection unobserved.
  void prepared.catch(() => undefined);
  return async () => persistPreparedGatewaySessionLifecycleEvent(params, phase, await prepared);
}

async function persistPreparedGatewaySessionLifecycleEvent(
  params: GatewaySessionLifecycleEventParams,
  phase: LifecyclePhase,
  sessionEntry: Awaited<ReturnType<typeof loadGatewaySessionEntryReadOnlyInWorker>>,
): Promise<void> {
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
  const persisted = await patchSessionEntryTarget(
    {
      agentId: sessionEntry.agentId,
      storePath: sessionEntry.storePath,
      readSource: sessionEntry.capturedReadSource,
      target: {
        canonicalKey: sessionEntry.canonicalKey,
        storeKeys: sessionEntry.storeKeys,
      },
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
      if (
        eventRunId &&
        isMainRestartRecoveryCandidate(entry, sessionEntry.canonicalKey) &&
        (patch.status === "interrupted" ||
          (phase === "start" && patch.lifecycleRunId === eventRunId))
      ) {
        // Source-less starts and restart aborts arm custody in their existing write.
        patch.restartRecoveryRuns = entry.restartRecoveryRuns;
        recordLifecycleFence(patch, {
          runId: eventRunId,
          lifecycleGeneration:
            params.event.lifecycleGeneration ?? getAgentEventLifecycleGeneration(),
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
      workerGuard: {
        source: composeSessionSourceAssertion([
          params.assertCommitAllowed,
          providerReview?.assertCurrent,
        ]),
      },
      ...(providerReview ? { providerReviewMutation: true } : {}),
      onCommitted: () =>
        sessionChanges.emit({
          sessionKey: sessionEntry.canonicalKey,
          agentId: sessionEntry.agentId,
          storePath: sessionEntry.storePath,
          // The SQLite writer already published sharing facts; this adapter only projects run state.
          facts: { kind: "unchanged" },
        }),
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
    const receipt = {
      target: {
        agentId: sessionEntry.agentId,
        storePath: sessionEntry.storePath,
        sessionKey: sessionEntry.canonicalKey,
        sessionId: persisted.sessionId,
        expectedLifecycleRevision: persisted.lifecycleRevision,
        expectedWriterRunId: persisted.activeWriterRunId,
      },
      runId,
      error,
      errorKind,
      assertCommitAllowed: params.assertCommitAllowed,
    };
    // An accepted terminal owns its receipt, independently of an ambient requester turn.
    await withOwnedSessionTranscriptWrites(
      {
        sessionTarget: receipt.target,
        assertCommitAllowed: params.assertCommitAllowed,
        withTranscriptWrite: trackAsyncWork,
      },
      () => recordGatewaySessionRunFailure(receipt),
    );
  }
}
