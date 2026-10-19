import { expect, it } from "vitest";
import { createEmptyCostUsageTotals } from "../infra/session-cost-usage-totals.js";
import type { SessionCostSummary } from "../infra/session-cost-usage.types.js";
import {
  createUsageAggregateAccumulator,
  usageDailyModelIdentity,
  usageModelIdentity,
} from "./usage-aggregates.js";

const usage = (...parts: Partial<SessionCostSummary>[]): SessionCostSummary =>
  Object.assign(createEmptyCostUsageTotals(), ...parts);

const zeroMessages = { total: 0, user: 0, assistant: 0, toolCalls: 0, toolResults: 0, errors: 0 };
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

it("retains incomplete daily and model subtotals after merging complete rows", () => {
  const accumulator = createUsageAggregateAccumulator();
  const date = "2026-05-15";
  const marker = { state: "unavailable" as const };
  for (const usageReport of [marker, undefined]) {
    accumulator.add({
      usage: usage({
        usageReport,
        dailyBreakdown: [{ ...usage(), date, tokens: 10, cost: 1, usageReport }],
        dailyModelUsage: [{ date, model: "local", tokens: 10, cost: 1, count: 1, usageReport }],
      }),
    });
  }
  const result = accumulator.finish();
  expect(result.daily).toEqual([
    { date, tokens: 20, cost: 2, messages: 0, toolCalls: 0, errors: 0, usageReport: marker },
  ]);
  expect(result.modelDaily).toEqual([
    { ...modelDay(date, "local", 20, 2, 2), usageReport: marker },
  ]);
});

it("builds collision-free model identities with legacy unknown grouping", () => {
  expect(usageModelIdentity("fixture", "bedrock::arn")).not.toBe(
    usageModelIdentity("fixture::bedrock", "arn"),
  );
  expect(usageDailyModelIdentity("2026-02-01", "fixture", "bedrock:arn")).not.toBe(
    usageDailyModelIdentity("2026-02-01", "fixture:bedrock", "arn"),
  );
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
  const accumulator = createUsageAggregateAccumulator();
  for (const [provider, model, tokens] of [
    ["fixture", "bedrock::arn", 10],
    ["fixture::bedrock", "arn", 20],
    ["fixture", "bedrock::arn", 15],
  ] as const) {
    accumulator.add({
      usage: usage({
        modelUsage: [{ provider, model, count: 1, totals: usage({ totalTokens: tokens }) }],
        dailyModelUsage: [{ date: "2026-03-12", provider, model, tokens, cost: 0, count: 1 }],
      }),
    });
  }
  const aggregates = accumulator.finish();
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
  const accumulator = createUsageAggregateAccumulator();
  const earlier = "2026-03-11";
  const later = "2026-03-12";
  const quick = latency(2, 50, 20, 90, 80);
  const slow = latency(1, 120, 120, 120);
  accumulator.add({
    usage: usage({
      latency: quick,
      dailyLatency: [{ date: later, ...quick }],
      dailyBreakdown: [
        day(later, { input: 3, totalTokens: 3, totalCost: 4, inputCost: 4 }),
        day(earlier, { totalTokens: 5, totalCost: 6 }),
      ],
      dailyModelUsage: [modelDay(later, "one", 3, 4, 2, "fixture")],
    }),
  });
  accumulator.add({
    usage: usage({
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
    }),
  });
  const aggregates = accumulator.finish();
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
