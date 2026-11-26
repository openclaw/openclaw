import { hasExecYieldWake } from "../agents/bash-tools.exec-notify.js";
import { resolveSessionYieldWait } from "../agents/subagents/registry/subagent-registry-read.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { hasAgentRunContextExecutionOwner } from "../infra/agent-run-registry.js";
import { chatRef } from "../sessions/chat-ref.js";
import { shouldWake } from "../sessions/owed.js";
import { hasSessionControllerQueuedWork } from "../sessions/session-controller.context.js";
import { isSessionControllerWorkActive } from "../sessions/session-controller.lifecycle-observation.js";
import type { GatewayContextResolver } from "./server-methods/types.js";
import { hasRetainedSessionContinuation } from "./session-continuation-lifetime.js";
import { recordUnreachableYieldFailure } from "./session-restart-resume-failure.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";

// A projection revision fences every row publication, including delivery-only changes.
// Keep just the parked keys. Their in-memory wake sources can change between ticks.
const parkedKeysByRevision = new WeakMap<object, ReadonlySet<string>>();

/** Reconcile session lifecycle facts, including turns that never belonged to subagent_runs. */
export async function sweepUnreachableSessionYields(
  resolveGatewayContext: GatewayContextResolver,
  signal: AbortSignal,
): Promise<void> {
  const projection = getSessionRowProjection(resolveGatewayContext());
  if (!projection) {
    return;
  }
  await projection.prepareSelection({ metadataOnly: true, includeCatalog: false });
  signal.throwIfAborted();
  const revision = projection.sharingRevision;
  const knownKeys = revision && parkedKeysByRevision.get(revision);
  const candidates = projection.selectEntries(
    { sortBy: null, candidateSessionIdsOrKeys: knownKeys },
    true,
  );
  const discoveredKeys = revision && !knownKeys ? new Set<string>() : undefined;
  for (const { key: sessionKey, agentId, entry, storeTarget } of candidates) {
    signal.throwIfAborted();
    if (!isParkedSessionYield(entry)) {
      continue;
    }
    discoveredKeys?.add(sessionKey);
    if (
      hasAgentRunContextExecutionOwner(entry.lifecycleRunId!) ||
      isSessionControllerWorkActive(
        storeTarget.storePath,
        [sessionKey, entry.sessionId],
        agentId,
      ) ||
      hasSessionControllerQueuedWork(
        storeTarget.storePath,
        [sessionKey, entry.sessionId],
        agentId,
      ) ||
      hasRetainedSessionContinuation(sessionKey, agentId, resolveGatewayContext) ||
      hasExecYieldWake({ sessionKey, agentId }) ||
      resolveSessionYieldWait(sessionKey, entry, agentId) !== "unreachable" ||
      (await shouldWake(chatRef({ agentId, storePath: storeTarget.storePath, sessionKey })))
    ) {
      continue;
    }
    await recordUnreachableYieldFailure({ sessionKey, agentId, entry, signal });
  }
  if (revision && discoveredKeys && projection.sharingRevision === revision) {
    parkedKeysByRevision.set(revision, discoveredKeys);
  }
}

function isParkedSessionYield(entry: InternalSessionEntry): boolean {
  return Boolean(
    entry.lifecycleRunId &&
    entry.status === undefined &&
    Number.isFinite(entry.endedAt) &&
    !entry.pendingFinalDelivery &&
    entry.archivedAt === undefined &&
    !entry.incognito,
  );
}
