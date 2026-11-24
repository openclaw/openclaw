import { hasExecYieldWake } from "../agents/bash-tools.exec-notify.js";
import { resolveSessionYieldWait } from "../agents/subagents/registry/subagent-registry-read.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { hasAgentRunContextExecutionOwner } from "../infra/agent-run-registry.js";
import { hasSessionControllerQueuedWork } from "../sessions/session-controller.context.js";
import { isSessionControllerWorkActive } from "../sessions/session-controller.lifecycle-observation.js";
import type { GatewayContextResolver } from "./server-methods/types.js";
import { hasRetainedSessionContinuation } from "./session-continuation-lifetime.js";
import { recordUnreachableYieldFailure } from "./session-restart-resume-failure.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";

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
  const candidates = projection.selectEntries({ sortBy: null }, true);
  for (const { key: sessionKey, agentId, entry, storeTarget } of candidates) {
    signal.throwIfAborted();
    if (!isParkedSessionYield(entry)) {
      continue;
    }
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
      resolveSessionYieldWait(sessionKey, entry, agentId) !== "unreachable"
    ) {
      continue;
    }
    await recordUnreachableYieldFailure({ sessionKey, agentId, entry, signal });
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
