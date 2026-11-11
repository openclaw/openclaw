import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { readCronInventory } from "./inventory.ts";

type CronScopeState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  cronAgentId: string | null;
  cronScopedTotal: number | null;
  cronScopedNextWakeAtMs: number | null;
  canRefresh?: () => boolean;
};

export async function loadCronScopeStats(state: CronScopeState, options?: { refresh?: boolean }) {
  if (!state.client || !state.connected || !state.cronAgentId) {
    state.cronScopedTotal = null;
    state.cronScopedNextWakeAtMs = null;
    return;
  }
  try {
    const [allJobs, nextEnabledJob] = await Promise.all([
      readCronInventory(
        state.client,
        {
          agentId: state.cronAgentId,
          includeDisabled: true,
          includeDeliveryPreviews: false,
          limit: 1,
          offset: 0,
        },
        { ...options, canRead: state.canRefresh },
      ),
      readCronInventory(
        state.client,
        {
          agentId: state.cronAgentId,
          enabled: "enabled",
          includeDeliveryPreviews: false,
          limit: 1,
          offset: 0,
          sortBy: "nextRunAtMs",
          sortDir: "asc",
        },
        { ...options, canRead: state.canRefresh },
      ),
    ]);
    state.cronScopedTotal = typeof allJobs.total === "number" ? allJobs.total : null;
    const nextRunAtMs = nextEnabledJob.jobs[0]?.state?.nextRunAtMs;
    state.cronScopedNextWakeAtMs =
      typeof nextRunAtMs === "number" && Number.isFinite(nextRunAtMs) ? nextRunAtMs : null;
  } catch {
    state.cronScopedTotal = null;
    state.cronScopedNextWakeAtMs = null;
  }
}
