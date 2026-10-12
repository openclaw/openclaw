import { describe, expect, it } from "vitest";
import { createEmptyCostUsageTotals } from "../infra/session-cost-usage-totals.js";
import type { SessionCostSummary, UsageDailyBucket } from "../infra/session-cost-usage.types.js";
import { buildUsageOverview, mergeUsageOverviews } from "./usage-overview.js";
import { filterSessionsByQuery } from "./usage-query.js";
import type { UsageOverviewOptions } from "./usage-types.js";

function report(
  summary: Partial<SessionCostSummary>,
  dayBucket: UsageDailyBucket = { mode: "utc-offset", utcOffsetMinutes: 0 },
  options: UsageOverviewOptions = {},
) {
  return buildUsageOverview({
    sessions: [{ key: "session", agentId: "main", instances: [{ sessionFile: "fixture" }] }],
    summaries: [{ ...createEmptyCostUsageTotals(), ...summary }],
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

describe("overview calendar and elapsed allocation", () => {
  it.each([
    {
      name: "Los Angeles spring gap",
      timeZone: "America/Los_Angeles",
      start: "2026-03-08T09:30:00Z",
      end: "2026-03-08T10:30:00Z",
      local: [
        [1, 30, 480],
        [3, 30, 420],
      ],
      hours: [
        [1, 30],
        [3, 30],
      ],
    },
    {
      name: "Los Angeles repeated hour",
      timeZone: "America/Los_Angeles",
      start: "2026-11-01T08:30:00Z",
      end: "2026-11-01T10:30:00Z",
      local: [
        [1, 30, 420],
        [2, 30, 480],
      ],
      hours: [
        [1, 90],
        [2, 30],
      ],
    },
    {
      name: "Lord Howe half-hour spring gap",
      timeZone: "Australia/Lord_Howe",
      start: "2026-10-03T15:00:00Z",
      end: "2026-10-03T16:00:00Z",
      local: [
        [1, 30, -630],
        [3, 0, -660],
      ],
      hours: [
        [1, 30],
        [2, 30],
      ],
    },
    {
      name: "Lord Howe repeated half-hour",
      timeZone: "Australia/Lord_Howe",
      start: "2026-04-04T14:00:00Z",
      end: "2026-04-04T15:30:00Z",
      local: [
        [1, 0, -660],
        [2, 0, -630],
      ],
      hours: [[1, 90]],
    },
    {
      name: "Chatham spring transition at quarter to the hour",
      timeZone: "Pacific/Chatham",
      start: "2026-09-26T13:15:00Z",
      end: "2026-09-26T14:15:00Z",
      local: [
        [2, 0, -765],
        [4, 0, -825],
      ],
      hours: [
        [2, 45],
        [3, 15],
      ],
    },
    {
      name: "Chatham repeated hour at quarter to the hour",
      timeZone: "Pacific/Chatham",
      start: "2026-04-04T13:15:00Z",
      end: "2026-04-04T15:15:00Z",
      local: [
        [3, 0, -825],
        [4, 0, -765],
      ],
      hours: [
        [2, 15],
        [3, 105],
      ],
    },
    {
      name: "Kathmandu fixed fractional offset",
      timeZone: "Asia/Kathmandu",
      start: "2026-01-31T18:45:00Z",
      end: "2026-01-31T19:45:00Z",
      local: [
        [0, 30, -345],
        [1, 30, -345],
      ],
      hours: [
        [0, 30],
        [1, 30],
      ],
    },
    {
      name: "UTC exact hour endpoint",
      timeZone: "UTC",
      start: "2026-02-01T10:30:00Z",
      end: "2026-02-01T12:00:00Z",
      local: [
        [10, 30, 0],
        [12, 0, 0],
      ],
      hours: [
        [10, 30],
        [11, 60],
      ],
    },
    {
      name: "UTC millisecond boundary",
      timeZone: "UTC",
      start: "2026-02-01T10:59:59.999Z",
      end: "2026-02-01T11:00:00.001Z",
      local: [
        [10, 59, 0],
        [11, 0, 0],
      ],
      hours: [
        [10, 1],
        [11, 1],
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

  it("keeps zero-token activity at the final instant across a repeated hour", () => {
    const summary = {
      firstActivity: Date.parse("2026-11-01T08:30:00Z"),
      lastActivity: Date.parse("2026-11-01T10:00:00Z"),
      utcQuarterHourTokenUsage: [],
    };
    const zone = { mode: "time-zone", timeZone: "America/Los_Angeles" } as const;
    expect(report(summary, zone, { selectedHours: [2] }).overview.total).toBe(1);
    expect(report(summary, zone, { selectedHours: [3] }).overview.total).toBe(0);
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
    const first = {
      sessions: [
        {
          key: "family",
          agentId: "first",
          channel: "slack",
          creatorKey: "person",
          updatedAt: 20,
          instances: [{ sessionFile: "first" }, { sessionFile: "rotated" }],
        },
      ],
      summaries: [
        makeUsage(10, "2026-02-01", "provider::a", "model"),
        makeUsage(20, "2026-02-02", "provider", "a::model"),
      ],
    };
    const second = {
      sessions: [
        {
          key: "second",
          agentId: "second",
          channel: "slack",
          creatorKey: "person",
          updatedAt: 30,
          instances: [{ sessionFile: "second" }],
        },
      ],
      summaries: [makeUsage(30, "2026-02-01", "provider::a", "model")],
    };
    return [first, second];
  }

  it("merges family instances and all agents before selecting the page", () => {
    const options = { offset: 1, limit: 1, sort: "recent" as const };
    const dayBucket = { mode: "utc-offset" as const, utcOffsetMinutes: 0 };
    const slices = sources().map((source) => buildUsageOverview({ ...source, options, dayBucket }));
    const result = mergeUsageOverviews(slices, options);
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
      unfilteredSessionCount: 2,
    });
    expect(result.overview.filterOptions.agent).toEqual(["first", "second"]);
  });

  it("keeps an excluded agent's costs only in the calendar facet after day selection", () => {
    const dayBucket = { mode: "utc-offset" as const, utcOffsetMinutes: 0 };
    const options = { selectedDays: ["2026-02-01"], recentKeys: [] };
    const inputs = sources();
    const later = inputs[1]!;
    later.summaries[0]!.firstActivity = Date.parse("2026-02-03T10:00:00Z");
    later.summaries[0]!.lastActivity = Date.parse("2026-02-03T10:01:00Z");
    later.summaries[0]!.activityDates = ["2026-02-03"];
    later.summaries[0]!.dailyBreakdown![0]!.date = "2026-02-03";
    later.summaries[0]!.dailyMessageCounts![0]!.date = "2026-02-03";
    const result = mergeUsageOverviews(
      inputs.map((source) => buildUsageOverview({ ...source, options, dayBucket })),
      options,
    );
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

  it("keeps recently viewed order across agents before paging", () => {
    const options = {
      recentKeys: ["family", "second"],
      sort: "recent" as const,
      offset: 1,
      limit: 1,
    };
    const dayBucket = { mode: "utc-offset" as const, utcOffsetMinutes: 0 };
    const result = mergeUsageOverviews(
      sources().map((source) => buildUsageOverview({ ...source, options, dayBucket })),
      options,
    );
    expect(result.sessions.map((session) => session.key)).toEqual(["second"]);
    expect(result.overview.tableSessionCount).toBe(2);
    expect(result.totals.totalTokens).toBe(60);
  });

  it("counts activity independently of recently modified empty comparison rows", () => {
    const result = buildUsageOverview({
      sessions: ["active", "empty"].map((key) => ({
        key,
        agentId: "main",
        updatedAt: 2,
        instances: [{ sessionFile: key }],
      })),
      summaries: [
        { ...createEmptyCostUsageTotals(), firstActivity: 1, totalTokens: 7 },
        createEmptyCostUsageTotals(),
      ],
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
      sessions: [
        { key: "empty", agentId: "main", updatedAt: 2, instances: [{ sessionFile: "empty" }] },
      ],
      summaries: [createEmptyCostUsageTotals()],
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
    const sessions = ["first", "second"].map((key) => ({
      key,
      agentId: "main",
      instances: [{ sessionFile: key }],
    }));
    const options = { selectedDays: ["2026-02-01"], sort };
    const dayBucket = { mode: "utc-offset" as const, utcOffsetMinutes: 0 };
    const compact = buildUsageOverview({ sessions, summaries, options, dayBucket });
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
      sessions,
      summaries,
      options,
      dayBucket,
      compact: false,
    });
    expect(canonical.sessions.map((session) => [session.key, session.usage?.totalTokens])).toEqual([
      ["first", 100],
      ["second", 1000],
    ]);
    expect(canonical.sessions[0]?.usage?.dailyBreakdown).toHaveLength(2);
    expect(compact.overview).toMatchObject({
      tableSessionCount: 2,
      tableTotals: { tokens: 91, cost: 9.1, errors: 0 },
    });
  },
);
