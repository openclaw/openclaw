/** Removes an idle exact-run continuation through the session lifecycle owner. */
import { hasPendingGeneratedMediaTaskForSessionKey } from "../agents/media-generation-activity.js";
import { hasDescendantRunAwaitingSettle } from "../agents/subagents/registry/subagent-registry-read.js";
import { getRuntimeConfig } from "../config/config.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { deleteSessionEntryLifecycle } from "../config/sessions/session-accessor.js";
import { withSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import { loadPendingSessionDeliveries } from "../infra/session-delivery-queue-storage.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { parseCronRunScopeSuffix } from "../sessions/session-key-utils.js";
import {
  isCompetingSessionWorkAdmissionActive,
  runExclusiveSessionLifecycleMutation,
} from "../sessions/session-lifecycle-admission.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";

function canRemoveCronRunContinuation(marker: SessionEntry["cronRunContinuation"]): boolean {
  if (!marker || marker.basePersisted !== true) {
    return false;
  }
  if (marker.phase === "ready") {
    return !marker.ownerRunId;
  }
  if (marker.phase !== "continuing" || !marker.ownerRunId) {
    return false;
  }
  // A retired Gateway owner cannot settle this claim; basePersisted above
  // guarantees deleting its exact alias does not discard the stable session.
  const ownerLifecycleGeneration = marker.ownerLifecycleGeneration?.trim();
  return Boolean(
    ownerLifecycleGeneration && ownerLifecycleGeneration !== getAgentEventLifecycleGeneration(),
  );
}

export async function removeCronRunContinuationSessionIfIdle(
  sessionKey: string,
  settledDeliveryId?: string,
  queueContext?: OpenClawStateWorkerContext,
): Promise<void> {
  if (
    !parseCronRunScopeSuffix(sessionKey).runId ||
    hasPendingGeneratedMediaTaskForSessionKey(sessionKey)
  ) {
    return;
  }
  const context = queueContext ?? captureOpenClawStateWorkerContext();
  const assertCurrent = () => context.admission.assertCurrent();
  const agentId = resolveAgentIdFromSessionKey(sessionKey);
  const storePath = resolveSessionStorePathCore(getRuntimeConfig().session?.store, {
    agentId,
    env: context.environment,
  });
  const readEntry = () =>
    withSessionEntryReadOnlyInWorker(
      {
        agentId,
        sessionKey,
        storePath,
        env: context.environment,
        hydrateSkillPromptRefs: false,
      },
      assertCurrent,
      async (read) => {
        if (!read.ok) {
          throw read.error;
        }
        return read.value;
      },
    );
  const original = await readEntry();
  if (!original || !canRemoveCronRunContinuation(original.cronRunContinuation)) {
    return;
  }
  await runExclusiveSessionLifecycleMutation({
    scope: storePath,
    identities: [sessionKey, original.sessionId],
    run: async () => {
      if (isCompetingSessionWorkAdmissionActive(storePath, [sessionKey, original.sessionId])) {
        return;
      }
      const pendingSessionDeliveries = await loadPendingSessionDeliveries(context);
      if (
        hasDescendantRunAwaitingSettle(sessionKey) ||
        hasPendingGeneratedMediaTaskForSessionKey(sessionKey) ||
        pendingSessionDeliveries.some(
          (entry) =>
            entry.sessionKey === sessionKey &&
            entry.id !== settledDeliveryId &&
            entry.settlementOutcome === undefined &&
            entry.acknowledgedAt === undefined,
        )
      ) {
        return;
      }
      const entry = await readEntry();
      if (
        !entry ||
        entry.sessionId !== original.sessionId ||
        entry.lifecycleRevision !== original.lifecycleRevision ||
        !canRemoveCronRunContinuation(entry.cronRunContinuation)
      ) {
        return;
      }
      await deleteSessionEntryLifecycle({
        agentId,
        commitGuard: () => {
          assertCurrent();
          if (
            hasDescendantRunAwaitingSettle(sessionKey) ||
            hasPendingGeneratedMediaTaskForSessionKey(sessionKey)
          ) {
            throw new Error("cron run continuation still has unsettled background work");
          }
        },
        // Exact rows alias the stable cron transcript; the stable row owns archival.
        archiveTranscript: false,
        expectedEntry: entry,
        expectedLifecycleRevision: entry.lifecycleRevision,
        expectedSessionId: entry.sessionId,
        expectedUpdatedAt: entry.updatedAt,
        requireWriteSuccess: true,
        storePath,
        target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      });
    },
  });
}
