import { vi } from "vitest";
import { makeCronJob } from "../../../src/cron/delivery.test-helpers.ts";
import type { CronCompactJob, CronJob, CronJobsListResult } from "../api/types.ts";
import { client as mockClient, createGatewayHarness } from "../app/overlays-access.test-support.ts";
import { createSidebarAttentionStore } from "../app/sidebar-attention-store.ts";
import { hiddenScopeUpgradeCapability } from "../test-helpers/application-context.ts";
import { SidebarAttentionStoreOwner } from "./sidebar-attention-store.ts";

export type CompactCronPage = CronJobsListResult<CronCompactJob>;
type Sources = Parameters<typeof createSidebarAttentionStore>[0];
const inert = <T>(value: T) => ({ ...value, subscribe: () => () => undefined });

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
  gateway: Sources["gateway"],
  connectionBootstrap?: Sources["connectionBootstrap"],
  selection?: Sources["agentSelection"],
) {
  const agentSelection =
    selection ??
    (inert({
      state: { selectedId: "main", scopeId: null },
    }) as unknown as Sources["agentSelection"]);
  return createSidebarAttentionStore({
    gateway,
    agentSelection,
    agents: inert({ state: { agentsList: null } }) as unknown as Sources["agents"],
    overlays: inert({ snapshot: { approvalQueue: [] } }) as unknown as Sources["overlays"],
    scopeUpgrade: hiddenScopeUpgradeCapability,
    connectionBootstrap,
  });
}

export function inventoryRequest(
  list: (params?: unknown) => unknown,
  jobs = 1,
  auth: () => unknown = () => ({ ts: 1, providers: [] }),
) {
  return vi.fn(async (method: string, params?: unknown) =>
    method === "cron.list"
      ? list(params)
      : method === "cron.status"
        ? { enabled: true, triggersEnabled: true, jobs }
        : auth(),
  );
}

export function startAuthenticatedStore(request: Parameters<typeof mockClient>[0]) {
  const harness = createGatewayHarness(mockClient(request));
  harness.update({ selfUser: { id: "alice", name: "Alice" } });
  const store = createStore(harness.gateway);
  store.activate(SidebarAttentionStoreOwner);
  return { ...harness, attention: store };
}

export function eventJob(overrides: Partial<CronJob> = {}): CronJob {
  return makeCronJob({
    id: "incident",
    name: "incident",
    agentId: "main",
    createdAtMs: 0,
    updatedAtMs: 0,
    configRevision: "fixture-config",
    payload: { kind: "agentTurn", message: "Synthetic scheduled task" },
    state: { lastRunStatus: "error" },
    ...overrides,
  });
}
