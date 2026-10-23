import { expect, it } from "vitest";
import {
  appendSessionUsageRollupContribution,
  buildSessionCostSummaryFromRollup,
  createSessionUsageRollupData,
} from "../../../../src/infra/session-cost-usage-rollup.js";
import { createEmptyCostUsageTotals } from "../../../../src/infra/session-cost-usage-totals.js";
import { createUsageAggregateAccumulator } from "../../../../src/shared/usage-aggregates.js";
import { buildProviderSeries } from "./provider-series.ts";

it.each([
  {
    name: "same model",
    sessions: [["anthropic", "anthropic"]],
    models: ["same", "same"],
    sessionCount: 1,
    messageCount: 2,
  },
  {
    name: "different models",
    sessions: [["anthropic", "anthropic"]],
    models: ["first", "second"],
    sessionCount: 1,
    messageCount: 2,
  },
  {
    name: "provider aliases",
    sessions: [["anthropic", "claude-cli"]],
    models: ["first", "second"],
    sessionCount: 1,
    messageCount: 2,
  },
  {
    name: "multiple sessions",
    sessions: [["anthropic", "anthropic"], ["anthropic"]],
    models: ["first", "second"],
    sessionCount: 2,
    messageCount: 3,
  },
])(
  "rolls real local usage up to one provider row across $name",
  ({ sessions, models, sessionCount, messageCount }) => {
    const accumulator = createUsageAggregateAccumulator();
    const start = Date.UTC(2026, 0, 1);
    for (const [sessionIndex, providers] of sessions.entries()) {
      const rollup = createSessionUsageRollupData();
      appendSessionUsageRollupContribution(rollup, {
        timestamp: start,
        role: "user",
        toolNames: [],
        toolResultCounts: { total: 0, errors: 0 },
      });
      for (const [index, provider] of providers.entries()) {
        appendSessionUsageRollupContribution(rollup, {
          timestamp: start + index + 1,
          role: "assistant",
          provider,
          model: models[index],
          toolNames: [],
          toolResultCounts: { total: 0, errors: 0 },
          usageTotals: {
            ...createEmptyCostUsageTotals(),
            input: 100,
            totalTokens: 100,
            totalCost: 1,
            inputCost: 1,
          },
        });
      }
      accumulator.add({
        usage: buildSessionCostSummaryFromRollup({
          rollup,
          sessionId: `qa-session-${sessionIndex}`,
          sessionFile: `qa-session-${sessionIndex}`,
          startMs: start,
          endMs: start + 10,
          includeUntimestamped: false,
          formatDay: (date) => date.toISOString().slice(0, 10),
        }),
      });
    }
    const aggregates = accumulator.finish();
    expect(aggregates.sessionCount).toBe(sessionCount);
    expect(aggregates.byProvider.reduce((total, entry) => total + entry.count, 0)).toBe(
      messageCount,
    );
    const series = buildProviderSeries(aggregates.modelDaily ?? []);
    expect(series.map(({ id, tokens }) => ({ id, tokens }))).toEqual([
      { id: "anthropic", tokens: messageCount * 100 },
    ]);
    expect([...series[0]!.byDate]).toEqual([
      ["2026-01-01", { tokens: messageCount * 100, cost: messageCount }],
    ]);
  },
);

it("keeps known providers on fixed colors and folds overflow into the shared tone", () => {
  const day = (provider: string, tokens: number) => ({
    date: "2026-01-01",
    provider,
    model: "m",
    tokens,
    cost: 0,
    count: 1,
  });
  const series = buildProviderSeries([
    day("openai", 10),
    day("fresh-a", 900),
    day("fresh-b", 800),
    day("fresh-c", 700),
    day("fresh-d", 600),
    day("fresh-e", 500),
  ]);
  const colorOf = (id: string) => series.find((entry) => entry.id === id)?.color;
  // Ranked by volume, but openai keeps its slot even with the least usage.
  expect(series.map((entry) => entry.id)).toEqual([
    "fresh-a",
    "fresh-b",
    "fresh-c",
    "fresh-d",
    "fresh-e",
    "openai",
  ]);
  expect(colorOf("openai")).toBe("var(--chart-series-1)");
  // Four free slots go to the largest unknown providers; the rest share the "other" tone.
  expect(new Set(["fresh-a", "fresh-b", "fresh-c", "fresh-d"].map(colorOf)).size).toBe(4);
  expect(["fresh-a", "fresh-b", "fresh-c", "fresh-d"].map(colorOf)).not.toContain(
    "var(--chart-series-1)",
  );
  expect(colorOf("fresh-e")).toBe("var(--oc-border-strong)");
});
