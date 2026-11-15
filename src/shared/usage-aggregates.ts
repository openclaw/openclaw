import {
  addCostUsageTotals,
  createEmptyCostUsageTotals,
} from "../infra/session-cost-usage-totals.js";
import type {
  CostUsageTotals,
  SessionDailyModelUsage,
  SessionLatencyStats,
  SessionModelUsage,
} from "../infra/session-cost-usage.types.js";
import type { SessionUsageEntry, SessionsUsageAggregates } from "./usage-types.js";

export const UNKNOWN_USAGE_CREATOR_KEY = '["unknown"]';

type LatencyAccumulator = {
  count: number;
  sum: number;
  min: number;
  max: number;
  p95Max: number;
};

type CreatorUsage = NonNullable<SessionsUsageAggregates["byCreator"]>[number];
type CreatorAccumulator = Omit<CreatorUsage, "daily" | "sessionActivity"> & {
  daily: Map<string, CostUsageTotals>;
  sessionActivity: Map<string, CreatorUsage["sessionActivity"][number]>;
};

// Reports repeat a few provider/model pairs across thousands of rows; build each key once.
const modelIdentities = new Map<string, Map<string, string>>();

/** Builds a collision-free identity while preserving legacy missing-as-unknown grouping. */
export function usageModelIdentity(provider?: string, model?: string): string {
  const providerKey = provider ?? "unknown";
  const modelKey = model ?? "unknown";
  let models = modelIdentities.get(providerKey);
  if (!models) {
    models = new Map();
    modelIdentities.set(providerKey, models);
  }
  let identity = models.get(modelKey);
  if (identity === undefined) {
    identity = JSON.stringify([providerKey, modelKey]);
    models.set(modelKey, identity);
  }
  return identity;
}

/** Extends the model identity with its calendar bucket without delimiter ambiguity. */
export function usageDailyModelIdentity(date: string, provider?: string, model?: string): string {
  // Same bytes as JSON.stringify([date, provider, model]).
  return `[${JSON.stringify(date)},${usageModelIdentity(provider, model).slice(1)}`;
}

/** Sorted union of a row's activity dates; usually the lists already agree. */
function sessionActivityDates(usage: NonNullable<SessionUsageEntry["usage"]>): string[] {
  const activity = usage.activityDates ?? [];
  const extra = [
    ...(usage.dailyBreakdown ?? []).map(({ date }) => date),
    ...(usage.dailyMessageCounts ?? []).map(({ date }) => date),
  ];
  const known = new Set(activity);
  if (
    extra.every((date) => known.has(date)) &&
    activity.every((date, i) => i === 0 || activity[i - 1]! < date)
  ) {
    return activity;
  }
  return [...new Set([...activity, ...extra])].toSorted();
}

function createLatencyAccumulator(): LatencyAccumulator {
  return { count: 0, sum: 0, min: Number.POSITIVE_INFINITY, max: 0, p95Max: 0 };
}

// Session summaries carry no raw samples: weight averages by count and retain the largest p95.
function mergeLatency(target: LatencyAccumulator, source: SessionLatencyStats): void {
  target.count += source.count;
  target.sum += source.avgMs * source.count;
  target.min = Math.min(target.min, source.minMs);
  target.max = Math.max(target.max, source.maxMs);
  target.p95Max = Math.max(target.p95Max, source.p95Ms);
}

function summarizeLatency(value: LatencyAccumulator): SessionLatencyStats {
  return {
    count: value.count,
    avgMs: value.count ? value.sum / value.count : 0,
    // Empty daily buckets must not expose the sentinel used for min comparisons.
    minMs: value.min === Number.POSITIVE_INFINITY ? 0 : value.min,
    maxMs: value.max,
    p95Ms: value.p95Max,
  };
}

function mergeModelUsage(
  map: Map<string, SessionModelUsage>,
  key: string,
  entry: SessionModelUsage,
  model: SessionModelUsage["model"],
): void {
  const existing = map.get(key) ?? {
    provider: entry.provider,
    model,
    count: 0,
    totals: createEmptyCostUsageTotals(),
  };
  existing.count += entry.count;
  addCostUsageTotals(existing.totals, entry.totals);
  map.set(key, existing);
}

function mergeGroupedTotals(
  map: Map<string, CostUsageTotals>,
  key: string | undefined,
  usage: CostUsageTotals,
): void {
  if (!key) {
    return;
  }
  const totals = map.get(key) ?? createEmptyCostUsageTotals();
  addCostUsageTotals(totals, usage);
  map.set(key, totals);
}

function compareModelUsage(left: SessionModelUsage, right: SessionModelUsage): number {
  return (
    right.totals.totalCost - left.totals.totalCost ||
    right.totals.totalTokens - left.totals.totalTokens
  );
}

/** Shared accounting for gateway-wide results and filtered Control UI session rows. */
export function createUsageAggregateAccumulator() {
  const totals = createEmptyCostUsageTotals();
  const messages = { total: 0, user: 0, assistant: 0, toolCalls: 0, toolResults: 0, errors: 0 };
  const tools = new Map<string, number>();
  const models = new Map<string, SessionModelUsage>();
  const providers = new Map<string, SessionModelUsage>();
  const agents = new Map<string, CostUsageTotals>();
  const channels = new Map<string, CostUsageTotals>();
  const creators = new Map<string, CreatorAccumulator>();
  const days = new Map<string, SessionsUsageAggregates["daily"][number]>();
  const costDays = new Map<string, CostUsageTotals>();
  const dailyLatency = new Map<string, LatencyAccumulator>();
  const dailyModels = new Map<string, SessionDailyModelUsage>();
  const latency = createLatencyAccumulator();
  let sessionCount = 0;
  let longestSessionDurationMs = 0;

  function getDay(date: string) {
    let day = days.get(date);
    if (!day) {
      day = { date, tokens: 0, cost: 0, messages: 0, toolCalls: 0, errors: 0 };
      days.set(date, day);
    }
    return day;
  }

  function addModelDays(
    usage: Pick<NonNullable<SessionUsageEntry["usage"]>, "dailyModelUsage"> | null,
  ) {
    for (const day of usage?.dailyModelUsage ?? []) {
      const key = usageDailyModelIdentity(day.date, day.provider, day.model);
      const existing: SessionDailyModelUsage = dailyModels.get(key) ?? {
        date: day.date,
        provider: day.provider,
        model: day.model,
        tokens: 0,
        cost: 0,
        count: 0,
      };
      existing.tokens += day.tokens;
      existing.cost += day.cost;
      existing.count += day.count;
      dailyModels.set(key, existing);
    }
  }

  function addCalendar(usage: SessionUsageEntry["usage"]) {
    for (const day of usage?.dailyBreakdown ?? []) {
      mergeGroupedTotals(costDays, day.date, day);
    }
    addModelDays(usage);
  }

  function totalsForDays(selectedDays: ReadonlySet<string>) {
    const selected = createEmptyCostUsageTotals();
    for (const [date, day] of costDays) {
      if (selectedDays.has(date)) {
        addCostUsageTotals(selected, day);
      }
    }
    return selected;
  }

  function add({
    usage,
    agentId,
    channel,
    createdActor,
    creatorKey = UNKNOWN_USAGE_CREATOR_KEY,
  }: Pick<SessionUsageEntry, "usage" | "agentId" | "channel" | "createdActor" | "creatorKey">) {
    if (!usage) {
      return;
    }
    addCostUsageTotals(totals, usage);
    longestSessionDurationMs = Math.max(longestSessionDurationMs, usage.durationMs ?? 0);
    // Discovery can include recently modified transcripts with no activity in the requested range.
    const countedSession =
      usage.firstActivity !== undefined || (usage.messageCounts?.total ?? 0) > 0;
    if (countedSession) {
      sessionCount += 1;
    }
    if (usage.messageCounts) {
      messages.total += usage.messageCounts.total;
      messages.user += usage.messageCounts.user;
      messages.assistant += usage.messageCounts.assistant;
      messages.toolCalls += usage.messageCounts.toolCalls;
      messages.toolResults += usage.messageCounts.toolResults;
      messages.errors += usage.messageCounts.errors;
    }
    for (const tool of usage.toolUsage?.tools ?? []) {
      tools.set(tool.name, (tools.get(tool.name) ?? 0) + tool.count);
    }
    for (const entry of usage.modelUsage ?? []) {
      mergeModelUsage(models, usageModelIdentity(entry.provider, entry.model), entry, entry.model);
      mergeModelUsage(providers, entry.provider ?? "unknown", entry, undefined);
    }
    mergeGroupedTotals(agents, agentId, usage);
    mergeGroupedTotals(channels, channel, usage);
    const creator = creators.get(creatorKey) ?? {
      key: creatorKey,
      ...(createdActor ? { actor: createdActor } : {}),
      totals: createEmptyCostUsageTotals(),
      sessionCount: 0,
      daily: new Map<string, CostUsageTotals>(),
      sessionActivity: new Map<string, CreatorUsage["sessionActivity"][number]>(),
    };
    addCostUsageTotals(creator.totals, usage);
    if (countedSession) {
      creator.sessionCount += 1;
      const dates = sessionActivityDates(usage);
      const key = JSON.stringify(dates);
      const activity = creator.sessionActivity.get(key) ?? { dates, sessionCount: 0 };
      activity.sessionCount += 1;
      creator.sessionActivity.set(key, activity);
    }
    creators.set(creatorKey, creator);
    if (usage.latency && usage.latency.count > 0) {
      mergeLatency(latency, usage.latency);
    }
    for (const day of usage.dailyLatency ?? []) {
      const existing = dailyLatency.get(day.date) ?? createLatencyAccumulator();
      mergeLatency(existing, day);
      dailyLatency.set(day.date, existing);
    }
    for (const day of usage.dailyBreakdown ?? []) {
      const existing = getDay(day.date);
      existing.tokens += day.tokens;
      existing.cost += day.cost;
      mergeGroupedTotals(costDays, day.date, day);
      mergeGroupedTotals(creator.daily, day.date, day);
    }
    for (const day of usage.dailyMessageCounts ?? []) {
      const existing = getDay(day.date);
      existing.messages += day.total;
      existing.toolCalls += day.toolCalls;
      existing.errors += day.errors;
    }
    addModelDays(usage);
  }

  /** Merge disjoint populations without revisiting their session rows. */
  function merge(source: { totals: CostUsageTotals; aggregates: SessionsUsageAggregates }) {
    const { aggregates } = source;
    addCostUsageTotals(totals, source.totals);
    sessionCount += aggregates.sessionCount ?? 0;
    longestSessionDurationMs = Math.max(
      longestSessionDurationMs,
      aggregates.longestSessionDurationMs ?? 0,
    );
    for (const key of [
      "total",
      "user",
      "assistant",
      "toolCalls",
      "toolResults",
      "errors",
    ] as const) {
      messages[key] += aggregates.messages[key];
    }
    for (const tool of aggregates.tools.tools) {
      tools.set(tool.name, (tools.get(tool.name) ?? 0) + tool.count);
    }
    for (const entry of aggregates.byModel) {
      mergeModelUsage(models, usageModelIdentity(entry.provider, entry.model), entry, entry.model);
    }
    for (const entry of aggregates.byProvider) {
      mergeModelUsage(providers, entry.provider ?? "unknown", entry, undefined);
    }
    for (const entry of aggregates.byAgent) {
      mergeGroupedTotals(agents, entry.agentId, entry.totals);
    }
    for (const entry of aggregates.byChannel) {
      mergeGroupedTotals(channels, entry.channel, entry.totals);
    }
    for (const entry of aggregates.byCreator ?? []) {
      const creator = creators.get(entry.key) ?? {
        key: entry.key,
        ...(entry.actor ? { actor: entry.actor } : {}),
        totals: createEmptyCostUsageTotals(),
        sessionCount: 0,
        daily: new Map<string, CostUsageTotals>(),
        sessionActivity: new Map<string, CreatorUsage["sessionActivity"][number]>(),
      };
      addCostUsageTotals(creator.totals, entry.totals);
      creator.sessionCount += entry.sessionCount;
      for (const day of entry.daily) {
        mergeGroupedTotals(creator.daily, day.date, day);
      }
      for (const activity of entry.sessionActivity) {
        const key = JSON.stringify(activity.dates);
        const current = creator.sessionActivity.get(key) ?? {
          dates: activity.dates,
          sessionCount: 0,
        };
        current.sessionCount += activity.sessionCount;
        creator.sessionActivity.set(key, current);
      }
      creators.set(entry.key, creator);
    }
    for (const day of aggregates.daily) {
      const target = getDay(day.date);
      target.tokens += day.tokens;
      target.cost += day.cost;
      target.messages += day.messages;
      target.toolCalls += day.toolCalls;
      target.errors += day.errors;
    }
    for (const day of aggregates.costDaily ?? []) {
      mergeGroupedTotals(costDays, day.date, day);
    }
    if (aggregates.latency) {
      mergeLatency(latency, aggregates.latency);
    }
    for (const day of aggregates.dailyLatency ?? []) {
      const current = dailyLatency.get(day.date) ?? createLatencyAccumulator();
      mergeLatency(current, day);
      dailyLatency.set(day.date, current);
    }
    addModelDays({ dailyModelUsage: aggregates.modelDaily });
  }

  /* oxlint-disable unicorn/no-array-sort -- Every sorted array is freshly materialized here and exclusively owned until return. */
  function finish(): SessionsUsageAggregates {
    const toolEntries = Array.from(tools, ([name, count]) => ({ name, count })).sort(
      (a, b) => b.count - a.count,
    );
    return {
      sessionCount,
      ...(longestSessionDurationMs > 0 ? { longestSessionDurationMs } : {}),
      messages,
      tools: {
        totalCalls: toolEntries.reduce((sum, { count }) => sum + count, 0),
        uniqueTools: tools.size,
        tools: toolEntries,
      },
      byModel: Array.from(models.values()).sort(compareModelUsage),
      byProvider: Array.from(providers.values()).sort(compareModelUsage),
      byAgent: Array.from(agents, ([agentId, groupTotals]) => ({
        agentId,
        totals: groupTotals,
      })).sort((a, b) => b.totals.totalCost - a.totals.totalCost),
      byChannel: Array.from(channels, ([channel, groupTotals]) => ({
        channel,
        totals: groupTotals,
      })).sort((a, b) => b.totals.totalCost - a.totals.totalCost),
      byCreator: Array.from(creators.values(), ({ daily, sessionActivity, ...creator }) => ({
        ...creator,
        daily: Array.from(daily, ([date, dayTotals]) => ({ date, ...dayTotals })).sort((a, b) =>
          a.date.localeCompare(b.date),
        ),
        sessionActivity: Array.from(sessionActivity.values()).sort((a, b) =>
          a.dates.join(",").localeCompare(b.dates.join(",")),
        ),
      })).sort(
        (a, b) =>
          b.totals.totalCost - a.totals.totalCost ||
          b.totals.totalTokens - a.totals.totalTokens ||
          a.key.localeCompare(b.key),
      ),
      costDaily: Array.from(costDays, ([date, groupTotals]) => ({
        date,
        ...groupTotals,
      })).sort((a, b) => a.date.localeCompare(b.date)),
      latency: latency.count > 0 ? summarizeLatency(latency) : undefined,
      dailyLatency: Array.from(dailyLatency, ([date, value]) => ({
        date,
        ...summarizeLatency(value),
      })).sort((a, b) => a.date.localeCompare(b.date)),
      modelDaily: Array.from(dailyModels.values()).sort(
        (a, b) => a.date.localeCompare(b.date) || b.cost - a.cost,
      ),
      daily: Array.from(days.values()).sort((a, b) => a.date.localeCompare(b.date)),
    };
  }
  /* oxlint-enable unicorn/no-array-sort */

  return { totals, totalsForDays, add, addCalendar, merge, finish };
}
