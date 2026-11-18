import { expect, it } from "vitest";
import { createEmptyCostUsageTotals } from "../infra/session-cost-usage-totals.js";
import type { SessionCostSummary, UsageDailyBucket } from "../infra/session-cost-usage.types.js";
import { createUsageAggregateAccumulator, usageModelIdentity } from "./usage-aggregates.js";
import { buildUsageOverview } from "./usage-overview.js";
import type { SessionUsageEntry, UsageOverviewOptions } from "./usage-types.js";

const utc: UsageDailyBucket = { mode: "utc-offset", utcOffsetMinutes: 0 };
const zeroMessages = { total: 0, user: 0, assistant: 0, toolCalls: 0, toolResults: 0, errors: 0 };

const usage = (...parts: Partial<SessionCostSummary>[]): SessionCostSummary =>
  Object.assign(createEmptyCostUsageTotals(), ...parts);
function overview(rows: SessionUsageEntry[], options: UsageOverviewOptions = {}, compact = true) {
  return buildUsageOverview({ rows, options, compact, dayBucket: utc });
}
it("matches wildcard filters without exponential backtracking", () => {
  const longKey = "a".repeat(128);
  const sessions = [
    { key: longKey, usage: null },
    { key: "Agent:Main:Job.42", sessionId: "run-[42]", usage: null },
  ];
  expect(overview(sessions, { query: `key:${"*?".repeat(64)}b` }, false).sessions).toEqual([]);
  expect(overview(sessions, { query: `key:${"*?".repeat(64)}` }, false).sessions).toEqual([
    sessions[0],
  ]);
  expect(overview(sessions, { query: "key:agent:*:job.??" }, false).sessions).toEqual([
    sessions[1],
  ]);
  expect(overview(sessions, { query: "id:run-[?2]" }, false).sessions).toEqual([sessions[1]]);
  expect(overview(sessions, { query: "key:*jobX??" }, false).sessions).toEqual([]);
});

function tools(read: number, write = 0) {
  return {
    totalCalls: read + write,
    uniqueTools: write ? 2 : 1,
    tools: [{ name: "read", count: read }, ...(write ? [{ name: "write", count: write }] : [])],
  };
}
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

function daily(date: string, tokens: number) {
  const totals = usage({ totalTokens: tokens, totalCost: tokens / 10 });
  return { ...totals, date, tokens, cost: tokens / 10 };
}
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
      dailyModelUsage: [{ date, provider, model, tokens, cost: tokens / 10, count: 1 }],
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
        dailyModelUsage: [...firstDay.dailyModelUsage!, ...secondDay.dailyModelUsage!],
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

it("keeps excluded days' costs and providers in the calendar while summaries follow selection", () => {
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
  expect(result.aggregates.modelDaily).toEqual([
    { date: "2026-02-01", provider: "provider::a", model: "model", tokens: 10, cost: 1, count: 1 },
    { date: "2026-02-02", provider: "provider", model: "a::model", tokens: 20, cost: 2, count: 1 },
    { date: "2026-02-03", provider: "provider::a", model: "model", tokens: 30, cost: 3, count: 1 },
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

it.each([{ query: "agent:first" }, { selectedSessions: ["family"] }])(
  "keeps non-calendar filters on both calendar series: %j",
  (filter) => {
    const result = overview(sources("2026-02-03"), {
      ...filter,
      selectedDays: ["2026-02-01"],
    });
    expect(result.aggregates.costDaily?.map((entry) => entry.date)).toEqual([
      "2026-02-01",
      "2026-02-02",
    ]);
    expect(result.aggregates.modelDaily?.map((entry) => entry.date)).toEqual([
      "2026-02-01",
      "2026-02-02",
    ]);
    expect(result.totals.totalTokens).toBe(10);
  },
);

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

const makeSession = (
  key: string,
  summary: Partial<SessionCostSummary> | null,
  fields: Omit<SessionUsageEntry, "key" | "usage"> = {},
) => ({ key, usage: summary === null ? null : usage(summary), ...fields });

function queryOverview(rows: SessionUsageEntry[], query: string) {
  const result = overview(
    rows,
    { query, limit: rows.length, recentKeys: rows.map((row) => row.key) },
    false,
  );
  return { sessions: result.sessions, warnings: result.overview.queryWarnings };
}

function populatedSessions() {
  const rows: [string, string, string, number, number, string][] = [
    ["openai", "discord", "gpt", 100, 1, "read"],
    ["anthropic", "slack", "claude", 80, 0, "write"],
    ["google", "discord", "gemini", 60, 1, "read"],
  ];
  return rows.map(([key, channel, model, totalTokens, errors, name]) =>
    makeSession(
      key,
      {
        totalTokens,
        messageCounts: { ...zeroMessages, errors },
        toolUsage: { uniqueTools: 1, totalCalls: 1, tools: [{ count: 1, name }] },
      },
      { channel, modelProvider: key, model, hasContextWeight: true },
    ),
  );
}

it("unions categorical values while intersecting categories and other constraints", () => {
  const sessions = populatedSessions();
  const cases: Array<[query: string, keys: string[]]> = [
    ["provider:openai provider:anthropic", ["openai", "anthropic"]],
    ["tool:read tool:write", ["openai", "anthropic", "google"]],
    ["provider:openai provider:anthropic channel:discord", ["openai"]],
    ["provider:openai provider:anthropic minTokens:90 has:errors has:tools", ["openai"]],
  ];

  for (const [query, keys] of cases) {
    expect(queryOverview(sessions, query).sessions.map((session) => session.key)).toEqual(keys);
  }
});

it("supports numeric filters like minTokens/maxTokens", () => {
  const a = makeSession("a", {
    totalTokens: 1_000,
    totalCost: 20,
    messageCounts: { ...zeroMessages, total: 30 },
  });
  const b = makeSession("b", {
    totalTokens: 5,
    totalCost: 2,
    messageCounts: { ...zeroMessages, total: 3 },
  });
  const filters = [
    "minTokens:10",
    "minTokens:1k",
    "minCost:10",
    "minMessages:10",
    "maxTokens:10",
    "maxCost:10",
    "maxMessages:10",
  ];

  for (const [index, filter] of filters.entries()) {
    expect(queryOverview([a, b], filter)).toEqual({
      sessions: [index < 4 ? a : b],
      warnings: [],
    });
  }
});

it("rejects non-decimal query thresholds", () => {
  const target = makeSession("a", { totalTokens: 10_000, totalCost: 0 });
  for (const value of ["1e3", "0x1000"]) {
    expect(queryOverview([target], `minTokens:${value}`).warnings).toEqual([
      "Invalid number for minTokens",
    ]);
  }
});

function report(
  summary: Partial<SessionCostSummary>,
  dayBucket: UsageDailyBucket = utc,
  options: UsageOverviewOptions = {},
) {
  const rows = [{ key: "session", agentId: "main", usage: usage(summary) }];
  return buildUsageOverview({ rows, options, dayBucket });
}

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

it.each(["tokens", "cost"] as const)(
  "uses selected-day %s for comparison rows without changing canonical totals",
  (sort) => {
    const rows = [
      { key: "first", total: 100, selected: 90 },
      { key: "second", total: 1000, selected: 1 },
    ].map(({ key, total, selected }) => ({
      key,
      agentId: "main",
      usage: usage({
        firstActivity: 1,
        totalTokens: total,
        totalCost: total / 10,
        activityDates: ["2026-02-01", "2026-02-02"],
        dailyBreakdown: [daily("2026-02-01", selected), daily("2026-02-02", total - selected)],
      }),
    }));
    const before = structuredClone(rows);
    const options = { selectedDays: ["2026-02-01"], selectedSessions: ["second", "first"], sort };
    const compact = overview(rows, options);
    const amounts = (entries: SessionUsageEntry[]) =>
      entries.map((entry) => [entry.key, entry.usage?.totalTokens, entry.usage?.totalCost]);
    expect(amounts(compact.sessions)).toEqual([
      ["first", 90, 9],
      ["second", 1, 0.1],
    ]);
    expect(amounts(compact.overview.selectedRows)).toEqual([
      ["second", 1, 0.1],
      ["first", 90, 9],
    ]);
    expect(amounts(overview(rows, options, false).sessions)).toEqual([
      ["first", 100, 10],
      ["second", 1000, 100],
    ]);
    expect(rows).toEqual(before);
  },
);

it("weights overall and daily latency by unequal reply counts", () => {
  const date = "2026-03-12";
  const quick = { count: 2, avgMs: 50, minMs: 20, maxMs: 90, p95Ms: 80 };
  const slow = { count: 1, avgMs: 120, minMs: 120, maxMs: 120, p95Ms: 120 };
  const result = aggregate(
    { latency: quick, dailyLatency: [{ date, ...quick }] },
    { latency: slow, dailyLatency: [{ date, ...slow }] },
  );
  const weighted = { count: 3, avgMs: 220 / 3, minMs: 20, maxMs: 120, p95Ms: 120 };
  expect(result.latency).toEqual(weighted);
  expect(result.dailyLatency).toEqual([{ date, ...weighted }]);
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
      return Object.assign(daily(date, input), { input });
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
