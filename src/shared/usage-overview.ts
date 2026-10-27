import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  addCostUsageTotals,
  createEmptyCostUsageTotals,
} from "../infra/session-cost-usage-totals.js";
import type { CostUsageTotals, UsageDailyBucket } from "../infra/session-cost-usage.types.js";
import { createUsageAggregateAccumulator } from "./usage-aggregates.js";
import { createUsageCalendar, type UsageCalendar } from "./usage-calendar.js";
import { extractQueryTerms } from "./usage-query.js";
import type {
  SessionUsageEntry,
  SessionsUsageOverview,
  UsageOverviewOptions,
  UsageOverviewSlice,
} from "./usage-types.js";

const PAGE_SIZE = 50;

function matchesGlob(value: string, pattern: string): boolean {
  const text = value.toLowerCase();
  let cursor = 0;
  let token = 0;
  let star = -1;
  let retry = 0;
  const matchesWildcard = (index: number) => !/[\r\n\u2028\u2029]/.test(text[index]!);
  // Revisit only the most recent star, bounding work by text length × pattern length.
  // A regexp's overlapping .* groups can instead backtrack exponentially.
  while (cursor < text.length) {
    if (pattern[token] === "*") {
      star = token++;
      retry = cursor;
    } else if (
      token < pattern.length &&
      (pattern[token] === "?" ? matchesWildcard(cursor) : pattern[token] === text[cursor])
    ) {
      token++;
      cursor++;
    } else if (star >= 0 && retry < text.length && matchesWildcard(retry)) {
      cursor = ++retry;
      token = star + 1;
    } else {
      return false;
    }
  }
  while (pattern[token] === "*") {
    token++;
  }
  return token === pattern.length;
}

const parseQueryNumber = (value: string): number | null => {
  let raw = normalizeLowercaseStringOrEmpty(value);
  if (!raw) {
    return null;
  }
  if (raw.startsWith("$")) {
    raw = raw.slice(1);
  }
  let multiplier = 1;
  if (raw.endsWith("k")) {
    multiplier = 1_000;
    raw = raw.slice(0, -1);
  } else if (raw.endsWith("m")) {
    multiplier = 1_000_000;
    raw = raw.slice(0, -1);
  }
  if (!/^\d+(?:\.\d+)?$/.test(raw)) {
    return null;
  }
  const parsed = Number(raw);
  const normalized = parsed * multiplier;
  if (!Number.isFinite(normalized) || !Number.isSafeInteger(Math.round(normalized))) {
    return null;
  }
  return normalized;
};

const normalizeQueryValues = (items: Array<string | undefined>): string[] =>
  items
    .filter((item): item is string => Boolean(item))
    .map((item) => normalizeLowercaseStringOrEmpty(item));

const getSessionProviders = (session: SessionUsageEntry): string[] =>
  normalizeQueryValues([
    session.modelProvider,
    session.providerOverride,
    session.origin?.provider,
    ...(session.usage?.modelUsage ?? []).map((entry) => entry.provider),
  ]);

const getSessionModels = (session: SessionUsageEntry): string[] =>
  normalizeQueryValues([
    session.model,
    ...(session.usage?.modelUsage ?? []).map((entry) => entry.model),
  ]);

const getSessionTools = (session: SessionUsageEntry): string[] =>
  (session.usage?.toolUsage?.tools ?? []).map((tool) => normalizeLowercaseStringOrEmpty(tool.name));

type UsageQueryPredicate = (session: SessionUsageEntry) => boolean;

const HAS_PREDICATES: Readonly<Record<string, UsageQueryPredicate>> = {
  tools: (session) => (session.usage?.toolUsage?.totalCalls ?? 0) > 0,
  errors: (session) => (session.usage?.messageCounts?.errors ?? 0) > 0,
  context: (session) => session.hasContextWeight === true,
  usage: (session) => Boolean(session.usage),
  model: (session) => getSessionModels(session).length > 0,
  provider: (session) => getSessionProviders(session).length > 0,
};

type NumericQuerySpec = readonly [
  value: (session: SessionUsageEntry) => number,
  matches: (value: number, threshold: number) => boolean,
];

const atLeast = (value: number, threshold: number): boolean => value >= threshold;

const atMost = (value: number, threshold: number): boolean => value <= threshold;

const NUMERIC_QUERY_SPECS: Readonly<Record<string, NumericQuerySpec>> = {
  mintokens: [(session) => session.usage?.totalTokens ?? 0, atLeast],
  maxtokens: [(session) => session.usage?.totalTokens ?? 0, atMost],
  mincost: [(session) => session.usage?.totalCost ?? 0, atLeast],
  maxcost: [(session) => session.usage?.totalCost ?? 0, atMost],
  minmessages: [(session) => session.usage?.messageCounts?.total ?? 0, atLeast],
  maxmessages: [(session) => session.usage?.messageCounts?.total ?? 0, atMost],
};

const QUERY_KEYS = new Set([
  "agent",
  "channel",
  "chat",
  "provider",
  "model",
  "tool",
  "label",
  "key",
  "session",
  "id",
  "has",
  ...Object.keys(NUMERIC_QUERY_SPECS),
]);

const MULTI_VALUE_QUERY_KEYS = new Set(["channel", "provider", "model", "tool"]);

const matchesEverySession: UsageQueryPredicate = () => true;

const prepareUsageQuery = (
  term: ReturnType<typeof extractQueryTerms>[number],
  key: string,
  warnings: string[],
): UsageQueryPredicate => {
  if (term.key && !QUERY_KEYS.has(key)) {
    warnings.push(`Unknown filter: ${term.key}`);
    return matchesEverySession;
  }
  if (term.key && term.value === "") {
    warnings.push(`Missing value for ${term.key}`);
  }

  const value = normalizeLowercaseStringOrEmpty(term.value ?? "");
  const numericSpec = Object.hasOwn(NUMERIC_QUERY_SPECS, key)
    ? NUMERIC_QUERY_SPECS[key]
    : undefined;
  const threshold = numericSpec && term.value ? parseQueryNumber(term.value) : null;
  if (numericSpec && term.value && threshold === null) {
    warnings.push(`Invalid number for ${term.key}`);
  }
  if (key === "has") {
    const predicate = Object.hasOwn(HAS_PREDICATES, value) ? HAS_PREDICATES[value] : undefined;
    if (term.value && !predicate) {
      warnings.push(`Unknown has:${term.value}`);
    }
    return predicate ?? matchesEverySession;
  }
  if (!value) {
    return matchesEverySession;
  }
  if (!term.key) {
    return (session) =>
      normalizeQueryValues([session.label, session.key, session.sessionId]).some((text) =>
        text.includes(value),
      );
  }

  switch (key) {
    case "agent":
      return (session) => normalizeLowercaseStringOrEmpty(session.agentId).includes(value);
    case "channel":
      return (session) => normalizeLowercaseStringOrEmpty(session.channel).includes(value);
    case "chat":
      return (session) => normalizeLowercaseStringOrEmpty(session.chatType).includes(value);
    case "provider":
      return (session) => getSessionProviders(session).some((provider) => provider.includes(value));
    case "model":
      return (session) => getSessionModels(session).some((model) => model.includes(value));
    case "tool":
      return (session) => getSessionTools(session).some((tool) => tool.includes(value));
    case "label":
      return (session) => normalizeLowercaseStringOrEmpty(session.label).includes(value);
    case "key":
    case "session":
    case "id":
      if (value.includes("*") || value.includes("?")) {
        return (session) =>
          matchesGlob(session.key, value) ||
          (session.sessionId ? matchesGlob(session.sessionId, value) : false);
      }
      return (session) =>
        normalizeLowercaseStringOrEmpty(session.key).includes(value) ||
        normalizeLowercaseStringOrEmpty(session.sessionId).includes(value);
  }

  if (!numericSpec || threshold === null) {
    return matchesEverySession;
  }
  const [getValue, matches] = numericSpec;
  return (session) =>
    (!(key.endsWith("tokens") || key.endsWith("cost")) ||
      session.usage?.usageReport?.state !== "unavailable") &&
    matches(getValue(session), threshold);
};

const filterSessionsByQuery = (sessions: SessionUsageEntry[], query: string) => {
  const terms = extractQueryTerms(query);
  if (terms.length === 0) {
    return { sessions, warnings: [] };
  }

  const warnings: string[] = [];
  const categoricalTerms = new Map<string, UsageQueryPredicate[]>();
  const predicates = terms.map((term) => {
    const key = normalizeLowercaseStringOrEmpty(term.key ?? "");
    const predicate = prepareUsageQuery(term, key, warnings);
    if (!MULTI_VALUE_QUERY_KEYS.has(key)) {
      return predicate;
    }
    const alternatives = categoricalTerms.get(key) ?? [];
    if (term.value) {
      alternatives.push(predicate);
    }
    categoricalTerms.set(key, alternatives);
    // Every original term still revisits its completed OR group, including empty terms.
    return (session: SessionUsageEntry) =>
      alternatives.length === 0 || alternatives.some((match) => match(session));
  });

  const filtered = sessions.filter((session) => predicates.every((match) => match(session)));
  return { sessions: filtered, warnings };
};

function visitHours(
  session: SessionUsageEntry,
  calendar: UsageCalendar,
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

type SessionHours = {
  tokens: ArrayLike<number>;
  weekdayTokens: ArrayLike<number>;
  /** Hour-level activity: tokens per hour are positive only where quarters had tokens. */
  precise: boolean;
  messages?: { total: ArrayLike<number>; errors: ArrayLike<number> };
};

// Filtering and chart folding read the same profile; detail rows map UTC quarters once per calendar.
const hourProfiles = new WeakMap<UsageCalendar, WeakMap<object, SessionHours>>();
// Report-local hours already follow the request calendar; their views are reused across reads.
const localProfiles = new WeakMap<object, SessionHours>();

/** Worker-folded rows carry report-calendar hours; detail rows still carry UTC quarters. */
function sessionHours(
  usage: NonNullable<SessionUsageEntry["usage"]>,
  calendar: UsageCalendar,
): SessionHours {
  if (usage.localHours) {
    const cached = localProfiles.get(usage.localHours);
    if (cached) {
      return cached;
    }
    const { values, precise } = usage.localHours;
    const hours = {
      tokens: values.subarray(0, 24),
      weekdayTokens: values.subarray(24, 31),
      precise,
      messages: { total: values.subarray(31, 55), errors: values.subarray(55, 79) },
    };
    localProfiles.set(usage.localHours, hours);
    return hours;
  }
  let profiles = hourProfiles.get(calendar);
  if (!profiles) {
    profiles = new WeakMap();
    hourProfiles.set(calendar, profiles);
  }
  const cached = profiles.get(usage);
  if (cached) {
    return cached;
  }
  const tokens = Array<number>(24).fill(0);
  const weekdayTokens = Array<number>(7).fill(0);
  const hours: SessionHours = { tokens, weekdayTokens, precise: false };
  for (const value of usage.utcQuarterHourTokenUsage ?? []) {
    if (value.totalTokens <= 0) {
      continue;
    }
    const mapped = calendar.quarter(value.date, value.quarterIndex);
    if (!mapped) {
      continue;
    }
    hours.precise = true;
    tokens[mapped.hour]! += value.totalTokens;
    weekdayTokens[mapped.weekday]! += value.totalTokens;
  }
  if (usage.utcQuarterHourMessageCounts?.length) {
    const total = Array<number>(24).fill(0);
    const errors = Array<number>(24).fill(0);
    for (const value of usage.utcQuarterHourMessageCounts) {
      const mapped = calendar.quarter(value.date, value.quarterIndex);
      if (!mapped) {
        continue;
      }
      total[mapped.hour]! += value.total;
      errors[mapped.hour]! += value.errors;
    }
    hours.messages = { total, errors };
  }
  profiles.set(usage, hours);
  return hours;
}

function touchesHours(session: SessionUsageEntry, hours: Set<number>, calendar: UsageCalendar) {
  if (hours.size === 0) {
    return true;
  }
  const profile = session.usage ? sessionHours(session.usage, calendar) : undefined;
  if (profile?.precise) {
    return [...hours].some((hour) => (profile.tokens[hour] ?? 0) > 0);
  }
  let touches = false;
  visitHours(session, calendar, true, (hour) => {
    touches = hours.has(hour);
    return !touches;
  });
  return touches;
}

function sessionRowTotals(session: SessionUsageEntry, days: ReadonlySet<string>): CostUsageTotals {
  const usage = session.usage;
  if (!days.size || !usage?.dailyBreakdown?.length) {
    return usage ?? createEmptyCostUsageTotals();
  }
  const totals = createEmptyCostUsageTotals();
  for (const day of usage.dailyBreakdown) {
    if (days.has(day.date)) {
      addCostUsageTotals(totals, { ...day, totalTokens: day.tokens, totalCost: day.cost });
    }
  }
  return totals;
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
        return totals(entry).totalTokens;
      case "cost":
        return totals(entry).totalCost;
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
  const usage = {
    ...session.usage,
    ...row,
    usageReport: row.usageReport,
  };
  for (const field of [
    "dailyBreakdown",
    "dailyMessageCounts",
    "dailyModelUsage",
    "dailyLatency",
    "utcQuarterHourTokenUsage",
    "utcQuarterHourMessageCounts",
    "localHours",
    "activityDates",
    "sessionFile",
  ] as const) {
    delete usage[field];
  }
  return { ...session, usage };
}

function selectUsageOverviewSessions(
  sessions: SessionUsageEntry[],
  options: UsageOverviewOptions,
  calendar: UsageCalendar,
) {
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
  return { days, queried, matched, selected, scoped, roster };
}

function usageOverviewPage(roster: SessionUsageEntry[], options: UsageOverviewOptions) {
  return roster
    .toSorted(compareUsageOverviewSessions(options))
    .slice(options.offset ?? 0, (options.offset ?? 0) + (options.limit ?? PAGE_SIZE));
}

/** Selects rows for context hydration without calculating the full report twice. */
export function selectUsageOverviewPage(params: {
  rows: SessionUsageEntry[];
  options: UsageOverviewOptions;
  dayBucket: UsageDailyBucket;
}): SessionUsageEntry[] {
  const { roster } = selectUsageOverviewSessions(
    params.rows,
    params.options,
    createUsageCalendar(params.dayBucket),
  );
  return usageOverviewPage(roster, params.options);
}

export function buildUsageOverview(params: {
  rows: SessionUsageEntry[];
  options: UsageOverviewOptions;
  dayBucket: UsageDailyBucket;
  compact?: boolean;
}): UsageOverviewSlice {
  const { options, rows: sessions } = params;
  const calendar = createUsageCalendar(params.dayBucket);
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
  const { days, queried, matched, selected, scoped, roster } = selectUsageOverviewSessions(
    sessions,
    options,
    calendar,
  );
  const selectedSources = new Map(
    sessions
      .filter((session) => selected.has(session.key))
      .map((session) => [session.key, session]),
  );
  const selectedUsageComplete = selected.size
    ? selectedSources.size === selected.size &&
      [...selectedSources.values()].every(
        (session) =>
          session.usage &&
          !session.computing &&
          session.usage.staleSince === undefined &&
          !session.usage.refreshing,
      )
    : undefined;
  const selectedRows = new Map(
    selected.size ? scoped.map((session) => [session.key, session]) : [],
  );
  const toRow = (session: SessionUsageEntry) =>
    params.compact === false ? session : compactSession(session, days);
  const accumulator = createUsageAggregateAccumulator();
  const overview: SessionsUsageOverview = {
    total: roster.length,
    unfilteredSessionCount: sessions.length,
    selectedSessionCount: 0,
    selectedRowCount: scoped.length,
    selectedUsageComplete,
    selectedRows: [...selected].flatMap((key) => {
      const session = selectedRows.get(key);
      return session ? [toRow(session)] : [];
    }),
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
      // oxlint-disable-next-line unicorn/no-array-sort -- The Set spread is a private array.
      agent: [...filters.agent].sort(),
      // oxlint-disable-next-line unicorn/no-array-sort -- The Set spread is a private array.
      channel: [...filters.channel].sort(),
      // oxlint-disable-next-line unicorn/no-array-sort -- The Set spread is a private array.
      provider: [...filters.provider].sort(),
      // oxlint-disable-next-line unicorn/no-array-sort -- The Set spread is a private array.
      model: [...filters.model].sort(),
      // oxlint-disable-next-line unicorn/no-array-sort -- The Set spread is a private array.
      tool: [...filters.tool].sort(),
    },
  };
  for (const session of matched) {
    const row = sessionRowTotals(session, days);
    overview.tableTotals.tokens += row.totalTokens;
    overview.tableTotals.cost += row.totalCost;
    if (row.usageReport?.state === "unavailable") {
      overview.tableTotals.usageReport = row.usageReport;
    }
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
    const hours = sessionHours(usage, calendar);
    if (usage.totalTokens > 0) {
      if (hours.precise) {
        overview.hasTimelineData = true;
        for (let hour = 0; hour < 24; hour += 1) {
          overview.hourTokens[hour]! += hours.tokens[hour]!;
        }
        for (let weekday = 0; weekday < 7; weekday += 1) {
          overview.weekdayTokens[weekday]! += hours.weekdayTokens[weekday]!;
        }
      } else {
        overview.hasTimelineData =
          visitHours(session, calendar, false, (hour, weekday, share) => {
            overview.hourTokens[hour]! += usage.totalTokens * share;
            overview.weekdayTokens[weekday]! += usage.totalTokens * share;
          }) || overview.hasTimelineData;
      }
    }
    if (usage.messageCounts?.total) {
      if (hours.messages) {
        for (let hour = 0; hour < 24; hour += 1) {
          overview.hourlyMessages[hour]! += hours.messages.total[hour]!;
          overview.hourlyErrors[hour]! += hours.messages.errors[hour]!;
        }
      } else {
        visitHours(session, calendar, false, (hour, _weekday, share) => {
          overview.hourlyMessages[hour]! += usage.messageCounts!.total * share;
          overview.hourlyErrors[hour]! += usage.messageCounts!.errors * share;
        });
      }
    }
  }
  const totals = days.size ? accumulator.totalsForDays(days) : accumulator.totals;
  if (days.size) {
    // Only the calendar ignores its own day selection. Already accumulated rows
    // retain their totals and provider attribution without being processed twice.
    const accumulated = new Set(scoped);
    for (const session of queried.sessions) {
      if (!accumulated.has(session) && (!selected.size || selected.has(session.key))) {
        accumulator.addCalendar(session.usage);
      }
    }
  }
  overview.usageReport = accumulator.totals.usageReport;
  const aggregates = accumulator.finish();
  overview.selectedSessionCount = aggregates.sessionCount ?? 0;
  if (days.size) {
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
    sessions: usageOverviewPage(roster, options).map(toRow),
    totals,
    aggregates,
    overview,
  };
}
