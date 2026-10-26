import type { UsageOverviewSessionSummary } from "../shared/usage-types.js";
import type {
  CostUsageTotals,
  SessionDailyLatency,
  SessionDailyModelUsage,
  SessionModelUsage,
} from "./session-cost-usage.types.js";

/**
 * Overview rows packed for the worker reply: one number vector, interned strings and
 * sparse missing-cost maps. Cloning a few large values is far cheaper than cloning
 * thousands of small objects; the Gateway expands the rows it reports.
 */
export type UsageOverviewBatch = {
  strings: string[];
  values: Float64Array;
  /** Start of each row in `values`; -1 marks a row without usage. */
  offsets: Int32Array;
  /** [row, target, counts]: target "" is the row, "d<i>" a day and "m<i>" a model entry. */
  missing: Array<[number, string, Record<string, number>]>;
};

/** Packed row layout shared by the worker fold (writer) and `readUsageOverviewBatch`. */
export const ROW = {
  TOTALS: 0,
  UNAVAILABLE: 11,
  COMPUTED_AT: 12,
  STALE_SINCE: 13,
  FIRST: 14,
  LAST: 15,
  MESSAGES: 16,
  LATENCY: 22,
  DAY_COUNT: 27,
  MODEL_COUNT: 28,
  TOOL_COUNT: 29,
  DAY_MODEL_COUNT: 30,
  /** 0 without quarter data, 1 imprecise, 2 when a quarter had tokens. */
  HOURS: 31,
  HEADER: 32,
  /** Date string id, then totals (12), messages (6), latency count/sum/min/max/p95. */
  DAY_WIDTH: 24,
  DAY_MESSAGES: 13,
  DAY_LATENCY: 19,
  /** Provider and model string ids (-1 when missing), count, totals (12). */
  MODEL_WIDTH: 15,
  /** Tool name id, count. */
  TOOL_WIDTH: 2,
  /** Date, provider and model ids, tokens, cost, count, unavailable flag. */
  DAY_MODEL_WIDTH: 7,
  HOUR_VALUES: 79,
} as const;
const {
  TOTALS,
  UNAVAILABLE,
  COMPUTED_AT,
  STALE_SINCE,
  FIRST,
  LAST,
  MESSAGES,
  LATENCY,
  DAY_COUNT,
  MODEL_COUNT,
  TOOL_COUNT,
  DAY_MODEL_COUNT,
  HOURS,
  HEADER,
  DAY_WIDTH,
  DAY_MESSAGES,
  DAY_LATENCY,
  MODEL_WIDTH,
  TOOL_WIDTH,
  DAY_MODEL_WIDTH,
  HOUR_VALUES,
} = ROW;

export type UsageOverviewRowCounts = {
  days: number;
  models: number;
  tools: number;
  dayModels: number;
  hours: boolean;
};

/** Collects rows in order; `finish` hands the packed batch to the worker reply. */
export function createUsageOverviewBatchBuilder() {
  const strings: string[] = [];
  const stringIds = new Map<string, number>();
  let values = new Float64Array(1 << 16);
  let length = 0;
  const offsets: number[] = [];
  const missing: UsageOverviewBatch["missing"] = [];
  return {
    intern(value: string | null | undefined): number {
      if (value === undefined || value === null) {
        return -1;
      }
      let id = stringIds.get(value);
      if (id === undefined) {
        id = strings.length;
        strings.push(value);
        stringIds.set(value, id);
      }
      return id;
    },
    addEmpty() {
      offsets.push(-1);
    },
    /**
     * Reserve one zeroed row and write its section counts. The returned `values`
     * stay valid until the next reservation.
     */
    reserveRow(counts: UsageOverviewRowCounts): {
      values: Float64Array;
      base: number;
      row: number;
    } {
      const size =
        HEADER +
        counts.days * DAY_WIDTH +
        counts.models * MODEL_WIDTH +
        counts.tools * TOOL_WIDTH +
        counts.dayModels * DAY_MODEL_WIDTH +
        (counts.hours ? HOUR_VALUES : 0);
      if (length + size > values.length) {
        const grown = new Float64Array(Math.max(values.length * 2, length + size));
        grown.set(values.subarray(0, length));
        values = grown;
      }
      const base = length;
      length += size;
      offsets.push(base);
      values[base + DAY_COUNT] = counts.days;
      values[base + MODEL_COUNT] = counts.models;
      values[base + TOOL_COUNT] = counts.tools;
      values[base + DAY_MODEL_COUNT] = counts.dayModels;
      return { values, base, row: offsets.length - 1 };
    },
    /** Missing-cost counts: target "" is the row, "d<i>" a day and "m<i>" a model entry. */
    addMissing(row: number, target: string, counts: Record<string, number>) {
      missing.push([row, target, counts]);
    },
    finish(): UsageOverviewBatch {
      // Finished rows never change: a shared buffer crosses the worker reply, the
      // Gateway snapshot and the overview report without copies.
      const shared = new Float64Array(new SharedArrayBuffer(length * 8));
      shared.set(values.subarray(0, length));
      return {
        strings,
        values: shared,
        offsets: Int32Array.from(offsets),
        missing,
      };
    },
  };
}

function readTotals(values: Float64Array, offset: number): CostUsageTotals {
  const totals: CostUsageTotals = {
    input: values[offset]!,
    output: values[offset + 1]!,
    cacheRead: values[offset + 2]!,
    cacheWrite: values[offset + 3]!,
    totalTokens: values[offset + 4]!,
    totalCost: values[offset + 5]!,
    inputCost: values[offset + 6]!,
    outputCost: values[offset + 7]!,
    cacheReadCost: values[offset + 8]!,
    cacheWriteCost: values[offset + 9]!,
    missingCostEntries: values[offset + 10]!,
  };
  if (values[offset + UNAVAILABLE]) {
    totals.usageReport = { state: "unavailable" };
  }
  return totals;
}

const optional = (value: number) => (Number.isNaN(value) ? undefined : value);

/**
 * Expand packed rows into overview summaries. `refreshing` marks stale rows whose
 * refresh the loader already scheduled.
 */
export function readUsageOverviewBatch(
  batch: UsageOverviewBatch,
  refreshing = false,
): Array<UsageOverviewSessionSummary | null> {
  const { strings, values } = batch;
  const name = (id: number) => (id < 0 ? undefined : strings[id]);
  const missing = new Map<number, Map<string, Record<string, number>>>();
  for (const [row, target, counts] of batch.missing) {
    const targets = missing.get(row) ?? new Map<string, Record<string, number>>();
    targets.set(target, counts);
    missing.set(row, targets);
  }
  const withMissing = <T extends CostUsageTotals>(
    totals: T,
    row: number,
    kind: "" | "d" | "m",
    index = 0,
  ): T => {
    const counts =
      missing.size > 0 ? missing.get(row)?.get(kind === "" ? "" : `${kind}${index}`) : undefined;
    if (counts) {
      totals.missingCostByModel = counts;
    }
    return totals;
  };
  return Array.from(batch.offsets, (base, row) => {
    if (base < 0) {
      return null;
    }
    const totals = withMissing(readTotals(values, base + TOTALS), row, "");
    const latencyCount = values[base + LATENCY]!;
    const latency = (offset: number) => ({
      count: values[offset]!,
      avgMs: values[offset + 1]! / values[offset]!,
      // Each quarter retains its p95; merged p95 is the largest one.
      p95Ms: values[offset + 4]!,
      minMs: values[offset + 2]!,
      maxMs: values[offset + 3]!,
    });
    const dayCount = values[base + DAY_COUNT]!;
    const modelCount = values[base + MODEL_COUNT]!;
    const toolCount = values[base + TOOL_COUNT]!;
    const dayModelCount = values[base + DAY_MODEL_COUNT]!;
    let cursor = base + HEADER;
    const activityDates: string[] = [];
    const dailyBreakdown: NonNullable<UsageOverviewSessionSummary["dailyBreakdown"]> = [];
    const dailyMessageCounts: NonNullable<UsageOverviewSessionSummary["dailyMessageCounts"]> = [];
    const dailyLatency: SessionDailyLatency[] = [];
    for (let day = 0; day < dayCount; day += 1) {
      const date = strings[values[cursor]!]!;
      const entry: NonNullable<UsageOverviewSessionSummary["dailyBreakdown"]>[number] = {
        date,
        tokens: values[cursor + 5]!,
        cost: values[cursor + 6]!,
        ...readTotals(values, cursor + 1),
      };
      activityDates.push(date);
      dailyBreakdown.push(withMissing(entry, row, "d", day));
      const messages = cursor + DAY_MESSAGES;
      dailyMessageCounts.push({
        date,
        total: values[messages]!,
        user: values[messages + 1]!,
        assistant: values[messages + 2]!,
        toolCalls: values[messages + 3]!,
        toolResults: values[messages + 4]!,
        errors: values[messages + 5]!,
      });
      if (values[cursor + DAY_LATENCY]! > 0) {
        dailyLatency.push({ date, ...latency(cursor + DAY_LATENCY) });
      }
      cursor += DAY_WIDTH;
    }
    const modelUsage: SessionModelUsage[] = [];
    for (let model = 0; model < modelCount; model += 1) {
      const provider = name(values[cursor]!);
      const modelName = name(values[cursor + 1]!);
      modelUsage.push({
        ...(provider === undefined ? {} : { provider }),
        ...(modelName === undefined ? {} : { model: modelName }),
        count: values[cursor + 2]!,
        totals: withMissing(readTotals(values, cursor + 3), row, "m", model),
      });
      cursor += MODEL_WIDTH;
    }
    const tools: Array<{ name: string; count: number }> = [];
    let totalCalls = 0;
    for (let tool = 0; tool < toolCount; tool += 1) {
      const count = values[cursor + 1]!;
      tools.push({ name: strings[values[cursor]!]!, count });
      totalCalls += count;
      cursor += TOOL_WIDTH;
    }
    const dailyModelUsage: SessionDailyModelUsage[] = [];
    for (let entry = 0; entry < dayModelCount; entry += 1) {
      const provider = name(values[cursor + 1]!);
      const modelName = name(values[cursor + 2]!);
      dailyModelUsage.push({
        date: strings[values[cursor]!]!,
        ...(provider === undefined ? {} : { provider }),
        ...(modelName === undefined ? {} : { model: modelName }),
        tokens: values[cursor + 3]!,
        cost: values[cursor + 4]!,
        count: values[cursor + 5]!,
        ...(values[cursor + 6] ? { usageReport: { state: "unavailable" as const } } : {}),
      });
      cursor += DAY_MODEL_WIDTH;
    }
    const hours = values[base + HOURS]!;
    const firstActivity = optional(values[base + FIRST]!);
    const lastActivity = optional(values[base + LAST]!);
    const computedAt = optional(values[base + COMPUTED_AT]!);
    const staleSince = optional(values[base + STALE_SINCE]!);
    const summary: UsageOverviewSessionSummary = {
      ...totals,
      ...(computedAt === undefined ? {} : { computedAt }),
      ...(staleSince === undefined ? {} : { staleSince, refreshing }),
      firstActivity,
      lastActivity,
      durationMs:
        firstActivity !== undefined && lastActivity !== undefined
          ? Math.max(0, lastActivity - firstActivity)
          : undefined,
      activityDates,
      dailyBreakdown,
      dailyMessageCounts,
      dailyLatency: dailyLatency.length ? dailyLatency : undefined,
      dailyModelUsage: dailyModelUsage.length ? dailyModelUsage : undefined,
      messageCounts: {
        total: values[base + MESSAGES]!,
        user: values[base + MESSAGES + 1]!,
        assistant: values[base + MESSAGES + 2]!,
        toolCalls: values[base + MESSAGES + 3]!,
        toolResults: values[base + MESSAGES + 4]!,
        errors: values[base + MESSAGES + 5]!,
      },
      toolUsage: tools.length ? { totalCalls, uniqueTools: tools.length, tools } : undefined,
      modelUsage: modelUsage.length ? modelUsage : undefined,
      latency: latencyCount > 0 ? latency(base + LATENCY) : undefined,
      ...(hours > 0
        ? {
            localHours: {
              values: values.subarray(cursor, cursor + HOUR_VALUES),
              precise: hours === 2,
            },
          }
        : {}),
    };
    return summary;
  });
}
