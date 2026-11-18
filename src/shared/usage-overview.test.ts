import { expect, it } from "vitest";
import { createEmptyCostUsageTotals } from "../infra/session-cost-usage-totals.js";
import type { SessionCostSummary, UsageDailyBucket } from "../infra/session-cost-usage.types.js";
import { createUsageAggregateAccumulator, usageModelIdentity } from "./usage-aggregates.js";
import { buildUsageOverview } from "./usage-overview.js";
import type { SessionUsageEntry, UsageOverviewOptions } from "./usage-types.js";

const utc: UsageDailyBucket = { mode: "utc-offset", utcOffsetMinutes: 0 };
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
