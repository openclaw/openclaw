import { createSessionCostSummaryAccumulator } from "../infra/session-cost-usage-rollup.js";
import {
  addCostUsageTotals,
  createEmptyCostUsageTotals,
} from "../infra/session-cost-usage-totals.js";
import type {
  CostUsageTotals,
  SessionCostSummary,
  UsageDailyBucket,
} from "../infra/session-cost-usage.types.js";
import { createUsageAggregateAccumulator } from "./usage-aggregates.js";
import { filterSessionsByQuery } from "./usage-query.js";
import type {
  SessionUsageEntry,
  SessionsUsageOverview,
  UsageOverviewOptions,
  UsageOverviewSession,
  UsageOverviewSlice,
} from "./usage-types.js";

const PAGE_SIZE = 50;

function createCalendar(bucket: UsageDailyBucket) {
  const formatter =
    bucket.mode === "time-zone"
      ? new Intl.DateTimeFormat("en-US", {
          timeZone: bucket.timeZone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hourCycle: "h23",
        })
      : undefined;
  const cache = new Map<
    number,
    { date: string; hour: number; weekday: number; minute: number; second: number; offset: number }
  >();
  function at(timestamp: number) {
    const found = cache.get(timestamp);
    if (found) {
      return found;
    }
    const date = new Date(
      timestamp + (bucket.mode === "utc-offset" ? bucket.utcOffsetMinutes * 60_000 : 0),
    );
    let year = date.getUTCFullYear(),
      month = date.getUTCMonth() + 1,
      day = date.getUTCDate();
    let hour = date.getUTCHours(),
      minute = date.getUTCMinutes(),
      second = date.getUTCSeconds();
    if (formatter) {
      const parts = formatter.formatToParts(timestamp);
      const value = (type: Intl.DateTimeFormatPartTypes) =>
        Number(parts.find((part) => part.type === type)?.value);
      year = value("year");
      month = value("month");
      day = value("day");
      hour = value("hour");
      minute = value("minute");
      second = value("second");
    }
    const calendarMs = Date.UTC(year, month - 1, day, hour, minute, second);
    const result = {
      date: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
      hour,
      minute,
      second,
      weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
      offset: calendarMs - (timestamp - (((timestamp % 1000) + 1000) % 1000)),
    };
    cache.set(timestamp, result);
    return result;
  }
  function quarter(date: string, index: number) {
    if (!Number.isInteger(index) || index < 0 || index > 95 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return null;
    }
    const time = Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== date) {
      return null;
    }
    return at(time + index * 900_000);
  }
  function nextHour(timestamp: number) {
    const current = at(timestamp);
    const next =
      timestamp +
      (60 - current.minute) * 60_000 -
      current.second * 1000 -
      (((timestamp % 1000) + 1000) % 1000);
    if (at(next - 1).offset === current.offset) {
      return next;
    }
    let low = timestamp + 1,
      high = next - 1;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (at(middle).offset === current.offset) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low;
  }
  return { at, quarter, nextHour };
}

type Calendar = ReturnType<typeof createCalendar>;

function visitHours(
  session: SessionUsageEntry,
  calendar: Calendar,
  inclusive: boolean,
  visit: (hour: number, weekday: number, share: number) => boolean | void,
) {
  const start = session.usage?.firstActivity ?? session.updatedAt;
  const end = session.usage?.lastActivity ?? session.updatedAt;
  if (!start || !end) {
    return false;
  }
  const low = Math.min(start, end),
    high = Math.max(start, end);
  let cursor = low;
  while (cursor <= high) {
    const next = cursor === high ? cursor : Math.min(calendar.nextHour(cursor), high);
    const { hour, weekday } = calendar.at(cursor);
    if (visit(hour, weekday, low === high ? 1 : (next - cursor) / (high - low)) === false) {
      break;
    }
    if (cursor === high || (!inclusive && next === high)) {
      break;
    }
    cursor = next;
  }
  return true;
}

function touchesHours(session: SessionUsageEntry, hours: Set<number>, calendar: Calendar) {
  if (hours.size === 0) {
    return true;
  }
  let precise = false;
  for (const value of session.usage?.utcQuarterHourTokenUsage ?? []) {
    if (value.totalTokens <= 0) {
      continue;
    }
    const mapped = calendar.quarter(value.date, value.quarterIndex);
    if (!mapped) {
      continue;
    }
    precise = true;
    if (hours.has(mapped.hour)) {
      return true;
    }
  }
  if (precise) {
    return false;
  }
  let touches = false;
  visitHours(session, calendar, true, (hour) => {
    touches = hours.has(hour);
    return !touches;
  });
  return touches;
}

function sessionRowTotals(session: SessionUsageEntry, days: ReadonlySet<string>) {
  const usage = session.usage;
  let tokens = usage?.totalTokens ?? 0;
  let cost = usage?.totalCost ?? 0;
  if (days.size && usage?.dailyBreakdown?.length) {
    tokens = 0;
    cost = 0;
    for (const day of usage.dailyBreakdown) {
      if (days.has(day.date)) {
        tokens += day.tokens;
        cost += day.cost;
      }
    }
  }
  return { tokens, cost };
}

function compareUsageOverviewSessions(options: UsageOverviewOptions) {
  if (options.recentKeys) {
    const recentKeys = options.recentKeys;
    return (a: SessionUsageEntry, b: SessionUsageEntry) =>
      recentKeys.indexOf(a.key) - recentKeys.indexOf(b.key);
  }
  const days = new Set(options.selectedDays);
  const rowTotals = new Map<SessionUsageEntry, ReturnType<typeof sessionRowTotals>>();
  const totals = (entry: SessionUsageEntry) => {
    let result = rowTotals.get(entry);
    if (!result) {
      result = sessionRowTotals(entry, days);
      rowTotals.set(entry, result);
    }
    return result;
  };
  const value = (entry: SessionUsageEntry) => {
    switch (options.sort) {
      case "tokens":
        return totals(entry).tokens;
      case "cost":
        return totals(entry).cost;
      case "messages":
        return entry.usage?.messageCounts?.total ?? 0;
      case "errors":
        return entry.usage?.messageCounts?.errors ?? 0;
      default:
        return entry.updatedAt ?? 0;
    }
  };
  const direction = options.sortDirection === "asc" ? -1 : 1;
  return (a: SessionUsageEntry, b: SessionUsageEntry) =>
    direction *
    (value(b) - value(a) ||
      (b.updatedAt ?? 0) - (a.updatedAt ?? 0) ||
      (a.label || a.key).localeCompare(b.label || b.key));
}

function compactSession(session: SessionUsageEntry, days: ReadonlySet<string>): SessionUsageEntry {
  if (!session.usage) {
    return session;
  }
  const row = sessionRowTotals(session, days);
  const usage = { ...session.usage, totalTokens: row.tokens, totalCost: row.cost };
  for (const field of [
    "dailyBreakdown",
    "dailyMessageCounts",
    "dailyModelUsage",
    "dailyLatency",
    "utcQuarterHourTokenUsage",
    "utcQuarterHourMessageCounts",
    "activityDates",
    "sessionFile",
  ] as const) {
    delete usage[field];
  }
  return { ...session, usage };
}

export function buildUsageOverview(
  params: (
    | { sessions: UsageOverviewSession[]; summaries: Array<SessionCostSummary | null> }
    | { rows: SessionUsageEntry[] }
  ) & {
    options: UsageOverviewOptions;
    dayBucket: UsageDailyBucket;
    compact?: boolean;
  },
): UsageOverviewSlice {
  const { options } = params;
  const calendar = createCalendar(params.dayBucket);
  let index = 0;
  const sessions =
    "rows" in params
      ? params.rows
      : params.sessions.map(({ instances, ...entry }): SessionUsageEntry => {
          if (instances.length === 1) {
            const usage = params.summaries[index++] ?? null;
            return { ...entry, usage, ...(!usage ? { computing: true } : {}) };
          }
          const accumulator = createSessionCostSummaryAccumulator({
            sessionId: entry.sessionId,
            sessionFile: instances[0]?.sessionFile,
          });
          let present = false;
          for (const [offset] of instances.entries()) {
            const summary = params.summaries[index + offset];
            if (summary) {
              accumulator.add(summary);
              present = true;
            }
          }
          index += instances.length;
          return {
            ...entry,
            usage: present ? accumulator.finish() : null,
            ...(!present ? { computing: true } : {}),
          };
        });
  const filters = {
    agent: new Set<string>(),
    channel: new Set<string>(),
    provider: new Set<string>(),
    model: new Set<string>(),
    tool: new Set<string>(),
  };
  for (const session of sessions) {
    if (session.agentId) {
      filters.agent.add(session.agentId);
    }
    if (session.channel) {
      filters.channel.add(session.channel);
    }
    for (const provider of [
      session.modelProvider,
      session.providerOverride,
      session.origin?.provider,
    ]) {
      if (provider) {
        filters.provider.add(provider);
      }
    }
    if (session.model) {
      filters.model.add(session.model);
    }
    for (const model of session.usage?.modelUsage ?? []) {
      if (model.provider) {
        filters.provider.add(model.provider);
      }
      if (model.model) {
        filters.model.add(model.model);
      }
    }
    for (const tool of session.usage?.toolUsage?.tools ?? []) {
      filters.tool.add(tool.name);
    }
  }
  const days = new Set(options.selectedDays);
  const hours = new Set(options.selectedHours);
  const queried = filterSessionsByQuery(
    sessions.filter((session) => touchesHours(session, hours, calendar)),
    options.query ?? "",
  );
  const matched = queried.sessions.filter(
    (session) =>
      !days.size ||
      (session.usage?.activityDates?.length
        ? session.usage.activityDates.some((day) => days.has(day))
        : Boolean(session.updatedAt && days.has(calendar.at(session.updatedAt).date))),
  );
  const selected = new Set(options.selectedSessions);
  const scoped = selected.size ? matched.filter((session) => selected.has(session.key)) : matched;
  const recent = options.recentKeys === undefined ? undefined : new Set(options.recentKeys);
  const roster = recent ? matched.filter((session) => recent.has(session.key)) : matched;
  const accumulator = createUsageAggregateAccumulator();
  const overview: SessionsUsageOverview = {
    total: roster.length,
    unfilteredSessionCount: sessions.length,
    selectedSessionCount: 0,
    selectedRowCount: scoped.length,
    tableSessionCount: matched.length,
    tableTotals: { tokens: 0, cost: 0, errors: 0 },
    offset: options.offset ?? 0,
    limit: options.limit ?? PAGE_SIZE,
    queryWarnings: queried.warnings,
    hourTokens: Array.from({ length: 24 }, () => 0),
    weekdayTokens: Array.from({ length: 7 }, () => 0),
    hasTimelineData: false,
    durationMs: 0,
    durationCount: 0,
    hourlyMessages: Array.from({ length: 24 }, () => 0),
    hourlyErrors: Array.from({ length: 24 }, () => 0),
    filterOptions: {
      agent: [...filters.agent].toSorted(),
      channel: [...filters.channel].toSorted(),
      provider: [...filters.provider].toSorted(),
      model: [...filters.model].toSorted(),
      tool: [...filters.tool].toSorted(),
    },
  };
  for (const session of matched) {
    const row = sessionRowTotals(session, days);
    overview.tableTotals.tokens += row.tokens;
    overview.tableTotals.cost += row.cost;
    overview.tableTotals.errors += session.usage?.messageCounts?.errors ?? 0;
  }
  for (const session of scoped) {
    accumulator.add(session);
    const usage = session.usage;
    if (!usage) {
      continue;
    }
    if ((usage.durationMs ?? 0) > 0) {
      overview.durationMs += usage.durationMs!;
      overview.durationCount++;
    }
    if (usage.totalTokens > 0) {
      let precise = false;
      for (const value of usage.utcQuarterHourTokenUsage ?? []) {
        if (value.totalTokens <= 0) {
          continue;
        }
        const mapped = calendar.quarter(value.date, value.quarterIndex);
        if (!mapped) {
          continue;
        }
        precise = true;
        overview.hourTokens[mapped.hour]! += value.totalTokens;
        overview.weekdayTokens[mapped.weekday]! += value.totalTokens;
      }
      overview.hasTimelineData = overview.hasTimelineData || precise;
      if (!precise) {
        overview.hasTimelineData =
          visitHours(session, calendar, false, (hour, weekday, share) => {
            overview.hourTokens[hour]! += usage.totalTokens * share;
            overview.weekdayTokens[weekday]! += usage.totalTokens * share;
          }) || overview.hasTimelineData;
      }
    }
    if (usage.messageCounts?.total) {
      if (usage.utcQuarterHourMessageCounts?.length) {
        for (const value of usage.utcQuarterHourMessageCounts) {
          const mapped = calendar.quarter(value.date, value.quarterIndex);
          if (!mapped) {
            continue;
          }
          overview.hourlyMessages[mapped.hour]! += value.total;
          overview.hourlyErrors[mapped.hour]! += value.errors;
        }
      } else {
        visitHours(session, calendar, false, (hour, _weekday, share) => {
          overview.hourlyMessages[hour]! += usage.messageCounts!.total * share;
          overview.hourlyErrors[hour]! += usage.messageCounts!.errors * share;
        });
      }
    }
  }
  const aggregates = accumulator.finish();
  overview.selectedSessionCount = aggregates.sessionCount ?? 0;
  let totals = accumulator.totals;
  if (days.size) {
    totals = createEmptyCostUsageTotals();
    for (const day of aggregates.costDaily ?? []) {
      if (days.has(day.date)) {
        addCostUsageTotals(totals, day);
      }
    }
    // Keep the calendar facet before its own selection, so another day remains selectable.
    const calendarDaily = new Map<string, CostUsageTotals>();
    for (const session of queried.sessions) {
      if (selected.size && !selected.has(session.key)) {
        continue;
      }
      for (const day of session.usage?.dailyBreakdown ?? []) {
        const dayTotals = calendarDaily.get(day.date) ?? createEmptyCostUsageTotals();
        addCostUsageTotals(dayTotals, day);
        calendarDaily.set(day.date, dayTotals);
      }
    }
    aggregates.costDaily = [...calendarDaily]
      .map(([date, dayTotals]) => Object.assign({ date }, dayTotals))
      .toSorted((a, b) => a.date.localeCompare(b.date));
    for (const creator of aggregates.byCreator ?? []) {
      creator.daily = creator.daily.filter((day) => days.has(day.date));
      creator.totals = createEmptyCostUsageTotals();
      for (const day of creator.daily) {
        addCostUsageTotals(creator.totals, day);
      }
      creator.sessionCount = creator.sessionActivity.reduce(
        (count, activity) =>
          count + (activity.dates.some((day) => days.has(day)) ? activity.sessionCount : 0),
        0,
      );
    }
  }
  return {
    sessions: roster
      .toSorted(compareUsageOverviewSessions(options))
      .slice(options.offset ?? 0, (options.offset ?? 0) + (options.limit ?? PAGE_SIZE))
      .map((session) => (params.compact === false ? session : compactSession(session, days))),
    totals,
    aggregates,
    overview,
  };
}
