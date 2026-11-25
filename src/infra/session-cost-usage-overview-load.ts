import {
  formatSqliteSessionFileMarker,
  parseSqliteSessionFileMarker,
} from "../config/sessions/legacy-sqlite-marker.js";
import type { UsageOverviewSessionSummary } from "../shared/usage-types.js";
import type { UsageOverviewPackedUsage } from "./session-cost-usage-overview-report.js";
import { createSessionCostSummaryAccumulator } from "./session-cost-usage-rollup.js";
import type {
  UsageCostOverviewInstance,
  UsageCostWorkerOperation,
  UsageCostWorkerResult,
  UsageCostWorkerSession,
} from "./session-cost-usage-worker.types.js";

/**
 * Overview worker input with each SQLite store named once. Worker inputs share the
 * pool's input-byte budget; a session's marker otherwise repeats its store path.
 */
export function compactUsageOverviewFamilies(
  families: readonly UsageCostWorkerSession[][],
): Pick<Extract<UsageCostWorkerOperation, { kind: "overview" }>, "families" | "stores"> {
  const stores: Array<{ agentId: string; storePath: string }> = [];
  const storeIndex = new Map<string, number>();
  const compact = (instance: UsageCostWorkerSession): UsageCostOverviewInstance => {
    const marker = parseSqliteSessionFileMarker(instance.sessionFile);
    // Only markers that rebuild to the same cache key travel compactly.
    if (!marker || formatSqliteSessionFileMarker(marker) !== instance.sessionFile) {
      return instance;
    }
    const key = `${marker.agentId}\u0000${marker.storePath}`;
    let index = storeIndex.get(key);
    if (index === undefined) {
      index = stores.length;
      stores.push({ agentId: marker.agentId, storePath: marker.storePath });
      storeIndex.set(key, index);
    }
    return [index, marker.sessionId];
  };
  return { stores, families: families.map((family) => family.map(compact)) };
}

/** Worker-side inverse of `compactUsageOverviewFamilies`. */
export function expandUsageOverviewFamilies(
  operation: Pick<Extract<UsageCostWorkerOperation, { kind: "overview" }>, "families" | "stores">,
): UsageCostWorkerSession[][] {
  return operation.families.map((family) =>
    family.map((instance) =>
      Array.isArray(instance)
        ? {
            sessionId: instance[1],
            sessionFile: formatSqliteSessionFileMarker({
              ...operation.stores[instance[0]]!,
              sessionId: instance[1],
            }),
          }
        : instance,
    ),
  );
}

/** One agent's overview read, as the Gateway's session loader consumes it. */
export type UsageOverviewLoad = Omit<
  Extract<UsageCostWorkerResult, { kind: "overview" }>,
  "batch"
> & {
  /**
   * Quarter folds stay packed for the off-thread overview report; private sessions
   * keep in-memory summaries.
   */
  usage:
    | ({ kind: "packed" } & UsageOverviewPackedUsage)
    | { kind: "rows"; rows: Array<UsageOverviewSessionSummary | null> };
};

/** Overview rows from per-instance summaries (private sessions), one row per family. */
export function foldUsageOverviewFamilies(
  families: UsageCostWorkerSession[][],
  loaded: Pick<
    Extract<UsageCostWorkerResult, { kind: "sessions" }>,
    "summaries" | "cacheStatus" | "staleSessionFiles" | "invalidRows"
  >,
): UsageOverviewLoad {
  let offset = 0;
  const computing: boolean[] = [];
  const rows = families.map((family) => {
    const summaries = loaded.summaries.slice(offset, offset + family.length);
    offset += family.length;
    computing.push(summaries.some((summary) => summary === null));
    const present = summaries.filter((summary) => summary !== null);
    if (present.length <= 1) {
      return present[0] ?? null;
    }
    const usage = createSessionCostSummaryAccumulator(family[0]!);
    present.forEach((summary) => usage.add(summary));
    return usage.finish();
  });
  return {
    kind: "overview",
    usage: { kind: "rows", rows },
    computing,
    summarizing: loaded.cacheStatus.pendingFiles,
    cacheStatus: loaded.cacheStatus,
    staleSessionFiles: loaded.staleSessionFiles,
    invalidRows: loaded.invalidRows,
  };
}
