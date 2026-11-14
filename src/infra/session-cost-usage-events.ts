import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { notifyListeners } from "../shared/listeners.js";
import type { SessionCostUsagePublication } from "../shared/usage-types.js";

const publications = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionCostUsagePublications"),
  () => ({
    updatedAt: 0,
    notifications: { onUpdated: (_event: SessionCostUsagePublication) => {} },
  }),
  (state) => {
    state.notifications.onUpdated = () => {};
  },
);

export const sessionCostUsageNotifications = publications.notifications;

export function getSessionCostUsageUpdatedAt(): number {
  return publications.updatedAt;
}

export function publishSessionCostUsageUpdated(agentId: string, failed = false): void {
  publications.updatedAt = Math.max(Date.now(), publications.updatedAt + 1);
  notifyListeners([publications.notifications.onUpdated], {
    agentId,
    usageUpdatedAt: publications.updatedAt,
    ...(failed ? { usageRefreshFailed: true } : {}),
  });
}
