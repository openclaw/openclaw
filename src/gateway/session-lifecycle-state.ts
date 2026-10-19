import { normalizeOptionalString as normalizeLifecycleRunId } from "@openclaw/normalization-core/string-coerce";
import { getRuntimeConfig } from "../config/io.js";
import { applySessionEntryTargetOperation } from "../config/sessions/session-accessor.sqlite-entry.js";
import {
  deriveSessionLifecycleSnapshot,
  resolveSessionLifecycleTerminal,
  derivePersistedSessionLifecyclePatch,
  matchesProviderReviewWriter,
  resolveLifecyclePhase,
  type LifecycleEventLike,
  type LifecyclePhase,
  type SessionLifecyclePatchEffects,
} from "../config/sessions/session-run-lifecycle-projection.js";
import { composeSessionSourceAssertion } from "../config/sessions/session-source-authority.js";
import { withOwnedSessionTranscriptWrites } from "../config/sessions/transcript-write-context.js";
import { getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { readAgentRunProviderReview } from "../sessions/provider-review-terminal.js";
import {
  AgentDeletionPendingError,
  retainAgentDeletionTerminalWrite,
} from "../sessions/session-agent-work-admission.js";
import { parseCronRunScopeSuffix } from "../sessions/session-key-utils.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import {
  recordGatewaySessionRunFailure,
  resolveSessionRunError,
} from "../sessions/session-run-error.js";
import { runOutsideAsyncWorkScope, trackAsyncWork } from "../shared/async-work-scope.js";
import { isIncognitoSessionKey } from "../shared/incognito-session-key.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "./session-utils-store-worker.js";

export { isStaleLifecycleEventForSession } from "../config/sessions/session-run-lifecycle-projection.js";

const restartRecoveryLog = createSubsystemLogger("main-session-restart-recovery");

function resolveLifecycleFailureSummary(event: LifecycleEventLike): string | undefined {
  const { terminal, status } = resolveSessionLifecycleTerminal(event);
  return terminal && status
    ? resolveSessionRunError({ ...terminal, errorKind: event.data?.errorKind }, status)
    : undefined;
}

export function deriveGatewaySessionLifecycleSnapshot(
  params: Omit<Parameters<typeof deriveSessionLifecycleSnapshot>[0], "lastRunError">,
) {
  return deriveSessionLifecycleSnapshot({
    ...params,
    lastRunError: resolveLifecycleFailureSummary(params.event),
  });
}

export function deriveGatewaySessionLifecycleProjectionPatch(params: {
  entry?: Parameters<typeof derivePersistedSessionLifecyclePatch>[0]["entry"];
  event: LifecycleEventLike;
}): ReturnType<typeof deriveGatewaySessionLifecycleSnapshot> {
  const {
    restartRecoveryRuns: _restartRecoveryRuns,
    restartRecoveryForceSafeTools: _restartRecoveryForceSafeTools,
    lifecycleRunId: _lifecycleRunId,
    ...patch
  } = derivePersistedSessionLifecyclePatch({
    ...params,
    currentLifecycleGeneration: getAgentEventLifecycleGeneration(),
    lastRunError: resolveLifecycleFailureSummary(params.event),
  });
  return patch;
}

type GatewaySessionLifecycleEventParams = {
  sessionKey: string;
  agentId?: string;
  clientRunId?: string;
  event: LifecycleEventLike;
  assertCommitAllowed?: () => void;
  expectedWriter?: {
    requireYielded?: true;
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
  return async () => {
    const sessionEntry = await prepared;
    try {
      await persistPreparedGatewaySessionLifecycleEvent(params, phase, sessionEntry);
    } catch (error) {
      // Drain settlement transfers the outcome to deletion, not to a successful write.
      if (
        phase === "start" ||
        !(error instanceof AgentDeletionPendingError) ||
        !retainAgentDeletionTerminalWrite(
          { agentId: sessionEntry.agentId },
          {
            target: sessionEntry.capturedReadSource ?? {
              agentId: sessionEntry.agentId,
              path: sessionEntry.storePath,
            },
            // The run has drained. Deletion now owns replay of this captured outcome.
            persist: (assertCommitAllowed) =>
              persistPreparedGatewaySessionLifecycleEvent(
                { ...params, assertCommitAllowed },
                phase,
                sessionEntry,
              ),
          },
        )
      ) {
        throw error;
      }
    }
  };
}

async function persistPreparedGatewaySessionLifecycleEvent(
  params: GatewaySessionLifecycleEventParams,
  phase: LifecyclePhase,
  sessionEntry: Awaited<ReturnType<typeof loadGatewaySessionEntryReadOnlyInWorker>>,
): Promise<void> {
  if (!sessionEntry.entry) {
    return;
  }
  const startedRunId = phase === "start" ? normalizeLifecycleRunId(params.event.runId) : undefined;
  if (
    startedRunId &&
    sessionEntry.entry.lifecycleRunId === startedRunId &&
    sessionEntry.entry.status === undefined &&
    sessionEntry.entry.endedAt === undefined &&
    sessionEntry.entry.abortedLastRun !== true
  ) {
    // Admission already committed the running marker. Live events carry backend
    // timing until settlement persists it; yielded runs still need a resume write.
    return;
  }
  const lifecycleRevision = sessionEntry.entry.lifecycleRevision;
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
  let effects: SessionLifecyclePatchEffects | undefined;
  const persisted = await applySessionEntryTargetOperation(
    {
      agentId: sessionEntry.agentId,
      storePath: sessionEntry.storePath,
      readSource: sessionEntry.capturedReadSource,
      target: {
        canonicalKey: sessionEntry.canonicalKey,
        storeKeys: sessionEntry.storeKeys,
      },
    },
    {
      kind: "lifecycle",
      lifecycle: {
        // Runtime event metadata includes non-enumerable generation and host-only callbacks.
        event: {
          ts: params.event.ts,
          sessionId: params.event.sessionId,
          runId: params.event.runId,
          clientRunId: params.clientRunId ?? params.event.clientRunId,
          lifecycleGeneration: params.event.lifecycleGeneration,
          mainSessionRestartRecovery: params.event.mainSessionRestartRecovery,
          controlUiVisible: params.event.controlUiVisible,
          isHeartbeat: params.event.isHeartbeat,
          contextClaimId: params.event.contextClaimId,
          data: params.event.data,
        },
        currentLifecycleGeneration: getAgentEventLifecycleGeneration(),
        lastRunError: resolveLifecycleFailureSummary(params.event),
        canonicalKey: sessionEntry.canonicalKey,
        lifecycleRevision,
        exactCronRun: parseCronRunScopeSuffix(sessionEntry.canonicalKey).runId !== undefined,
        expectedWriter: params.expectedWriter,
        providerReview: providerReview
          ? {
              target: providerReview.target,
              expectedWriterRunId: providerReview.expectedWriterRunId,
              review: providerReview.review,
            }
          : undefined,
      },
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
      onCommitted: (_entry, _predicate, lifecycleEffects) => {
        effects = lifecycleEffects;
        sessionChanges.emit({
          sessionKey: sessionEntry.canonicalKey,
          agentId: sessionEntry.agentId,
          storePath: sessionEntry.storePath,
          // The writer already published stored facts; this adapter only projects run state.
          scope: "runtime",
          facts: { kind: "unchanged" },
        });
      },
    },
  );
  const { terminalRecovery, failedRun } = effects ?? {};
  if (persisted && terminalRecovery) {
    const message = `main-session restart recovery terminal: session=${sessionEntry.canonicalKey} run=${terminalRecovery.runId} status=${terminalRecovery.outcome.status} reason=${terminalRecovery.outcome.reason}`;
    restartRecoveryLog[terminalRecovery.outcome.status === "ok" ? "info" : "warn"](message);
  }
  if (persisted && failedRun) {
    const { runId, error, errorKind, suppressErrorNotice } = failedRun;
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
      suppressErrorNotice,
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
