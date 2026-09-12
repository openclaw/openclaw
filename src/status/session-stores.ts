import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { readSessionStoreSummaryReadOnly } from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../config/types.js";
import type { listGatewayAgentsBasic } from "../gateway/agent-list.js";
import { readAgentDatabaseAdmissionRefusal } from "../state/agent-database-admission.js";

export const STATUS_RECENT_SESSION_LIMIT = 10;
export type StatusSessionStores = ReturnType<
  typeof readStatusSessionStores<ReturnType<typeof listGatewayAgentsBasic>["agents"][number]>
>;

/** One collection owns each physical store's bounded snapshot, including its agent windows. */
export function createStatusSessionStoreReader(
  agentIds: readonly string[],
  recentLimit: number,
  readSummary: typeof readSessionStoreSummaryReadOnly = readSessionStoreSummaryReadOnly,
) {
  const stores = new Map<string, ReturnType<typeof readSessionStoreSummaryReadOnly>>();
  return {
    stores,
    read(storePath: string, agentId?: string) {
      const path = resolveSqliteTargetFromSessionStorePath(storePath, { agentId }).path;
      if (agentId && readAgentDatabaseAdmissionRefusal(agentId)) {
        return { path, count: 0, recent: [] };
      }
      let store = stores.get(path);
      if (!store) {
        store = readSummary(
          { ...(agentId ? { agentId } : {}), storePath },
          { agentIds, recentLimit },
        );
        stores.set(path, store);
      }
      const summary = agentId ? store.byAgent.get(agentId) : store;
      return { path, count: summary?.count ?? 0, recent: summary?.recent ?? [] };
    },
  };
}

/** Reads each physical store once, retaining retired agent namespaces in the aggregate. */
export function readStatusSessionStores<Agent extends { id: string; name?: string }>(
  cfg: OpenClawConfig,
  agents: readonly Agent[],
  recentLimit: number,
) {
  const reader = createStatusSessionStoreReader(
    agents.map((agent) => agent.id),
    recentLimit,
  );
  const byAgent = agents.map((agent) => ({
    agent,
    ...reader.read(
      resolveSessionStorePathCore(cfg.session?.store, { agentId: agent.id }),
      agent.id,
    ),
  }));
  return {
    paths: [...reader.stores.keys()],
    count: [...reader.stores.values()].reduce((count, store) => count + store.count, 0),
    recent: [...reader.stores.values()].flatMap((store) => store.recent),
    byAgent,
  };
}
