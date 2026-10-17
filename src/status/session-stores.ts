import { performance } from "node:perf_hooks";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { withSessionStoreReaderInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { SessionHistoryWorkerDatabase } from "../config/sessions/session-transcript-worker.types.js";
import { captureSessionTranscriptStorageEnvironment } from "../config/sessions/transcript-target-binding.js";
import type { OpenClawConfig } from "../config/types.js";
import type { listGatewayAgentsBasic } from "../gateway/agent-list.js";
import type { SessionRowProjection } from "../gateway/session-row-projection.js";
import {
  AgentDatabaseAdmissionError,
  readAgentDatabaseAdmissionRefusal,
} from "../state/agent-database-admission.js";

export const STATUS_RECENT_SESSION_LIMIT = 10;
const SESSION_STORE_READ_SLICE_MS = 8;
type SessionStoreSummary = Awaited<ReturnType<SessionHistoryWorkerDatabase["readStoreSummary"]>>;
export type StatusSessionStores = Awaited<
  ReturnType<
    typeof readStatusSessionStores<
      Awaited<ReturnType<typeof listGatewayAgentsBasic>>["agents"][number]
    >
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
    recoverReadError?: (error: unknown) => SessionStoreSummary;
  } = {},
) {
  const env = captureSessionTranscriptStorageEnvironment(process.env);
  const stores = new Map<string, SessionStoreSummary & { path: string }>();
  let sliceStartedAt = performance.now();
  return {
    stores,
    async read(storePath: string, agentId?: string) {
      const projection = options.projection;
      if (projection) {
        if (agentId && readAgentDatabaseAdmissionRefusal(agentId, { env })) {
          return { path: storePath, count: 0, recent: [] };
        }
        try {
          do {
            await projection.prepareSelection();
          } while (projection.needsSelectionPreparation());
          const state = projection.state;
          const admitted = state.scope({ agentId }).paths;
          const paths = state
            .physicalStorePaths(storePath, agentId)
            .filter((path) => admitted.has(path));
          const selected = paths.map((path) => {
            let store = stores.get(path);
            if (!store) {
              let snapshot: SessionStoreSummary;
              try {
                snapshot = summarizeProjectionRows(projection, path, agentIds, recentLimit);
              } catch (error) {
                if (!options.recoverReadError) {
                  throw error;
                }
                snapshot = options.recoverReadError(error);
              }
              store = { ...snapshot, path };
            }
            return store;
          });
          const summaries = selected.map((store) => (agentId ? store.byAgent.get(agentId) : store));
          let recent = summaries.flatMap((summary) => summary?.recent ?? []);
          if (selected.length > 1) {
            recent.sort(
              (left, right) =>
                (right.entry.updatedAt ?? 0) - (left.entry.updatedAt ?? 0) ||
                (left.sessionKey < right.sessionKey
                  ? -1
                  : left.sessionKey > right.sessionKey
                    ? 1
                    : 0),
            );
            recent = recent.slice(0, recentLimit);
          }
          const summary = {
            path: paths.length === 1 ? paths[0]! : storePath,
            count: summaries.reduce((count, store) => count + (store?.count ?? 0), 0),
            recent,
          };
          if (performance.now() - sliceStartedAt >= SESSION_STORE_READ_SLICE_MS) {
            await yieldToEventLoop();
            sliceStartedAt = performance.now();
          }
          if (agentId && readAgentDatabaseAdmissionRefusal(agentId, { env })) {
            return { path: summary.path, count: 0, recent: [] };
          }
          for (const store of selected) {
            stores.set(store.path, store);
          }
          return summary;
        } catch (error) {
          if (!options.recoverReadError) {
            throw error;
          }
          const recovered = options.recoverReadError(error);
          const summary = agentId ? recovered.byAgent.get(agentId) : recovered;
          return { path: storePath, count: summary?.count ?? 0, recent: summary?.recent ?? [] };
        }
      }
      return withSessionStoreReaderInWorker(
        { storePath, agentId, env },
        async ({ reader, database, selectedStore, continuation, assertCurrent }) => {
          const path = selectedStore.path;
          if (agentId && readAgentDatabaseAdmissionRefusal(agentId, { env })) {
            return { path, count: 0, recent: [] };
          }
          let store = stores.get(database.path);
          if (!store) {
            let summary: SessionStoreSummary;
            try {
              summary = await reader.readStoreSummary({
                env: database.env,
                agentIds,
                recentLimit,
                continuation,
              });
            } catch (error) {
              if (
                error instanceof AgentDatabaseAdmissionError &&
                agentId === error.refusal.agentId &&
                readAgentDatabaseAdmissionRefusal(agentId, { env })
              ) {
                assertCurrent();
                return { path, count: 0, recent: [] };
              }
              if (!options.recoverReadError) {
                throw error;
              }
              summary = options.recoverReadError(error);
            }
            assertCurrent();
            if (agentId && readAgentDatabaseAdmissionRefusal(agentId, { env })) {
              return { path, count: 0, recent: [] };
            }
            store = { ...summary, path };
            stores.set(database.path, store);
          }
          const summary = agentId ? store.byAgent.get(agentId) : store;
          return { path, count: summary?.count ?? 0, recent: summary?.recent ?? [] };
        },
        { backing: true, dataOnly: true, logical: {} },
      );
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
    paths: [...reader.stores.values()].map((store) => store.path),
    count: [...reader.stores.values()].reduce((count, store) => count + store.count, 0),
    recent: [...reader.stores.values()].flatMap((store) => store.recent),
    byAgent,
  };
}
