import { describe, expect, it } from "vitest";
import { createEmptyCostUsageTotals } from "../infra/session-cost-usage-totals.js";
import type { SessionCostSummary, UsageDailyBucket } from "../infra/session-cost-usage.types.js";
import { buildUsageOverview } from "./usage-overview.js";
import { filterSessionsByQuery } from "./usage-query.js";
import type { UsageOverviewOptions } from "./usage-types.js";

function report(
  summary: Partial<SessionCostSummary>,
  dayBucket: UsageDailyBucket = { mode: "utc-offset", utcOffsetMinutes: 0 },
  options: UsageOverviewOptions = {},
) {
  return buildUsageOverview({
    rows: [
      { key: "session", agentId: "main", usage: { ...createEmptyCostUsageTotals(), ...summary } },
    ],
    options,
    dayBucket,
  });
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
  const complete = {
    ...createEmptyCostUsageTotals(),
    input: 40,
    inputCost: 1,
    totalTokens: 40,
    totalCost: 1,
  };
  const interrupted = {
    ...createEmptyCostUsageTotals(),
    input: 75,
    inputCost: 2,
    totalTokens: 75,
    totalCost: 2,
    usageReport: { state: "unavailable" as const },
    activityDates: ["2026-05-14", "2026-05-15"],
    dailyBreakdown: [
      { ...complete, date: "2026-05-14", tokens: 40, cost: 1 },
      {
        ...createEmptyCostUsageTotals(),
        date: "2026-05-15",
        tokens: 0,
        cost: 0,
        usageReport: { state: "unavailable" as const },
      },
    ],
  };
  const rows = [
    { key: "complete", updatedAt: 2, usage: complete },
    { key: "interrupted", updatedAt: 1, usage: interrupted },
  ];
  const all = buildUsageOverview({
    rows,
    options: { limit: 1 },
    dayBucket: { mode: "utc-offset", utcOffsetMinutes: 0 },
  });
  expect(all.sessions.map((row) => row.key)).toEqual(["complete"]);
  expect(all.totals.usageReport).toEqual({ state: "unavailable" });
  expect(all.overview.tableTotals).toEqual({
    tokens: 115,
    cost: 3,
    errors: 0,
    usageReport: { state: "unavailable" },
  });
  const selected = buildUsageOverview({
    rows: [rows[1]!],
    options: { selectedDays: ["2026-05-14"] },
    dayBucket: { mode: "utc-offset", utcOffsetMinutes: 0 },
  });
  expect(selected.overview.usageReport).toEqual({ state: "unavailable" });
  expect(selected.totals.usageReport).toBeUndefined();
  expect(selected.overview.tableTotals).toEqual({ tokens: 40, cost: 1, errors: 0 });
  expect(selected.sessions[0]?.usage).toMatchObject({
    input: 40,
    inputCost: 1,
    totalTokens: 40,
    totalCost: 1,
  });
  expect(selected.sessions[0]?.usage?.usageReport).toBeUndefined();
});

describe("overview calendar and elapsed allocation", () => {
  it.each([
    {
      name: "Los Angeles repeated hour",
      timeZone: "America/Los_Angeles",
      start: "2026-11-01T08:30:00Z",
      end: "2026-11-01T10:30:00Z",
      hours: [
        [1, 90],
        [2, 30],
      ],
    },
    {
      name: "Chatham spring transition at quarter to the hour",
      timeZone: "Pacific/Chatham",
      start: "2026-09-26T13:15:00Z",
      end: "2026-09-26T14:15:00Z",
      hours: [
        [2, 45],
        [3, 15],
      ],
    },
  ] as const)("allocates elapsed messages through $name", ({ timeZone, start, end, hours }) => {
    const messages = hours.reduce<number>((sum, [, count]) => sum + count, 0);
    const result = report(
      {
        firstActivity: Date.parse(start),
        lastActivity: Date.parse(end),
        totalTokens: messages,
        messageCounts: {
          total: messages,
          user: 0,
          assistant: 0,
          toolCalls: 0,
          toolResults: 0,
          errors: messages,
        },
      },
      { mode: "time-zone", timeZone },
    );
    const expected = Array<number>(24).fill(0);
    for (const [hour, count] of hours) {
      expected[hour] = count;
    }
    expect(result.overview.hourlyMessages).toEqual(expected);
    expect(result.overview.hourlyErrors).toEqual(expected);
    expect(result.overview.hourTokens).toEqual(expected);
  });

  it("prefers valid positive token quarters for selection and ignores malformed coordinates", () => {
    const quarter = {
      date: "2026-02-01",
      quarterIndex: 40,
      totalTokens: 100,
      input: 0,
      output: 100,
      cacheRead: 0,
      cacheWrite: 0,
      totalCost: 0,
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
      messageCounts: { total: 15, errors: 5, user: 0, assistant: 0, toolCalls: 0, toolResults: 0 },
      utcQuarterHourMessageCounts: [0, 3].map((quarterIndex, index) => ({
        date: "2026-03-15",
        quarterIndex,
        total: index ? 5 : 10,
        errors: index ? 3 : 2,
        user: 0,
        assistant: 0,
        toolCalls: 0,
        toolResults: 0,
      })),
    });
    expect(result.overview.hourTokens[10]).toBe(100);
    expect(result.overview.hourlyMessages[0]).toBe(15);
    expect(result.overview.hourlyErrors[0]).toBe(5);
    expect(result.overview.hourlyMessages[10]).toBe(0);
  });
});

describe("overview family and multi-agent accounting", () => {
  function sources() {
    const makeUsage = (
      tokens: number,
      date: string,
      provider: string,
      model: string,
    ): SessionCostSummary => {
      const totals = {
        ...createEmptyCostUsageTotals(),
        totalTokens: tokens,
        totalCost: tokens / 10,
        missingCostEntries: 1,
        missingCostByModel: { [provider + "/" + model]: 1 },
      };
      return {
        ...totals,
        firstActivity: Date.parse(date + "T10:00:00Z"),
        lastActivity: Date.parse(date + "T10:01:00Z"),
        activityDates: [date],
        dailyBreakdown: [{ ...totals, date, tokens, cost: tokens / 10 }],
        dailyMessageCounts: [
          { date, total: 1, user: 0, assistant: 1, toolCalls: 1, toolResults: 0, errors: 0 },
        ],
        modelUsage: [{ provider, model, count: 1, totals }],
        messageCounts: { total: 1, user: 0, assistant: 1, toolCalls: 1, toolResults: 0, errors: 0 },
        toolUsage: { totalCalls: 1, uniqueTools: 1, tools: [{ name: "read", count: 1 }] },
      };
    };
    const firstDay = makeUsage(10, "2026-02-01", "provider::a", "model");
    const secondDay = makeUsage(20, "2026-02-02", "provider", "a::model");
    const first = {
      key: "family",
      agentId: "first",
      channel: "slack",
      creatorKey: "person",
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
        messageCounts: { total: 2, user: 0, assistant: 2, toolCalls: 2, toolResults: 0, errors: 0 },
        toolUsage: { totalCalls: 2, uniqueTools: 1, tools: [{ name: "read", count: 2 }] },
      },
    };
    const second = {
      key: "second",
      agentId: "second",
      channel: "slack",
      creatorKey: "person",
      updatedAt: 30,
      usage: makeUsage(30, "2026-02-01", "provider::a", "model"),
    };
    return [first, second];
  }

  it("aggregates prepared family rows and all agents before selecting the page", () => {
    const options = { offset: 1, limit: 1, sort: "recent" as const };
    const dayBucket = { mode: "utc-offset" as const, utcOffsetMinutes: 0 };
    const inputs = sources();
    const result = buildUsageOverview({
      rows: inputs,
      options,
      dayBucket,
    });
    expect(result.sessions.map((session) => session.key)).toEqual(["family"]);
    expect(result.sessions[0]?.usage?.totalTokens).toBe(30);
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
    expect(result.aggregates.byChannel).toMatchObject([
      { channel: "slack", totals: { totalTokens: 60 } },
    ]);
    expect(result.aggregates.byCreator).toMatchObject([
      { key: "person", sessionCount: 2, totals: { totalTokens: 60 } },
    ]);
    expect(result.aggregates.tools.totalCalls).toBe(3);
    expect(result.overview).toMatchObject({
      total: 2,
      selectedSessionCount: 2,
      selectedRowCount: 2,
      selectedRows: [],
      unfilteredSessionCount: 2,
    });
    expect(result.overview.filterOptions.agent).toEqual(["first", "second"]);
  });

  it("keeps an excluded agent's costs only in the calendar facet after day selection", () => {
    const dayBucket = { mode: "utc-offset" as const, utcOffsetMinutes: 0 };
    const options = { selectedDays: ["2026-02-01"], recentKeys: [] };
    const inputs = sources();
    const later = inputs[1]!;
    later.usage.firstActivity = Date.parse("2026-02-03T10:00:00Z");
    later.usage.lastActivity = Date.parse("2026-02-03T10:01:00Z");
    later.usage.activityDates = ["2026-02-03"];
    later.usage.dailyBreakdown![0]!.date = "2026-02-03";
    later.usage.dailyMessageCounts![0]!.date = "2026-02-03";
    const result = buildUsageOverview({
      rows: inputs,
      options,
      dayBucket,
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
    expect(result.aggregates.byAgent).toMatchObject([
      { agentId: "first", totals: { totalTokens: 30 } },
    ]);
    expect(result.aggregates.byCreator).toMatchObject([
      { key: "person", totals: { totalTokens: 10 }, sessionCount: 1 },
    ]);
  });

  it("counts activity independently of recently modified empty comparison rows", () => {
    const result = buildUsageOverview({
      rows: ["active", "empty"].map((key) => ({
        key,
        agentId: "main",
        updatedAt: 2,
        usage:
          key === "active"
            ? { ...createEmptyCostUsageTotals(), firstActivity: 1, totalTokens: 7 }
            : createEmptyCostUsageTotals(),
      })),
      options: {},
      dayBucket: { mode: "utc-offset", utcOffsetMinutes: 0 },
    });
    expect(result.overview).toMatchObject({
      total: 2,
      selectedSessionCount: 1,
      selectedRowCount: 2,
      unfilteredSessionCount: 2,
    });
    expect(result.aggregates.sessionCount).toBe(1);
    expect(result.totals.totalTokens).toBe(7);
    const emptySelected = buildUsageOverview({
      rows: [{ key: "empty", agentId: "main", updatedAt: 2, usage: createEmptyCostUsageTotals() }],
      options: { selectedSessions: ["empty"] },
      dayBucket: { mode: "utc-offset", utcOffsetMinutes: 0 },
    });
    expect(emptySelected.overview).toMatchObject({ selectedSessionCount: 0, selectedRowCount: 1 });
  });
});

it.each(["tokens", "cost"] as const)(
  "sorts and displays compact %s for selected days while retaining canonical history",
  (sort) => {
    const summaries = (
      [
        [100, 90],
        [1000, 1],
      ] as const
    ).map(([total, selected]): SessionCostSummary =>
      Object.assign(createEmptyCostUsageTotals(), {
        totalTokens: total,
        totalCost: total / 10,
        firstActivity: 1,
        activityDates: ["2026-02-01", "2026-02-02"],
        dailyBreakdown: [selected, total - selected].map((tokens, index) =>
          Object.assign(createEmptyCostUsageTotals(), {
            date: index === 0 ? "2026-02-01" : "2026-02-02",
            tokens,
            totalTokens: tokens,
            cost: tokens / 10,
            totalCost: tokens / 10,
          }),
        ),
      }),
    );
    const rows = ["first", "second"].map((key, index) => ({
      key,
      agentId: "main",
      usage: summaries[index] ?? null,
    }));
    const options = {
      selectedDays: ["2026-02-01"],
      selectedSessions: ["second", "first"],
      sort,
    };
    const dayBucket = { mode: "utc-offset" as const, utcOffsetMinutes: 0 };
    const compact = buildUsageOverview({ rows, options, dayBucket });
    expect(
      compact.sessions.map((session) => [
        session.key,
        session.usage?.totalTokens,
        session.usage?.totalCost,
      ]),
    ).toEqual([
      ["first", 90, 9],
      ["second", 1, 0.1],
    ]);
    const canonical = buildUsageOverview({
      rows,
      options,
      dayBucket,
      compact: false,
    });
    expect(canonical.sessions.map((session) => [session.key, session.usage?.totalTokens])).toEqual([
      ["first", 100],
      ["second", 1000],
    ]);
    expect(canonical.sessions[0]?.usage?.dailyBreakdown).toHaveLength(2);
    expect(
      compact.overview.selectedRows.map((session) => [
        session.key,
        session.usage?.totalTokens,
        session.usage?.totalCost,
      ]),
    ).toEqual([
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
