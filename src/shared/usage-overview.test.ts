import { expect, it } from "vitest";
import { createEmptyCostUsageTotals } from "../infra/session-cost-usage-totals.js";
import type { SessionCostSummary, UsageDailyBucket } from "../infra/session-cost-usage.types.js";
import { createUsageAggregateAccumulator, usageModelIdentity } from "./usage-aggregates.js";
import { buildUsageOverview } from "./usage-overview.js";
import { filterSessionsByQuery } from "./usage-query.js";
import type { SessionUsageEntry, UsageOverviewOptions } from "./usage-types.js";

const utc: UsageDailyBucket = { mode: "utc-offset", utcOffsetMinutes: 0 };
const zeroMessages = { total: 0, user: 0, assistant: 0, toolCalls: 0, toolResults: 0, errors: 0 };
const unavailable = { state: "unavailable" as const };
const usage = (...parts: Partial<SessionCostSummary>[]): SessionCostSummary =>
  Object.assign(createEmptyCostUsageTotals(), ...parts);
function overview(rows: SessionUsageEntry[], options: UsageOverviewOptions = {}, compact = true) {
  return buildUsageOverview({ rows, options, compact, dayBucket: utc });
}
const amounts = (rows: SessionUsageEntry[]) =>
  rows.map(({ key, usage: totals }) => [key, totals?.totalTokens, totals?.totalCost]);
function daily(date: string, tokens: number) {
  const totals = usage({ totalTokens: tokens, totalCost: tokens / 10 });
  return { ...totals, date, tokens, cost: tokens / 10 };
}

function report(
  summary: Partial<SessionCostSummary>,
  dayBucket: UsageDailyBucket = utc,
  options: UsageOverviewOptions = {},
) {
  const rows = [{ key: "session", agentId: "main", usage: usage(summary) }];
  return buildUsageOverview({ rows, options, dayBucket });
}

it("matches wildcard filters without exponential backtracking", () => {
  const longKey = "a".repeat(128);
  const sessions = [{ key: longKey }, { key: "Agent:Main:Job.42", sessionId: "run-[42]" }];
  expect(filterSessionsByQuery(sessions, `key:${"*?".repeat(64)}b`).sessions).toEqual([]);
  expect(filterSessionsByQuery(sessions, `key:${"*?".repeat(64)}`).sessions).toEqual([sessions[0]]);
  expect(filterSessionsByQuery(sessions, "key:agent:*:job.??").sessions).toEqual([sessions[1]]);
  expect(filterSessionsByQuery(sessions, "id:run-[?2]").sessions).toEqual([sessions[1]]);
  expect(filterSessionsByQuery(sessions, "key:*jobX??").sessions).toEqual([]);
});

it("keeps incomplete table totals unknown beyond the page and scopes completeness to selected days", () => {
  const complete = usage({ input: 40, inputCost: 1, totalTokens: 40, totalCost: 1 });
  const interrupted = usage({
    input: 75,
    inputCost: 2,
    totalTokens: 75,
    totalCost: 2,
    usageReport: unavailable,
    activityDates: ["2026-05-14", "2026-05-15"],
    dailyBreakdown: [
      { ...complete, date: "2026-05-14", tokens: 40, cost: 1 },
      { ...daily("2026-05-15", 0), usageReport: unavailable },
    ],
  });
  const rows = [
    { key: "complete", updatedAt: 2, usage: complete },
    { key: "interrupted", updatedAt: 1, usage: interrupted },
  ];
  const all = overview(rows, { limit: 1 });
  expect(all.sessions.map((row) => row.key)).toEqual(["complete"]);
  expect(all.totals.usageReport).toEqual(unavailable);
  expect(all.overview.tableTotals).toEqual({
    tokens: 115,
    cost: 3,
    errors: 0,
    usageReport: unavailable,
  });
  const selected = overview([rows[1]!], { selectedDays: ["2026-05-14"] });
  expect(selected.overview.usageReport).toEqual(unavailable);
  expect(selected.totals.usageReport).toBeUndefined();
  expect(selected.overview.tableTotals).toEqual({ tokens: 40, cost: 1, errors: 0 });
  expect(selected.sessions[0]?.usage).toMatchObject(complete);
  expect(selected.sessions[0]?.usage?.usageReport).toBeUndefined();
});

it.each([
  ["America/Los_Angeles", "2026-11-01T08:30Z", "2026-11-01T10:30Z", 1, 90, 2, 30],
  ["Pacific/Chatham", "2026-09-26T13:15Z", "2026-09-26T14:15Z", 2, 45, 3, 15],
] as const)(
  "allocates elapsed messages through %s's DST transition",
  (timeZone, start, end, firstHour, firstMinutes, secondHour, secondMinutes) => {
    const messages = firstMinutes + secondMinutes;
    const result = report(
      {
        firstActivity: Date.parse(start),
        lastActivity: Date.parse(end),
        totalTokens: messages,
        messageCounts: { ...zeroMessages, total: messages, errors: messages },
      },
      { mode: "time-zone", timeZone },
    );
    const expected = Array<number>(24).fill(0);
    expected[firstHour] = firstMinutes;
    expected[secondHour] = secondMinutes;
    expect(result.overview).toMatchObject({
      hourlyMessages: expected,
      hourlyErrors: expected,
      hourTokens: expected,
    });
  },
);

it("prefers valid positive token quarters for selection and ignores malformed coordinates", () => {
  const quarter = {
    date: "2026-02-01",
    quarterIndex: 40,
    ...usage({ totalTokens: 100, output: 100 }),
  };
  const summary = {
    totalTokens: 100,
    firstActivity: Date.parse("2026-02-01T10:00:00Z"),
    lastActivity: Date.parse("2026-02-01T12:00:00Z"),
    utcQuarterHourTokenUsage: [
      quarter,
      { ...quarter, date: "2026-13-01" },
      { ...quarter, date: "2026-02-31" },
      { ...quarter, quarterIndex: 96 },
    ],
  };
  expect(report(summary, undefined, { selectedHours: [10] }).overview.total).toBe(1);
  expect(report(summary, undefined, { selectedHours: [11] }).overview.total).toBe(0);
  expect(report(summary).overview.hourTokens[10]).toBe(100);
  expect(
    report(summary, { mode: "time-zone", timeZone: "Asia/Singapore" }).overview.hourTokens[18],
  ).toBe(100);
  const fallback = { ...summary, utcQuarterHourTokenUsage: [{ ...quarter, totalTokens: 0 }] };
  expect(report(fallback, undefined, { selectedHours: [12] }).overview.total).toBe(1);
});

it("places an instant fallback in one hour and sums precise message quarters", () => {
  const instant = Date.parse("2026-03-15T10:00:00Z");
  const result = report({
    totalTokens: 100,
    firstActivity: instant,
    lastActivity: instant,
    messageCounts: { ...zeroMessages, total: 15, errors: 5 },
    utcQuarterHourMessageCounts: [0, 3].map((quarterIndex, index) =>
      Object.assign({}, zeroMessages, {
        date: "2026-03-15",
        quarterIndex,
        total: index ? 5 : 10,
        errors: index ? 3 : 2,
      }),
    ),
  });
  expect([
    result.overview.hourTokens[10],
    result.overview.hourlyMessages[0],
    result.overview.hourlyErrors[0],
    result.overview.hourlyMessages[10],
  ]).toEqual([100, 15, 5, 0]);
});
function sources(secondDate = "2026-02-01") {
  function makeUsage(tokens: number, date: string, provider: string, model: string) {
    const totals = usage({
      totalTokens: tokens,
      totalCost: tokens / 10,
      missingCostEntries: 1,
      missingCostByModel: { [provider + "/" + model]: 1 },
    });
    return {
      ...totals,
      firstActivity: Date.parse(date + "T10:00:00Z"),
      lastActivity: Date.parse(date + "T10:01:00Z"),
      activityDates: [date],
      dailyBreakdown: [{ ...daily(date, tokens), ...totals }],
      dailyMessageCounts: [{ ...zeroMessages, date, total: 1, assistant: 1, toolCalls: 1 }],
      modelUsage: [{ provider, model, count: 1, totals }],
      messageCounts: { ...zeroMessages, total: 1, assistant: 1, toolCalls: 1 },
      toolUsage: { totalCalls: 1, uniqueTools: 1, tools: [{ name: "read", count: 1 }] },
    };
  }
  const firstDay = makeUsage(10, "2026-02-01", "provider::a", "model");
  const secondDay = makeUsage(20, "2026-02-02", "provider", "a::model");
  const common = { channel: "slack", creatorKey: "person" };
  return [
    {
      ...common,
      key: "family",
      agentId: "first",
      updatedAt: 20,
      usage: {
        ...makeUsage(30, "2026-02-01", "provider::a", "model"),
        lastActivity: secondDay.lastActivity,
        activityDates: ["2026-02-01", "2026-02-02"],
        dailyBreakdown: [...firstDay.dailyBreakdown!, ...secondDay.dailyBreakdown!],
        dailyMessageCounts: [...firstDay.dailyMessageCounts!, ...secondDay.dailyMessageCounts!],
        modelUsage: [...firstDay.modelUsage!, ...secondDay.modelUsage!],
        missingCostEntries: 2,
        missingCostByModel: { "provider::a/model": 1, "provider/a::model": 1 },
        messageCounts: { ...zeroMessages, total: 2, assistant: 2, toolCalls: 2 },
        toolUsage: { totalCalls: 2, uniqueTools: 1, tools: [{ name: "read", count: 2 }] },
      },
    },
    {
      ...common,
      key: "second",
      agentId: "second",
      updatedAt: 30,
      usage: makeUsage(30, secondDate, "provider::a", "model"),
    },
  ];
}

it("aggregates prepared family rows and all agents before selecting the page", () => {
  const result = overview(sources(), { offset: 1, limit: 1, sort: "recent" });
  expect(result.sessions).toMatchObject([{ key: "family", usage: { totalTokens: 30 } }]);
  expect(result.totals).toMatchObject({
    totalTokens: 60,
    totalCost: 6,
    missingCostEntries: 3,
    missingCostByModel: { "provider::a/model": 2, "provider/a::model": 1 },
  });
  expect(
    result.aggregates.byModel.map((row) => [row.provider, row.model, row.totals.totalTokens]),
  ).toEqual([
    ["provider::a", "model", 40],
    ["provider", "a::model", 20],
  ]);
  expect(result.aggregates).toMatchObject({
    byChannel: [{ channel: "slack", totals: { totalTokens: 60 } }],
    byCreator: [{ key: "person", sessionCount: 2, totals: { totalTokens: 60 } }],
    tools: { totalCalls: 3 },
  });
  expect(result.overview).toMatchObject({
    total: 2,
    selectedSessionCount: 2,
    selectedRowCount: 2,
    selectedRows: [],
    unfilteredSessionCount: 2,
    filterOptions: { agent: ["first", "second"] },
  });
});

it("keeps an excluded agent's costs only in the calendar facet after day selection", () => {
  const result = overview(sources("2026-02-03"), {
    selectedDays: ["2026-02-01"],
    recentKeys: [],
  });
  expect(result.sessions).toEqual([]);
  expect(result.overview).toMatchObject({
    total: 0,
    selectedSessionCount: 1,
    selectedRowCount: 1,
    unfilteredSessionCount: 2,
    tableSessionCount: 1,
    tableTotals: { tokens: 10, cost: 1, errors: 0 },
  });
  expect(result.totals.totalTokens).toBe(10);
  expect(result.aggregates.costDaily).toMatchObject([
    { date: "2026-02-01", totalTokens: 10 },
    { date: "2026-02-02", totalTokens: 20 },
    { date: "2026-02-03", totalTokens: 30 },
  ]);
  expect(result.aggregates.daily).toEqual([
    { date: "2026-02-01", tokens: 10, cost: 1, messages: 1, toolCalls: 1, errors: 0 },
    { date: "2026-02-02", tokens: 20, cost: 2, messages: 1, toolCalls: 1, errors: 0 },
  ]);
  expect(result.aggregates.byModel.map((row) => row.totals.totalTokens)).toEqual([20, 10]);
  expect(result.aggregates).toMatchObject({
    byAgent: [{ agentId: "first", totals: { totalTokens: 30 } }],
    byCreator: [{ key: "person", totals: { totalTokens: 10 }, sessionCount: 1 }],
  });
});

it("counts activity independently of recently modified empty comparison rows", () => {
  const result = overview(
    ["active", "empty"].map((key) => ({
      key,
      agentId: "main",
      updatedAt: 2,
      usage: key === "active" ? usage({ firstActivity: 1, totalTokens: 7 }) : usage({}),
    })),
  );
  expect(result).toMatchObject({
    overview: { total: 2, selectedSessionCount: 1, selectedRowCount: 2, unfilteredSessionCount: 2 },
    aggregates: { sessionCount: 1 },
    totals: { totalTokens: 7 },
  });
  const emptySelected = overview(
    [{ key: "empty", agentId: "main", updatedAt: 2, usage: usage({}) }],
    { selectedSessions: ["empty"] },
  );
  expect(emptySelected.overview).toMatchObject({ selectedSessionCount: 0, selectedRowCount: 1 });
});
it.each(["tokens", "cost"] as const)(
  "sorts and displays compact %s for selected days while retaining canonical history",
  (sort) => {
    const rows = [
      { key: "first", total: 100, selected: 90 },
      { key: "second", total: 1000, selected: 1 },
    ].map(({ key, total, selected }) => ({
      key,
      agentId: "main",
      usage: usage({
        totalTokens: total,
        totalCost: total / 10,
        firstActivity: 1,
        activityDates: ["2026-02-01", "2026-02-02"],
        dailyBreakdown: [daily("2026-02-01", selected), daily("2026-02-02", total - selected)],
      }),
    }));
    const options = {
      selectedDays: ["2026-02-01"],
      selectedSessions: ["second", "first"],
      sort,
    };
    const compact = overview(rows, options);
    expect(amounts(compact.sessions)).toEqual([
      ["first", 90, 9],
      ["second", 1, 0.1],
    ]);
    const canonical = overview(rows, options, false);
    expect(canonical.sessions.map((session) => [session.key, session.usage?.totalTokens])).toEqual([
      ["first", 100],
      ["second", 1000],
    ]);
    expect(canonical.sessions[0]?.usage?.dailyBreakdown).toHaveLength(2);
    expect(amounts(compact.overview.selectedRows)).toEqual([
      ["second", 1, 0.1],
      ["first", 90, 9],
    ]);
    expect(compact.overview.selectedRows[0]?.usage?.dailyBreakdown).toBeUndefined();
    expect(canonical.overview.selectedRows[0]?.usage?.dailyBreakdown).toHaveLength(2);
    expect(compact.overview).toMatchObject({
      selectedUsageComplete: true,
      tableSessionCount: 2,
      tableTotals: { tokens: 91, cost: 9.1, errors: 0 },
    });
  },
);

function tools(read: number, write = 0) {
  return {
    totalCalls: read + write,
    uniqueTools: write ? 2 : 1,
    tools: [{ name: "read", count: read }, ...(write ? [{ name: "write", count: write }] : [])],
  };
}
function latency(count: number, avgMs: number, minMs: number, maxMs: number, p95Ms = maxMs) {
  return { count, avgMs, minMs, maxMs, p95Ms };
}
function day(date: string, totals: Partial<SessionCostSummary>) {
  return { ...usage(totals), date, tokens: totals.totalTokens ?? 0, cost: totals.totalCost ?? 0 };
}
function modelDay(
  date: string,
  model: string,
  tokens: number,
  cost: number,
  count: number,
  provider?: string,
) {
  return { date, model, provider, tokens, cost, count };
}
function aggregate(...summaries: Partial<SessionCostSummary>[]) {
  const accumulator = createUsageAggregateAccumulator();
  for (const summary of summaries) {
    accumulator.add({ usage: usage(summary) });
  }
  return accumulator.finish();
}

it("retains incomplete daily and model subtotals after merging complete rows", () => {
  const date = "2026-05-15";
  const marker = { state: "unavailable" as const };
  const result = aggregate(
    ...[marker, undefined].map((usageReport) => ({
      usageReport,
      dailyBreakdown: [{ ...usage(), date, tokens: 10, cost: 1, usageReport }],
      dailyModelUsage: [{ date, model: "local", tokens: 10, cost: 1, count: 1, usageReport }],
    })),
  );
  expect(result.daily).toEqual([
    { date, tokens: 20, cost: 2, messages: 0, toolCalls: 0, errors: 0, usageReport: marker },
  ]);
  expect(result.modelDaily).toEqual([
    { ...modelDay(date, "local", 20, 2, 2), usageReport: marker },
  ]);
});

it("builds collision-free model identities with legacy unknown grouping", () => {
  expect(usageModelIdentity("fixture\0bedrock", "arn")).not.toBe(
    usageModelIdentity("fixture", "bedrock\0arn"),
  );
  expect(usageModelIdentity()).toBe(usageModelIdentity("unknown", "unknown"));
});

it("accounts for every supplied row without conflating matching session IDs or mutating usage", () => {
  const accumulator = createUsageAggregateAccumulator();
  const first = usage(
    { sessionId: "same-id", firstActivity: 0, durationMs: 500 },
    { input: 10, inputCost: 1 },
    { cacheRead: 3, cacheReadCost: 1 },
    { totalTokens: 13, totalCost: 2 },
    { missingCostEntries: 1, missingCostByModel: { "fixture/unpriced": 1 } },
    {
      messageCounts: { total: 3, user: 1, assistant: 2, toolCalls: 3, toolResults: 2, errors: 1 },
      toolUsage: tools(2, 1),
    },
  );
  const second = usage(
    { sessionId: "same-id", durationMs: 900 },
    { output: 5, outputCost: 3 },
    { cacheWrite: 2, cacheWriteCost: 1 },
    { totalTokens: 7, totalCost: 4 },
    { missingCostEntries: 2, missingCostByModel: { "fixture/unpriced": 2 } },
    {
      messageCounts: { total: 2, user: 1, assistant: 1, toolCalls: 2, toolResults: 1, errors: 0 },
      toolUsage: tools(2),
    },
  );
  const original = structuredClone([first, second]);
  accumulator.add({ usage: first, agentId: "first", channel: "discord", creatorKey: "person" });
  accumulator.add({ usage: second, agentId: "second", channel: "telegram", creatorKey: "person" });
  accumulator.add({ usage: usage({ totalTokens: 30 }) });
  accumulator.add({ usage: null, agentId: "cold" });

  const aggregates = accumulator.finish();
  expect(accumulator.totals).toEqual(
    usage(
      { input: 10, inputCost: 1 },
      { output: 5, outputCost: 3 },
      { cacheRead: 3, cacheReadCost: 1 },
      { cacheWrite: 2, cacheWriteCost: 1 },
      { totalTokens: 50, totalCost: 6 },
      { missingCostEntries: 3, missingCostByModel: { "fixture/unpriced": 3 } },
    ),
  );
  expect(aggregates).toMatchObject({
    sessionCount: 2,
    longestSessionDurationMs: 900,
    messages: { total: 5, user: 2, assistant: 3, toolCalls: 5, toolResults: 3, errors: 1 },
  });
  expect(aggregates.tools).toEqual(tools(4, 1));
  expect(aggregates.byAgent.map(({ agentId, totals }) => [agentId, totals.totalTokens])).toEqual([
    ["second", 7],
    ["first", 13],
  ]);
  expect(aggregates.byChannel.map(({ channel }) => channel)).toEqual(["telegram", "discord"]);
  expect(aggregates.byCreator).toMatchObject([
    { key: "person", sessionCount: 2, totals: { totalTokens: 20, totalCost: 6 } },
    { key: '["unknown"]', sessionCount: 0, totals: { totalTokens: 30, totalCost: 0 } },
  ]);
  expect([first, second]).toEqual(original);
});

it("merges models and providers by identity and ranks equal costs by token usage", () => {
  const rows = [
    ["fixture", "bedrock::arn", 10],
    ["fixture::bedrock", "arn", 20],
    ["fixture", "bedrock::arn", 15],
  ] as const;
  const aggregates = aggregate(
    ...rows.map(([provider, model, tokens]) => ({
      modelUsage: [{ provider, model, count: 1, totals: usage({ totalTokens: tokens }) }],
      dailyModelUsage: [{ date: "2026-03-12", provider, model, tokens, cost: 0, count: 1 }],
    })),
  );
  expect(aggregates.byModel).toMatchObject([
    { provider: "fixture", model: "bedrock::arn", count: 2, totals: { totalTokens: 25 } },
    { provider: "fixture::bedrock", model: "arn", count: 1, totals: { totalTokens: 20 } },
  ]);
  expect(aggregates.byProvider).toMatchObject([
    { provider: "fixture", model: undefined, count: 2, totals: { totalTokens: 25 } },
    { provider: "fixture::bedrock", model: undefined, count: 1, totals: { totalTokens: 20 } },
  ]);
  expect(aggregates.modelDaily).toEqual([
    modelDay("2026-03-12", "bedrock::arn", 25, 0, 2, "fixture"),
    modelDay("2026-03-12", "arn", 20, 0, 1, "fixture::bedrock"),
  ]);
});

it("merges overlapping daily buckets and uses weighted latency summaries", () => {
  const earlier = "2026-03-11";
  const later = "2026-03-12";
  const quick = latency(2, 50, 20, 90, 80);
  const slow = latency(1, 120, 120, 120);
  const aggregates = aggregate(
    {
      latency: quick,
      dailyLatency: [{ date: later, ...quick }],
      dailyBreakdown: [
        day(later, { input: 3, totalTokens: 3, totalCost: 4, inputCost: 4 }),
        day(earlier, { totalTokens: 5, totalCost: 6 }),
      ],
      dailyModelUsage: [modelDay(later, "one", 3, 4, 2, "fixture")],
    },
    {
      latency: slow,
      dailyLatency: [
        { date: later, ...slow },
        { date: earlier, ...slow },
      ],
      dailyBreakdown: [
        day(later, { cacheRead: 7, totalTokens: 7, totalCost: 8, cacheReadCost: 8 }),
      ],
      dailyMessageCounts: [
        { date: later, total: 9, user: 5, assistant: 4, toolCalls: 2, toolResults: 2, errors: 1 },
      ],
      dailyModelUsage: [
        modelDay(later, "two", 7, 8, 1, "fixture"),
        modelDay(earlier, "one", 5, 6, 1, "fixture"),
      ],
    },
  );
  const weighted = latency(3, 220 / 3, 20, 120);
  expect(aggregates.latency).toEqual(weighted);
  expect(aggregates.dailyLatency).toEqual([
    { date: earlier, ...slow },
    { date: later, ...weighted },
  ]);
  expect(aggregates.daily).toEqual([
    { date: earlier, tokens: 5, cost: 6, messages: 0, toolCalls: 0, errors: 0 },
    { date: later, tokens: 10, cost: 12, messages: 9, toolCalls: 2, errors: 1 },
  ]);
  expect(aggregates.costDaily).toEqual([
    { date: earlier, ...usage({ totalTokens: 5, totalCost: 6 }) },
    {
      date: later,
      ...usage(
        { input: 3, inputCost: 4 },
        { cacheRead: 7, cacheReadCost: 8 },
        { totalTokens: 10, totalCost: 12 },
      ),
    },
  ]);
  expect(aggregates.modelDaily?.map(({ date, model }) => [date, model])).toEqual([
    [earlier, "one"],
    [later, "two"],
    [later, "one"],
  ]);
});

it("keeps empty reports and zero-count latency free of nonfinite values", () => {
  const accumulator = createUsageAggregateAccumulator();
  accumulator.add({ usage: null });
  expect(accumulator.finish()).toEqual({
    sessionCount: 0,
    messages: zeroMessages,
    tools: { totalCalls: 0, uniqueTools: 0, tools: [] },
    byModel: [],
    byProvider: [],
    byAgent: [],
    byChannel: [],
    byCreator: [],
    costDaily: [],
    latency: undefined,
    dailyLatency: [],
    modelDaily: [],
    daily: [],
  });
  accumulator.add({
    usage: usage({
      latency: latency(0, 999, 1, 999),
      dailyLatency: [{ date: "2026-03-12", ...latency(0, 0, Number.POSITIVE_INFINITY, 0) }],
    }),
  });
  const aggregates = accumulator.finish();
  expect(aggregates.latency).toBeUndefined();
  expect(aggregates.dailyLatency).toEqual([{ date: "2026-03-12", ...latency(0, 0, 0, 0) }]);
});

it("retains creator daily amounts and counts each multi-day session once", () => {
  const dates = ["2026-03-11", "2026-03-12", "2026-03-13"] as const;
  const summary = usage({
    firstActivity: 0,
    totalTokens: 30,
    totalCost: 3,
    activityDates: [dates[1], dates[0], dates[1]],
    dailyBreakdown: dates.slice(0, 2).map((date, index) => {
      const input = (index + 1) * 10;
      return day(date, { input, totalTokens: input, totalCost: input / 10 });
    }),
    dailyMessageCounts: [{ ...zeroMessages, date: dates[2], total: 1, user: 1 }],
  });
  const original = structuredClone(summary);
  const accumulator = createUsageAggregateAccumulator();
  accumulator.add({ creatorKey: "person", usage: summary });
  accumulator.add({
    creatorKey: "person",
    usage: { ...summary, activityDates: dates.toReversed() },
  });
  accumulator.add({ creatorKey: "person", usage: usage({ firstActivity: 0, totalTokens: 5 }) });
  accumulator.add({ creatorKey: "person", usage: usage({ activityDates: [dates[0]] }) });
  const group = accumulator.finish().byCreator?.[0];
  expect(group).toMatchObject({
    sessionCount: 3,
    totals: { totalTokens: 65, totalCost: 6 },
    daily: [
      { date: dates[0], input: 20, totalTokens: 20, totalCost: 2 },
      { date: dates[1], input: 40, totalTokens: 40, totalCost: 4 },
    ],
    sessionActivity: [
      { dates: [], sessionCount: 1 },
      { dates, sessionCount: 2 },
    ],
  });
  expect(summary).toEqual(original);
});
