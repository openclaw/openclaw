import type { CronCompactJob, CronJobsListResult } from "../api/types.ts";
import type { ApplicationContext } from "../app/context.ts";
import { createSidebarAttentionStore } from "../app/sidebar-attention-store.ts";
import { hiddenScopeUpgradeCapability } from "../test-helpers/application-context.ts";

export type CompactCronPage = CronJobsListResult<CronCompactJob>;

export function cronPage(id?: string): CompactCronPage {
  const jobs = id
    ? [
        {
          id,
          name: id,
          enabled: true,
          updatedAtMs: 0,
          scheduleKind: "every" as const,
          nextRunAt: null,
          nextRunAtMs: null,
          lastRunAt: null,
          lastRunAtMs: null,
          lastRunError: null,
          lastRunStatus: "error" as const,
        },
      ]
    : [];
  return {
    jobs,
    snapshotRevision: id ?? "empty",
    total: jobs.length,
    offset: 0,
    limit: 50,
    hasMore: false,
    nextOffset: null,
  };
}

export function createStore(
  gateway: ApplicationContext["gateway"],
  connectionBootstrap?: ApplicationContext["connectionBootstrap"],
) {
  const agentSelection = {
    state: { selectedId: "main", scopeId: null },
    subscribe: () => () => undefined,
  } as unknown as ApplicationContext["agentSelection"];
  return createSidebarAttentionStore({
    gateway,
    agentSelection,
    agents: {
      state: { agentsList: null },
      subscribe: () => () => undefined,
    } as unknown as ApplicationContext["agents"],
    overlays: {
      snapshot: { approvalQueue: [] },
      subscribe: () => () => undefined,
    } as unknown as ApplicationContext["overlays"],
    scopeUpgrade: hiddenScopeUpgradeCapability,
    connectionBootstrap,
  });
}
