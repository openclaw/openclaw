import { performance } from "node:perf_hooks";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { WorkerTaskError } from "@openclaw/worker-runtime";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { withSessionStoreReaderInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { SessionHistoryWorkerDatabase } from "../config/sessions/session-transcript-worker.types.js";
import { captureSessionTranscriptStorageEnvironment } from "../config/sessions/transcript-target-binding.js";
import type { OpenClawConfig } from "../config/types.js";
import type { listGatewayAgentsBasic } from "../gateway/agent-list.js";
import type { SessionRowProjection } from "../gateway/session-row-projection.js";
import { AgentDatabaseExecutionAdmissionClosedError } from "../state/agent-database-admission-error.js";
import {
  AgentDatabaseAdmissionError,
  readAgentDatabaseAdmissionRefusal,
} from "../state/agent-database-admission.js";
import {
  getPreparedAgentDeletionDiscovery,
  getOrLoadAgentDeletionJournalStatus,
} from "../state/agent-deletion-journal-status.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";

export const STATUS_RECENT_SESSION_LIMIT = 10;
const SESSION_STORE_READ_SLICE_MS = 8;
type SessionStoreSummary = Awaited<ReturnType<SessionHistoryWorkerDatabase["readStoreSummary"]>>;
const projectionSummaries = new WeakMap<
  SessionRowProjection,
  { revision: object; windows: Map<number, Map<string, SessionStoreSummary>> }
>();
export type PreparedStatusSessionStores = Awaited<
  ReturnType<
    typeof prepareStatusSessionStores<
      Awaited<ReturnType<typeof listGatewayAgentsBasic>>["agents"][number]
    >
  >
>;

export type StatusSessionStores = ReturnType<PreparedStatusSessionStores["publish"]>;

type SessionStoreReadOptions = {
  projection?: SessionRowProjection;
  recoverReadError?: (error: unknown) => SessionStoreSummary;
  fallbackToUnscopedStore?: boolean;
};

function compareSessionRows(
  left: SessionStoreSummary["recent"][number],
  right: SessionStoreSummary["recent"][number],
) {
  return (
    (right.entry.updatedAt ?? 0) - (left.entry.updatedAt ?? 0) ||
    (left.sessionKey < right.sessionKey ? -1 : left.sessionKey > right.sessionKey ? 1 : 0)
  );
}

function summarizeProjectionRows(
  projection: SessionRowProjection,
  storePath: string,
  recentLimit: number,
): SessionStoreSummary {
  const revision = projection.state.revision;
  let retained = projectionSummaries.get(projection);
  if (retained?.revision !== revision) {
    retained = { revision, windows: new Map() };
    projectionSummaries.set(projection, retained);
  }
  let stores = retained.windows.get(recentLimit);
  const cached = stores?.get(storePath);
  if (cached) {
    return cached;
  }
  const rows = projection.selectEntries({ storePath, sortBy: null });
  // Keep each namespace's candidates until the publisher selects surviving windows.
  if (recentLimit !== 0) {
    rows.sort(
      (left, right) =>
        (right.entry.updatedAt ?? 0) - (left.entry.updatedAt ?? 0) ||
        (left.key < right.key ? -1 : left.key > right.key ? 1 : 0),
    );
  }
  const byAgent: SessionStoreSummary["byAgent"] = new Map();
  for (const row of rows) {
    let agent = byAgent.get(row.agentId);
    if (!agent) {
      agent = { count: 0, recent: [] };
      byAgent.set(row.agentId, agent);
    }
    agent.count += 1;
    if (recentLimit < 0 || agent.recent.length < recentLimit) {
      agent.recent.push({ sessionKey: row.key, entry: row.entry });
    }
  }
  const summary: SessionStoreSummary = { count: rows.length, recent: [], byAgent };
  // Selection can acquire dirty entries; retain only a stable owner revision.
  if (projection.state.revision === revision) {
    if (!stores) {
      retained.windows.set(recentLimit, (stores = new Map()));
    }
    stores.set(storePath, summary);
  }
  return summary;
}

/** One collection owns each physical store's bounded snapshot, including its agent windows. */
function createStatusSessionStoreReader(
  agentIds: readonly string[],
  recentLimit: number,
  options: SessionStoreReadOptions = {},
) {
  const env = captureSessionTranscriptStorageEnvironment(process.env);
  const stores = new Map<string, SessionStoreSummary & { path: string }>();
  const statePath = resolveOpenClawStateSqlitePath(env);
  const readStatus = (agentId: string) =>
    getOrLoadAgentDeletionJournalStatus(statePath, agentId, () => undefined);
  let sliceStartedAt = performance.now();
  return {
    stores,
    readDeletedAgents(contributors: Iterable<string>) {
      const discovery = getPreparedAgentDeletionDiscovery(statePath);
      const deleted = new Set(
        discovery?.status === "present" ? discovery.entries.map(({ agentId }) => agentId) : [],
      );
      for (const agentId of contributors) {
        const status = readStatus(agentId);
        if (status === "pending" || status === "complete") {
          deleted.add(agentId);
        }
      }
      return deleted;
    },

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
                snapshot = summarizeProjectionRows(projection, path, recentLimit);
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
          const recent = summaries.flatMap((summary) => summary?.recent ?? []);
          if (selected.length > 1) {
            recent.sort(compareSessionRows);
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
                recentLimit: recentLimit < 0 ? Infinity : recentLimit,
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

/** Prepares physical snapshots; only the final synchronous publisher selects live contributions. */
export async function prepareStatusSessionStores<Agent extends { id: string; name?: string }>(
  cfg: OpenClawConfig,
  agents: readonly Agent[],
  recentLimit: number,
  options: SessionStoreReadOptions = {},
) {
  const reader = createStatusSessionStoreReader(
    agents.map((agent) => agent.id),
    recentLimit,
    options,
  );
  const byAgent: Array<
    { agent: Agent; path: string } & Pick<SessionStoreSummary, "count" | "recent">
  > = [];
  for (const agent of agents) {
    try {
      const summary = await reader.read(
        resolveSessionStorePathCore(cfg.session?.store, { agentId: agent.id }),
        agent.id,
      );
      byAgent.push({ agent, ...summary });
    } catch (error) {
      // Only lifecycle interruption of a committed deletion is recoverable here.
      const interrupted =
        error instanceof AgentDatabaseExecutionAdmissionClosedError ||
        (error instanceof WorkerTaskError && error.code === "unavailable");
      if (!interrupted || !reader.readDeletedAgents([agent.id]).has(agent.id)) {
        throw error;
      }
    }
  }
  if (agents.length === 0 && options.fallbackToUnscopedStore) {
    await reader.read(resolveSessionStorePathCore(cfg.session?.store));
  }
  const snapshots = [...reader.stores.values()];
  const contributors = new Set([
    ...agents.map(({ id }) => id),
    ...snapshots.flatMap((store) => [...store.byAgent.keys()]),
  ]);
  return {
    candidates: snapshots.flatMap((store) =>
      [...store.byAgent.values()].flatMap(({ recent }) => recent),
    ),
    publish() {
      const deleted = reader.readDeletedAgents(contributors);
      const stores = snapshots.map((store) => {
        const namespaces = [...store.byAgent].filter(([agentId]) => !deleted.has(agentId));
        return {
          path: store.path,
          count: namespaces.reduce((count, [, namespace]) => count + namespace.count, 0),
          recent: namespaces
            .flatMap(([, namespace]) => namespace.recent)
            .toSorted(compareSessionRows)
            .slice(0, recentLimit),
        };
      });
      return {
        paths: stores.map((store) => store.path),
        count: stores.reduce((count, store) => count + store.count, 0),
        recent: stores.flatMap((store) => store.recent),
        byAgent: byAgent
          .filter(({ agent }) => !deleted.has(agent.id))
          .map((summary) => ({
            agent: summary.agent,
            path: summary.path,
            count: summary.count,
            recent: summary.recent.slice(0, recentLimit),
          })),
      };
    },
  };
}
