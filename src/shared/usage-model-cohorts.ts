import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { UsageDailyBucket } from "../infra/session-cost-usage.types.js";
import {
  createUsageAggregateAccumulator,
  UNKNOWN_USAGE_CREATOR_KEY,
  usageDailyModelIdentity,
  usageModelIdentity,
} from "./usage-aggregates.js";
import { buildUsageOverview, getSessionModels } from "./usage-overview.js";
import { extractQueryTerms } from "./usage-query.js";
import type {
  SessionUsageEntry,
  SessionsUsageAggregates,
  SessionsUsageOverview,
  UsageOverviewOptions,
  UsageOverviewSlice,
} from "./usage-types.js";

type AggregateOrder = Map<string, number>;

type Cohort = {
  models: string[];
  indices: number[];
  report: UsageOverviewSlice;
  order: AggregateOrder;
};

/** Retained only by the existing scoped, revision-bound Usage snapshot cache. */
export type UsageModelCohorts = {
  sessionCount: number;
  cohorts: Cohort[];
  filterOptions: SessionsUsageOverview["filterOptions"];
};

export type UsageModelCohortQuery = {
  cohorts: Cohort[];
  filterOptions: SessionsUsageOverview["filterOptions"];
  unfilteredSessionCount: number;
  order: AggregateOrder;
};

/** Whole-session cohorts make model alternatives disjoint, including multi-model sessions. */
export function prepareUsageModelCohorts(
  rows: SessionUsageEntry[],
  dayBucket: UsageDailyBucket,
): UsageModelCohorts {
  const groups = new Map<string, Omit<Cohort, "report">>();
  let position = 0;
  for (const [index, row] of rows.entries()) {
    const models = [...new Set(getSessionModels(row))].toSorted();
    const key = JSON.stringify(models);
    const group: Omit<Cohort, "report"> = groups.get(key) ?? {
      models,
      indices: [],
      order: new Map(),
    };
    group.indices.push(index);
    groups.set(key, group);
    const rank = (aggregateKey: string) => {
      if (!group.order.has(aggregateKey)) {
        group.order.set(aggregateKey, position);
      }
      position++;
    };
    for (const model of row.usage?.modelUsage ?? []) {
      rank(`model:${usageModelIdentity(model.provider, model.model)}`);
      rank(`provider:${model.provider ?? "unknown"}`);
    }
    if (row.usage && row.agentId) {
      rank(`agent:${row.agentId}`);
    }
    if (row.usage && row.channel) {
      rank(`channel:${row.channel}`);
    }
    if (row.usage) {
      rank(`creator:${row.creatorKey ?? UNKNOWN_USAGE_CREATOR_KEY}`);
    }
    for (const tool of row.usage?.toolUsage?.tools ?? []) {
      rank(`tool:${tool.name}`);
    }
    for (const day of row.usage?.dailyModelUsage ?? []) {
      rank(`day:${usageDailyModelIdentity(day.date, day.provider, day.model)}`);
    }
  }
  const cohorts = [...groups.values()].map(({ models, indices, order }): Cohort => ({
    models,
    indices,
    order,
    report: buildUsageOverview({
      rows: indices.map((index) => rows[index]!),
      options: { limit: 0 },
      dayBucket,
    }),
  }));
  const filterOptions: SessionsUsageOverview["filterOptions"] = {
    agent: [],
    channel: [],
    provider: [],
    model: [],
    tool: [],
  };
  for (const key of ["agent", "channel", "provider", "model", "tool"] as const) {
    filterOptions[key] = [
      ...new Set(cohorts.flatMap(({ report }) => report.overview.filterOptions[key])),
    ].toSorted();
  }
  return {
    sessionCount: rows.length,
    cohorts,
    filterOptions,
  };
}

/** Other predicates and selections retain the existing general report path. */
export function selectUsageModelCohorts(
  prepared: UsageModelCohorts,
  options: UsageOverviewOptions,
): (UsageModelCohortQuery & { indices: number[] }) | undefined {
  if (
    options.selectedDays?.length ||
    options.selectedHours?.length ||
    options.selectedSessions?.length ||
    options.recentKeys !== undefined
  ) {
    return undefined;
  }
  const terms = extractQueryTerms(options.query ?? "");
  if (
    terms.some(
      (term) =>
        normalizeLowercaseStringOrEmpty(term.key) !== "model" ||
        !normalizeLowercaseStringOrEmpty(term.value),
    )
  ) {
    return undefined;
  }
  const values = terms.map((term) => normalizeLowercaseStringOrEmpty(term.value));
  const selected = prepared.cohorts.filter(
    (cohort) =>
      !values.length ||
      values.some((value) => cohort.models.some((model) => model.includes(value))),
  );
  // Preserve input order before the stable table sort, including equal labels and costs.
  const indices = selected.flatMap((cohort) => cohort.indices).toSorted((a, b) => a - b);
  const order: AggregateOrder = new Map();
  for (const cohort of selected) {
    for (const [key, rank] of cohort.order) {
      order.set(key, Math.min(order.get(key) ?? Infinity, rank));
    }
  }
  return {
    cohorts: selected,
    indices,
    filterOptions: prepared.filterOptions,
    unfilteredSessionCount: prepared.sessionCount,
    order,
  };
}

// Legacy missing-as-unknown groups and creator labels keep their first selected source.
function restoreFirstMetadata(aggregates: SessionsUsageAggregates, query: UsageModelCohortQuery) {
  const models = new Map(
    aggregates.byModel.map((row) => [usageModelIdentity(row.provider, row.model), row]),
  );
  const providers = new Map(aggregates.byProvider.map((row) => [row.provider ?? "unknown", row]));
  const creators = new Map((aggregates.byCreator ?? []).map((row) => [row.key, row]));
  const days = new Map(
    (aggregates.modelDaily ?? []).map((row) => [
      usageDailyModelIdentity(row.date, row.provider, row.model),
      row,
    ]),
  );
  for (const cohort of query.cohorts) {
    const first = (key: string) => cohort.order.get(key) === query.order.get(key);
    for (const row of cohort.report.aggregates.byModel) {
      const key = usageModelIdentity(row.provider, row.model);
      if (first(`model:${key}`)) {
        Object.assign(models.get(key)!, { provider: row.provider, model: row.model });
      }
    }
    for (const row of cohort.report.aggregates.byProvider) {
      const key = row.provider ?? "unknown";
      if (first(`provider:${key}`)) {
        providers.get(key)!.provider = row.provider;
      }
    }
    for (const row of cohort.report.aggregates.byCreator ?? []) {
      if (!first(`creator:${row.key}`)) {
        continue;
      }
      const target = creators.get(row.key)!;
      if (row.actor) {
        target.actor = row.actor;
      } else {
        delete target.actor;
      }
    }
    for (const row of cohort.report.aggregates.modelDaily ?? []) {
      const key = usageDailyModelIdentity(row.date, row.provider, row.model);
      if (first(`day:${key}`)) {
        Object.assign(days.get(key)!, { provider: row.provider, model: row.model });
      }
    }
  }
}

/** The worker merges prepared buckets; no matching row's usage is aggregated again. */
export function buildUsageModelCohortReport(
  query: UsageModelCohortQuery,
  options: UsageOverviewOptions,
  dayBucket: UsageDailyBucket,
  page: SessionUsageEntry[],
): UsageOverviewSlice {
  const accumulator = createUsageAggregateAccumulator();
  const overview = buildUsageOverview({ rows: [], options, dayBucket }).overview;
  for (const { report } of query.cohorts) {
    accumulator.merge(report);
    const source = report.overview;
    overview.total += source.total;
    overview.selectedRowCount += source.selectedRowCount;
    overview.tableSessionCount += source.tableSessionCount;
    overview.tableTotals.tokens += source.tableTotals.tokens;
    overview.tableTotals.cost += source.tableTotals.cost;
    overview.tableTotals.errors += source.tableTotals.errors;
    overview.durationMs += source.durationMs;
    overview.durationCount += source.durationCount;
    overview.hasTimelineData ||= source.hasTimelineData;
    for (const key of ["hourTokens", "weekdayTokens", "hourlyMessages", "hourlyErrors"] as const) {
      for (let index = 0; index < overview[key].length; index++) {
        overview[key][index]! += source[key][index]!;
      }
    }
  }
  const aggregates = accumulator.finish();
  restoreFirstMetadata(aggregates, query);
  // Existing summaries resolve equal metric values by first source occurrence.
  const rank = (key: string) => query.order.get(key) ?? 0;
  const modelMetric = (a: { totals: { totalCost: number; totalTokens: number } }, b: typeof a) =>
    b.totals.totalCost - a.totals.totalCost || b.totals.totalTokens - a.totals.totalTokens;
  aggregates.byModel.sort(
    (a, b) =>
      modelMetric(a, b) ||
      rank(`model:${usageModelIdentity(a.provider, a.model)}`) -
        rank(`model:${usageModelIdentity(b.provider, b.model)}`),
  );
  aggregates.byProvider.sort(
    (a, b) =>
      modelMetric(a, b) ||
      rank(`provider:${a.provider ?? "unknown"}`) - rank(`provider:${b.provider ?? "unknown"}`),
  );
  aggregates.byAgent.sort(
    (a, b) =>
      b.totals.totalCost - a.totals.totalCost ||
      rank(`agent:${a.agentId}`) - rank(`agent:${b.agentId}`),
  );
  aggregates.byChannel.sort(
    (a, b) =>
      b.totals.totalCost - a.totals.totalCost ||
      rank(`channel:${a.channel}`) - rank(`channel:${b.channel}`),
  );
  aggregates.tools.tools.sort(
    (a, b) => b.count - a.count || rank(`tool:${a.name}`) - rank(`tool:${b.name}`),
  );
  aggregates.modelDaily?.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      b.cost - a.cost ||
      rank(`day:${usageDailyModelIdentity(a.date, a.provider, a.model)}`) -
        rank(`day:${usageDailyModelIdentity(b.date, b.provider, b.model)}`),
  );
  overview.selectedSessionCount = aggregates.sessionCount ?? 0;
  overview.unfilteredSessionCount = query.unfilteredSessionCount;
  overview.filterOptions = query.filterOptions;
  return {
    totals: accumulator.totals,
    aggregates,
    overview,
    sessions: page,
  };
}
