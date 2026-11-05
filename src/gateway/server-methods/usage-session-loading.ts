import { expectDefined } from "@openclaw/normalization-core";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { racePromiseWithAbortSignal } from "../../../packages/retry/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { UsageOverviewLoad } from "../../infra/session-cost-usage-overview-load.js";
import { createSessionCostSummaryAccumulator } from "../../infra/session-cost-usage-rollup.js";
import {
  discoverAllSessions,
  loadSessionCostSummariesFromCache,
  loadSessionUsageOverviewFromCache,
  type DiscoveredSession,
  type SessionCostSummary,
  type UsageDailyBucket,
  type UsageCacheStatus,
} from "../../infra/session-cost-usage.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { readWithSessionStoreTopology } from "../../sessions/session-row-changes.js";
import {
  AsyncWorkScope,
  getAsyncWorkSignal,
  trackAsyncWork,
} from "../../shared/async-work-scope.js";
import { monotonicNow } from "../../shared/monotonic-time.js";
import type { SessionUsageEntry } from "../../shared/usage-types.js";
import { runTasksWithConcurrency } from "../../utils/run-with-concurrency.js";
import { listGatewayAgentsBasic } from "../agent-list.js";
import type { GatewayRequestHandlers } from "./types.js";
import { usageOverviewRowKey, type UsageOverviewUsage } from "./usage-overview-report.js";

type DiscoveredSessionWithAgent = DiscoveredSession & { agentId: string };

export type UsageSessionSummaryTarget = {
  agentId: string;
  sessionId: string;
  sessionFile: string;
  instances: Array<Pick<DiscoveredSession, "sessionId" | "sessionFile">>;
};

const USAGE_AGENT_LOAD_CONCURRENCY = 12;
const USAGE_REPORT_PUBLICATION_WAIT_MS = 100;
const USAGE_REPORT_BATCH_SIZE = 256;

export async function runUsageAgentTasks<T>(tasks: Array<() => Promise<T>>): Promise<T[]> {
  const result = await runTasksWithConcurrency({
    tasks,
    limit: USAGE_AGENT_LOAD_CONCURRENCY,
    errorMode: "stop",
  });
  // These fan-outs historically rejected as one unit. Never return partial
  // per-agent usage; successful results retain their input order.
  if (result.hasError) {
    throw result.firstError;
  }
  return result.results;
}

export async function discoverAllSessionsForUsage(params: {
  config: OpenClawConfig;
  agentId?: string;
  startMs: number;
  endMs: number;
}): Promise<DiscoveredSessionWithAgent[]> {
  return readWithSessionStoreTopology(async () => {
    const requestedAgentId = normalizeOptionalString(params.agentId);
    const agents = requestedAgentId
      ? [{ id: normalizeAgentId(requestedAgentId) }]
      : (await listGatewayAgentsBasic(params.config)).agents;
    const discovered = await runUsageAgentTasks(
      agents.map((agent) => async () => {
        const agentId = normalizeAgentId(agent.id);
        const sessions = await discoverAllSessions({
          agentId,
          startMs: params.startMs,
          endMs: params.endMs,
        });
        return sessions.map((session) => Object.assign({}, session, { agentId }));
      }),
    );
    // oxlint-disable-next-line unicorn/no-array-sort -- flat returns a fresh, private array.
    return discovered.flat().sort((a, b) => b.mtime - a.mtime);
  });
}

export function mergeUsageCacheStatus(
  target: UsageCacheStatus | undefined,
  source: UsageCacheStatus,
): UsageCacheStatus {
  if (!target) {
    return { ...source };
  }
  const statusRank = { fresh: 0, partial: 1, stale: 2, refreshing: 3 } as const;
  return {
    status: statusRank[source.status] > statusRank[target.status] ? source.status : target.status,
    cachedFiles: target.cachedFiles + source.cachedFiles,
    pendingFiles: target.pendingFiles + source.pendingFiles,
    staleFiles: target.staleFiles + source.staleFiles,
    refreshedAt:
      target.refreshedAt === undefined
        ? source.refreshedAt
        : source.refreshedAt === undefined
          ? target.refreshedAt
          : Math.max(target.refreshedAt, source.refreshedAt),
    ...((target.partial ?? source.partial) ? { partial: target.partial ?? source.partial } : {}),
  };
}

export async function loadUsageSessionSummaries(params: {
  entries: UsageSessionSummaryTarget[];
  read: <T>(load: () => Promise<T>, partial: () => T) => Promise<T>;
  config: OpenClawConfig;
  startMs: number;
  endMs: number;
  includeUntimestamped?: boolean;
  dayBucket?: UsageDailyBucket;
}) {
  const {
    entries: mergedEntries,
    config,
    startMs,
    endMs,
    includeUntimestamped,
    dayBucket,
  } = params;
  let cacheStatus: UsageCacheStatus | undefined;
  const usageByEntryIndex: Array<SessionCostSummary | null> = Array.from(
    { length: mergedEntries.length },
    () => null,
  );

  const computing = Array<boolean>(mergedEntries.length).fill(false);

  // Batch all included instances by agent so cache reads do not scale with the row limit.
  const sessionsByAgent = new Map<
    string,
    Array<UsageSessionSummaryTarget["instances"][number] & { entryIndex: number }>
  >();
  for (const [entryIndex, merged] of mergedEntries.entries()) {
    for (const { sessionId, sessionFile } of merged.instances) {
      const agentSessions = sessionsByAgent.get(merged.agentId) ?? [];
      agentSessions.push({
        entryIndex,
        sessionId,
        sessionFile,
      });
      sessionsByAgent.set(merged.agentId, agentSessions);
    }
  }

  await runUsageAgentTasks(
    Array.from(sessionsByAgent.entries()).map(([agentId, agentSessions]) => async () => {
      let usage: ReturnType<typeof createSessionCostSummaryAccumulator> | undefined;
      let reportBudgetBytes: number | undefined;
      const publicationDeadline = monotonicNow() + USAGE_REPORT_PUBLICATION_WAIT_MS;
      for (let offset = 0; offset < agentSessions.length;) {
        // Concurrent reports share the worker pool's input-byte budget.
        const batch = agentSessions.slice(offset, offset + USAGE_REPORT_BATCH_SIZE);
        const loaded = await params.read(
          () =>
            loadSessionCostSummariesFromCache({
              sessions: batch,
              config,
              agentId,
              startMs,
              endMs,
              includeUntimestamped,
              dayBucket,
              maxPublicationWaitMs: Math.max(0, publicationDeadline - monotonicNow()),
              reportBudgetBytes,
            }),
          () => ({
            summaries: batch.map(() => null),
            remainingReportBytes: 0,
            cacheStatus: {
              status: "partial" as const,
              cachedFiles: 0,
              pendingFiles: batch.length,
              staleFiles: 0,
            },
          }),
        );
        reportBudgetBytes = loaded.remainingReportBytes;
        cacheStatus = mergeUsageCacheStatus(cacheStatus, loaded.cacheStatus);
        for (const [index, summary] of loaded.summaries.entries()) {
          const session = expectDefined(batch[index], "usage batch entry");
          if (!summary) {
            computing[session.entryIndex] = true;
          }
          if (summary) {
            const merged = expectDefined(mergedEntries[session.entryIndex], "usage entry");
            const identity = {
              sessionId: merged.sessionId,
              sessionFile: merged.sessionFile,
            };
            if (merged.instances.length === 1) {
              usageByEntryIndex[session.entryIndex] = { ...summary, ...identity };
              continue;
            }
            usage ??= createSessionCostSummaryAccumulator(identity);
            usage.add(summary);
          }
          // Families may span batches; retain their completed subtotal when later reads time out.
          if (usage && agentSessions[offset + index + 1]?.entryIndex !== session.entryIndex) {
            usageByEntryIndex[session.entryIndex] = usage.finish();
            usage = undefined;
          }
        }
        offset += batch.length;
      }
    }),
  );

  return { summaries: usageByEntryIndex, computing, cacheStatus };
}

/**
 * Overview usage per entry: private sessions return summaries, quarter folds stay
 * packed and each entry references its row for the off-thread overview report.
 */
export async function loadUsageOverviewSummaries(params: {
  entries: Array<UsageSessionSummaryTarget & { key: string }>;
  read: <T>(load: () => Promise<T>, partial: () => T) => Promise<T>;
  config: OpenClawConfig;
  startMs: number;
  endMs: number;
  includeUntimestamped?: boolean;
  dayBucket?: UsageDailyBucket;
}) {
  const summaries: Array<SessionUsageEntry["usage"]> = Array.from(
    { length: params.entries.length },
    () => null,
  );
  const usage: UsageOverviewUsage = { packed: [], refs: new Map() };
  const computing = Array<boolean>(params.entries.length).fill(false);
  const byAgent = new Map<string, number[]>();
  for (const [index, entry] of params.entries.entries()) {
    const indexes = byAgent.get(entry.agentId) ?? [];
    indexes.push(index);
    byAgent.set(entry.agentId, indexes);
  }
  let cacheStatus: UsageCacheStatus | undefined;
  let summarizing = 0;
  let instances = 0;
  await runUsageAgentTasks(
    Array.from(byAgent, ([agentId, indexes]) => async () => {
      const families = indexes.map((index) => params.entries[index]!.instances);
      const count = families.reduce((sum, family) => sum + family.length, 0);
      const loaded = await params.read(
        () =>
          loadSessionUsageOverviewFromCache({
            families,
            config: params.config,
            agentId,
            startMs: params.startMs,
            endMs: params.endMs,
            includeUntimestamped: params.includeUntimestamped,
            dayBucket: params.dayBucket,
          }),
        (): UsageOverviewLoad => ({
          kind: "overview",
          usage: { kind: "rows", rows: families.map(() => null) },
          computing: families.map(() => true),
          summarizing: count,
          staleSessionFiles: [],
          invalidRows: [],
          cacheStatus: {
            status: "partial",
            cachedFiles: 0,
            pendingFiles: count,
            staleFiles: 0,
          },
        }),
      );
      instances += count;
      summarizing += loaded.summarizing;
      cacheStatus = mergeUsageCacheStatus(cacheStatus, loaded.cacheStatus);
      const loadedUsage = loaded.usage;
      const packedIndex = loadedUsage.kind === "packed" ? usage.packed.push(loadedUsage) - 1 : -1;
      for (const [position, index] of indexes.entries()) {
        const entry = params.entries[index]!;
        let present: boolean;
        if (loadedUsage.kind === "packed") {
          present = loadedUsage.batch.offsets[position]! >= 0;
          if (present) {
            usage.refs.set(usageOverviewRowKey(entry), [packedIndex, position]);
          }
        } else {
          const row = loadedUsage.rows[position];
          summaries[index] = row
            ? Object.assign(row, { sessionId: entry.sessionId, sessionFile: entry.sessionFile })
            : null;
          present = Boolean(row);
        }
        computing[index] = loaded.computing[position] === true || !present;
      }
    }),
  );
  return { summaries, usage, computing, cacheStatus, summarizing, instances };
}

type UsageRequestBudget = {
  hint: string;
  exhausted: () => boolean;
  read: <T>(load: () => Promise<T>, partial: () => T) => Promise<T>;
};

const USAGE_BUDGET_HINT =
  "Usage request exceeded its 15-second budget; narrow the date range or select a session.";

export function withUsageRequestBudget(
  handler: (
    request: Parameters<GatewayRequestHandlers[string]>[0],
    budget: UsageRequestBudget,
  ) => Promise<void>,
): GatewayRequestHandlers[string] {
  return async (request) => {
    const parent = AbortSignal.any(
      [getAsyncWorkSignal(), request.signal].filter(
        (signal): signal is AbortSignal => signal !== undefined,
      ),
    );
    const caller = new AsyncWorkScope();
    const data = new AsyncWorkScope();
    const exhausted = new Error(USAGE_BUDGET_HINT);
    const cancel = () => {
      caller.beginClose(parent.reason);
      data.beginClose(parent.reason);
    };
    const timer = setTimeout(() => data.beginClose(exhausted), 15_000).unref();
    parent.addEventListener("abort", cancel, { once: true });
    if (parent.aborted) {
      cancel();
    }
    const budget: UsageRequestBudget = {
      hint: USAGE_BUDGET_HINT,
      exhausted: () => data.signal.reason === exhausted,
      async read(load, partial) {
        caller.signal.throwIfAborted();
        if (budget.exhausted()) {
          return partial();
        }
        try {
          const result = await racePromiseWithAbortSignal(
            () => data.track(load),
            data.signal,
            (signal) => signal.reason,
          );
          caller.signal.throwIfAborted();
          data.signal.throwIfAborted();
          return result;
        } catch (error) {
          caller.signal.throwIfAborted();
          if (!budget.exhausted()) {
            throw error;
          }
          return partial();
        }
      },
    };
    try {
      // Budget cancellation stops data work, not the live authority needed to publish its subtotal.
      await trackAsyncWork(() => caller.track(() => handler(request, budget)));
    } finally {
      clearTimeout(timer);
      void trackAsyncWork(() =>
        AsyncWorkScope.runWhenAllIdle(
          () => [data, caller],
          async () => {
            await data.drain();
            await caller.drain();
          },
        ),
      ).finally(() => parent.removeEventListener("abort", cancel));
    }
  };
}
