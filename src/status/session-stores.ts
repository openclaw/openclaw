import { performance } from "node:perf_hooks";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { readSessionStoreSummaryReadOnly } from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../config/types.js";
import type { listGatewayAgentsBasic } from "../gateway/agent-list.js";
import type { SessionRowProjection } from "../gateway/session-row-projection.js";
import { readAgentDatabaseAdmissionRefusal } from "../state/agent-database-admission.js";

export const STATUS_RECENT_SESSION_LIMIT = 10;
const SESSION_STORE_READ_SLICE_MS = 8;
type SessionStoreSummary = ReturnType<typeof readSessionStoreSummaryReadOnly>;
export type StatusSessionStores = Awaited<
  ReturnType<
    typeof readStatusSessionStores<ReturnType<typeof listGatewayAgentsBasic>["agents"][number]>
  >
>;

function summarizeProjectionRows(
  projection: SessionRowProjection,
  storePath: string,
  agentIds: readonly string[],
  recentLimit: number,
): SessionStoreSummary {
  const rows = projection.selectEntries({ storePath, sortBy: null });
  if (recentLimit !== 0) {
    // The projection returns a fresh selection, independent of its resident indexes.
    rows.sort(
      (left, right) =>
        (right.entry.updatedAt ?? 0) - (left.entry.updatedAt ?? 0) ||
        (left.key < right.key ? -1 : left.key > right.key ? 1 : 0),
    );
  }
  const summarize = (selected: typeof rows) => ({
    count: selected.length,
    recent: selected.slice(0, recentLimit).map(({ key: sessionKey, entry }) => ({
      sessionKey,
      entry,
    })),
  });
  if (recentLimit >= 0) {
    const byAgent: SessionStoreSummary["byAgent"] = new Map(
      agentIds.map((agentId) => [agentId, { count: 0, recent: [] }]),
    );
    rows.forEach((row) => {
      const agent = byAgent.get(row.agentId);
      if (agent) {
        agent.count += 1;
        if (agent.count <= recentLimit) {
          agent.recent.push({ sessionKey: row.key, entry: row.entry });
        }
      }
    });
    return { count: rows.length, recent: recentLimit === 0 ? [] : summarize(rows).recent, byAgent };
  }
  return {
    ...summarize(rows),
    byAgent: new Map(
      agentIds.map((agentId) => [
        agentId,
        summarize(rows.filter((row) => row.agentId === agentId)),
      ]),
    ),
  };
}

/** One collection owns each physical store's bounded snapshot, including its agent windows. */
export function createStatusSessionStoreReader(
  agentIds: readonly string[],
  recentLimit: number,
  options: {
    projection?: SessionRowProjection;
    readSummary?: typeof readSessionStoreSummaryReadOnly;
    recoverReadError?: (error: unknown) => SessionStoreSummary;
  } = {},
) {
  const readSummary = options.readSummary ?? readSessionStoreSummaryReadOnly;
  const stores = new Map<string, SessionStoreSummary>();
  let projectionReady: Promise<void> | undefined;
  const ensureProjectionReady = async () => {
    const projection = options.projection;
    if (!projection) {
      return;
    }
    projectionReady ??= (async () => {
      do {
        await projection.ensureMaterialized();
      } while (projection.needsMaterialization);
    })();
    await projectionReady;
  };
  let sliceStartedAt = performance.now();
  return {
    stores,
    async read(storePath: string, agentId?: string) {
      const path = resolveSqliteTargetFromSessionStorePath(storePath, { agentId }).path;
      if (agentId && readAgentDatabaseAdmissionRefusal(agentId)) {
        return { path, count: 0, recent: [] };
      }
      let store = stores.get(path);
      if (!store) {
        try {
          await ensureProjectionReady();
          store = options.projection
            ? summarizeProjectionRows(options.projection, path, agentIds, recentLimit)
            : readSummary(
                { ...(agentId ? { agentId } : {}), storePath },
                { agentIds, recentLimit },
              );
        } catch (error) {
          if (!options.recoverReadError) {
            throw error;
          }
          store = options.recoverReadError(error);
        }
        stores.set(path, store);
        // Transactions finish before yielding. Cheap reads share a slice so competing
        // background work cannot add a full event-loop turn to every physical store.
        if (performance.now() - sliceStartedAt >= SESSION_STORE_READ_SLICE_MS) {
          await yieldToEventLoop();
          sliceStartedAt = performance.now();
        }
      }
      const summary = agentId ? store.byAgent.get(agentId) : store;
      return { path, count: summary?.count ?? 0, recent: summary?.recent ?? [] };
    },
  };
}

/** Reads each physical store once, retaining retired agent namespaces in the aggregate. */
export async function readStatusSessionStores<Agent extends { id: string; name?: string }>(
  cfg: OpenClawConfig,
  agents: readonly Agent[],
  recentLimit: number,
  projection?: SessionRowProjection,
) {
  const reader = createStatusSessionStoreReader(
    agents.map((agent) => agent.id),
    recentLimit,
    { projection },
  );
  const byAgent = [];
  for (const agent of agents) {
    byAgent.push({
      agent,
      ...(await reader.read(
        resolveSessionStorePathCore(cfg.session?.store, { agentId: agent.id }),
        agent.id,
      )),
    });
  }
  return {
    paths: [...reader.stores.keys()],
    count: [...reader.stores.values()].reduce((count, store) => count + store.count, 0),
    recent: [...reader.stores.values()].flatMap((store) => store.recent),
    byAgent,
  };
}
