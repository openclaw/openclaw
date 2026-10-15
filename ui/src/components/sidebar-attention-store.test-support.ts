import { vi } from "vitest";
import type { CronCompactJob, CronJob, CronJobsListResult } from "../api/types.ts";
import type { ApplicationContext } from "../app/context.ts";
import { client as mockClient, createGatewayHarness } from "../app/overlays-access.test-support.ts";
import { createSidebarAttentionStore } from "../app/sidebar-attention-store.ts";
import { hiddenScopeUpgradeCapability } from "../test-helpers/application-context.ts";
import { SidebarAttentionStoreController } from "./sidebar-attention-store.ts";

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
  selection?: ApplicationContext["agentSelection"],
) {
  const agentSelection =
    selection ??
    ({
      state: { selectedId: "main", scopeId: null },
      subscribe: () => () => undefined,
    } as unknown as ApplicationContext["agentSelection"]);
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
  store.activate(SidebarAttentionStoreController);
  return { ...harness, attention: store };
}

export function eventJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "incident",
    name: "incident",
    agentId: "main",
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    configRevision: "fixture-config",
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "Synthetic scheduled task" },
    state: { lastRunStatus: "error" },
    ...overrides,
  };
}
