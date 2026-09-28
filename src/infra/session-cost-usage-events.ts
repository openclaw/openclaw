import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { notifyListeners, registerListener } from "../shared/listeners.js";
import type { SessionCostUsagePublication } from "../shared/usage-types.js";

const publications = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionCostUsagePublications"),
  () => ({ updatedAt: 0, listeners: new Set<(event: SessionCostUsagePublication) => void>() }),
  (state) => state.listeners.clear(),
);

export function getSessionCostUsageUpdatedAt(): number {
  return publications.updatedAt;
}

export function onSessionCostUsageUpdated(
  listener: (event: SessionCostUsagePublication) => void,
): () => void {
  return registerListener(publications.listeners, listener);
}

export function publishSessionCostUsageUpdated(agentId: string, failed = false): void {
  publications.updatedAt = Math.max(Date.now(), publications.updatedAt + 1);
  notifyListeners(publications.listeners, {
    agentId,
    usageUpdatedAt: publications.updatedAt,
    ...(failed ? { usageRefreshFailed: true } : {}),
  });
}
