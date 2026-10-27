import { expect, it } from "vitest";
import { createEmptyCostUsageTotals } from "../infra/session-cost-usage-totals.js";
import type { SessionCostSummary, UsageDailyBucket } from "../infra/session-cost-usage.types.js";
import {
  buildUsageModelCohortReport,
  prepareUsageModelCohorts,
  selectUsageModelCohorts,
  type UsageModelCohorts,
} from "./usage-model-cohorts.js";
import { buildUsageOverview } from "./usage-overview.js";
import type { SessionUsageEntry, UsageOverviewOptions } from "./usage-types.js";

const utc: UsageDailyBucket = { mode: "utc-offset", utcOffsetMinutes: 0 };
const date = "2026-08-01";
const timestamp = Date.parse(`${date}T12:00:00Z`);

function row(
  key: string,
  modelTokens: Record<string, number>,
  extra: Partial<SessionCostSummary> = {},
): SessionUsageEntry {
  const tokens = Object.values(modelTokens).reduce((total, value) => total + value, 0);
  const totals = {
    ...createEmptyCostUsageTotals(),
    input: tokens,
    totalTokens: tokens,
    totalCost: tokens / 2,
    inputCost: tokens / 2,
  };
  return {
    key,
    updatedAt: timestamp,
    label: "Equal label",
    agentId: "main",
    channel: "web",
    usage: {
      ...totals,
      firstActivity: timestamp,
      lastActivity: timestamp,
      durationMs: 100,
      activityDates: [date],
      modelUsage: Object.entries(modelTokens).map(([model, value]) => ({
        provider: "synthetic",
        model,
        count: 1,
        totals: {
          ...createEmptyCostUsageTotals(),
          input: value,
          totalTokens: value,
          totalCost: value / 2,
          inputCost: value / 2,
        },
      })),
      dailyBreakdown: [{ date, ...totals, tokens, cost: tokens / 2 }],
      dailyModelUsage: Object.entries(modelTokens).map(([model, value]) => ({
        date,
        model,
        provider: "synthetic",
        tokens: value,
        cost: value / 2,
        count: 1,
      })),
      messageCounts: { total: 4, user: 1, assistant: 1, toolCalls: 1, toolResults: 1, errors: 0 },
      dailyMessageCounts: [
        { date, total: 4, user: 1, assistant: 1, toolCalls: 1, toolResults: 1, errors: 0 },
      ],
      toolUsage: { totalCalls: 1, uniqueTools: 1, tools: [{ name: "read", count: 1 }] },
      ...extra,
    },
  };
}

function report(
  prepared: UsageModelCohorts,
  options: UsageOverviewOptions = {},
  dayBucket: UsageDailyBucket = utc,
) {
  const selected = selectUsageModelCohorts(prepared, options);
  if (!selected) throw new Error("Expected model-only cohort query");
  return buildUsageModelCohortReport(selected, options, dayBucket);
}

it("counts whole multi-model sessions once across substring and alternative model filters", () => {
  const rows = [
    row("mixed", { Alpha: 10, Beta: 90 }),
    row("alpha", { Alpha: 20 }),
    row("beta", { Beta: 30 }),
  ];
  const prepared = prepareUsageModelCohorts(rows, utc);
  for (const [query, expectedTokens, expectedSessions] of [
    ["model:alpha", 120, 2],
    ["model:BETA", 130, 2],
    ["model:alpha model:beta", 150, 3],
    ["model:PH model:alpha", 120, 2],
    ["model:missing", 0, 0],
    ["", 150, 3],
  ] as const) {
    const result = report(prepared, { query });
    expect(result.totals.totalTokens).toBe(expectedTokens);
    expect(result.overview.selectedSessionCount).toBe(expectedSessions);
    expect(result.overview.filterOptions.model).toEqual(["Alpha", "Beta"]);
    expect(result).toEqual(buildUsageOverview({ rows, options: { query }, dayBucket: utc }));
  }
});

it("preserves tied order and first-selected metadata when cohorts interleave", () => {
  const rows = [
    row(
      "excluded",
      { excluded: 0 },
      { toolUsage: { totalCalls: 1, uniqueTools: 1, tools: [{ name: "later", count: 1 }] } },
    ),
    row("a-first", { A: 10 }),
    row(
      "b",
      { B: 10 },
      { toolUsage: { totalCalls: 1, uniqueTools: 1, tools: [{ name: "first", count: 1 }] } },
    ),
    row(
      "a-later",
      { A: 10 },
      { toolUsage: { totalCalls: 1, uniqueTools: 1, tools: [{ name: "later", count: 1 }] } },
    ),
  ];
  rows[1]!.usage!.modelUsage = [
    { model: "other", provider: "separate", count: 1, totals: createEmptyCostUsageTotals() },
  ];
  rows[2]!.usage!.modelUsage = [{ model: "other", count: 1, totals: createEmptyCostUsageTotals() }];
  rows[3]!.usage!.modelUsage = [
    { model: "other", provider: "unknown", count: 1, totals: createEmptyCostUsageTotals() },
  ];
  rows[1]!.model = "A";
  rows[2]!.model = "B";
  rows[3]!.model = "A";
  // The A cohort starts first, but its "later" tool follows the B cohort's "first".
  rows[1]!.usage!.toolUsage = { totalCalls: 0, uniqueTools: 0, tools: [] };
  rows[1]!.creatorKey = "unrelated";
  rows[2]!.createdActor = { type: "human", source: "channel", id: "first" };
  rows[3]!.createdActor = { type: "human", source: "channel", id: "later" };
  const options = { query: "model:A model:B", sort: "tokens", limit: 2 } as const;
  const result = report(prepareUsageModelCohorts(rows, utc), options);
  expect(result.sessions.map(({ key }) => key)).toEqual(["a-first", "b"]);
  expect(result.aggregates.tools.tools.map(({ name }) => name)).toEqual(["first", "later"]);
  expect(result).toEqual(buildUsageOverview({ rows, options, dayBucket: utc }));
});

it("merges daily, hourly, creator, latency and unavailable-cost facets without changing pages", () => {
  const rows: SessionUsageEntry[] = [
    row("a", { Alpha: 10 }, { latency: { count: 2, avgMs: 10, minMs: 4, maxMs: 16, p95Ms: 16 } }),
    row("b", { Beta: 20 }, { latency: { count: 2, avgMs: 30, minMs: 20, maxMs: 40, p95Ms: 40 } }),
    row(
      "a-b",
      { Alpha: 10, Beta: 10 },
      {
        usageReport: { state: "unavailable" },
        missingCostEntries: 1,
        missingCostByModel: { "synthetic/Beta": 1 },
        dailyLatency: [{ date, count: 2, avgMs: 20, minMs: 10, maxMs: 30, p95Ms: 30 }],
      },
    ),
    { key: "pending", model: "Alpha", usage: null, computing: true },
  ];
  for (const dayBucket of [utc, { mode: "time-zone", timeZone: "Asia/Kolkata" }] as const) {
    const prepared = prepareUsageModelCohorts(rows, dayBucket);
    for (const sort of ["tokens", "cost", "messages", "errors", "recent"] as const) {
      const options = {
        query: "model:alpha model:beta",
        sort,
        sortDirection: "asc",
        limit: 2,
        offset: 1,
      } as const;
      const result = report(prepared, options, dayBucket);
      expect(result.totals.totalTokens).toBe(50);
      expect(result.totals.usageReport).toEqual({ state: "unavailable" });
      expect(result.aggregates.latency?.avgMs).toBe(20);
      expect(result.overview.selectedRowCount).toBe(4);
      expect(result).toEqual(buildUsageOverview({ rows, options, dayBucket }));
    }
  }
});

it("leaves day, hour, session, recent and non-model predicates on the general path", () => {
  const prepared = prepareUsageModelCohorts([row("a", { Alpha: 10 })], utc);
  for (const options of [
    { query: "model:" },
    { query: "alpha" },
    { query: "model:alpha minTokens:5" },
    { query: "provider:synthetic" },
    { query: "has:context" },
    { query: "unknown:value" },
    { selectedDays: [date] },
    { selectedHours: [12] },
    { selectedSessions: ["a"] },
    { recentKeys: [] },
  ])
    expect(selectUsageModelCohorts(prepared, options)).toBeUndefined();
});

it("does not revisit original session usage when a prepared model filter changes", () => {
  const rows = Array.from({ length: 288 }, (_, index) =>
    row(`row-${index}`, { [`model-${index % 24}`]: 2 }),
  );
  let reads = 0;
  for (const entry of rows) {
    const usage = entry.usage;
    Object.defineProperty(entry, "usage", {
      get: () => {
        reads++;
        return usage;
      },
    });
  }
  const prepared = prepareUsageModelCohorts(rows, utc);
  expect(reads).toBeGreaterThan(0);
  reads = 0;
  const result = report(prepared, { query: "model:model-23", limit: 5 });
  expect(result.totals.totalTokens).toBe(24);
  expect(result.sessions).toHaveLength(5);
  expect(reads).toBe(0);
});
