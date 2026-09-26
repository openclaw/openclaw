// @vitest-environment node
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  buildUsageCostWindows,
  buildUsageCostWindowSummary,
  formatDayLabel,
  formatFullDate,
} from "./metrics.ts";

function runZonedMetrics(source: string, timeZone: string) {
  // TZ must be set before V8 starts; changing it inside a Vitest worker is insufficient.
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        `
          import assert from "node:assert/strict";
          import { buildPeakErrorHours, sessionTouchesSelectedHours } from ${JSON.stringify(new URL("./metrics.ts", import.meta.url).href)};
          ${source}
        `,
      ],
      {
        cwd: new URL("../../../../", import.meta.url),
        env: { ...process.env, TZ: timeZone },
        encoding: "utf8",
        timeout: 10_000,
      },
    ),
  );
}

describe("usage metrics across real timezone boundaries", () => {
  it("filters zero-token sessions across a repeated hour and includes the final instant", () => {
    expect(
      runZonedMetrics(
        `
          const firstActivity = Date.parse("2026-11-01T08:30:00Z");
          const lastActivity = Date.parse("2026-11-01T10:30:00Z");
          assert.deepEqual(
            [firstActivity, lastActivity].map((ms) => {
              const date = new Date(ms);
              return [date.getHours(), date.getMinutes(), date.getTimezoneOffset()];
            }),
            [[1, 30, 420], [2, 30, 480]],
          );
          const session = {
            key: "timestamped-zero-token-session",
            usage: {
              firstActivity, lastActivity, totalTokens: 0,
              utcQuarterHourTokenUsage: [
                { date: "2026-11-01", quarterIndex: 34, totalTokens: 0 },
                { date: "2026-11-01", quarterIndex: 42, totalTokens: 0 },
              ],
            },
          };
          const endpoint = {
            ...session,
            usage: { ...session.usage, lastActivity: Date.parse("2026-11-01T10:00:00Z") },
          };
          process.stdout.write(JSON.stringify([
            sessionTouchesSelectedHours(session, [2], "local"),
            sessionTouchesSelectedHours(session, [3], "local"),
            sessionTouchesSelectedHours(endpoint, [2], "local"),
          ]));
        `,
        "America/Los_Angeles",
      ),
    ).toEqual([true, false, true]);
  });

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
  ] as const)(
    "allocates elapsed messages through $name",
    ({ timeZone, start, end, local, hours }) => {
      const messages = hours.reduce<number>((total, [, count]) => total + count, 0);
      const modes = timeZone === "UTC" ? ["local", "utc"] : ["local"];
      const result = runZonedMetrics(
        `
        const firstActivity = Date.parse(${JSON.stringify(start)});
        const lastActivity = Date.parse(${JSON.stringify(end)});
        assert.deepEqual(
          [firstActivity, lastActivity].map((ms) => {
            const date = new Date(ms);
            return [date.getHours(), date.getMinutes(), date.getTimezoneOffset()];
          }),
          ${JSON.stringify(local)},
        );
        const session = {
          key: "elapsed-message-session",
          usage: {
            firstActivity, lastActivity,
            messageCounts: { total: ${messages}, errors: ${messages} },
          },
        };
        process.stdout.write(JSON.stringify(
          ${JSON.stringify(modes)}.map((mode) => buildPeakErrorHours([session], mode)),
        ));
      `,
        timeZone,
      );
      expect(result).toEqual(
        modes.map(() =>
          hours.map(([hour, count]) => ({
            label: new Date(Date.UTC(1970, 0, 1, hour)).toLocaleTimeString(undefined, {
              hour: "numeric",
              timeZone: "UTC",
            }),
            value: "100.00%",
            sub: `${count} errors · ${count} msgs`,
          })),
        ),
      );
    },
  );
});

function costDay(date: string, totalCost: number, totalTokens: number) {
  return {
    date,
    input: totalTokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    totalCost,
    inputCost: totalCost,
    outputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    missingCostEntries: 0,
  };
}

describe("usage metrics date labels", () => {
  it("formats YYYY-MM-DD values as local calendar dates", () => {
    const date = new Date(2026, 1, 1);
    expect(formatDayLabel("2026-02-01")).toBe(
      date.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    );
    expect(formatFullDate("2026-02-01")).toBe(
      date.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" }),
    );
  });

  it("leaves invalid day labels unchanged", () => {
    expect(formatDayLabel("2026-02-31")).toBe("2026-02-31");
    expect(formatFullDate("2026-02-31")).toBe("2026-02-31");
  });
});

describe("usage cost windows", () => {
  const daily = [
    costDay("2026-06-01", 1, 100),
    costDay("2026-06-25", 4, 400),
    costDay("2026-07-01", 5, 500),
  ];

  it("uses calendar windows instead of the last non-empty rows", () => {
    const windows = buildUsageCostWindows(daily, "2026-06-01", "2026-07-01", [30, 7, 31, 7]);

    expect(windows.map(({ days, startDate, endDate }) => ({ days, startDate, endDate }))).toEqual([
      { days: 7, startDate: "2026-06-25", endDate: "2026-07-01" },
      { days: 30, startDate: "2026-06-02", endDate: "2026-07-01" },
    ]);
    expect(windows.map((window) => window.totals.totalCost)).toEqual([9, 9]);
    expect(windows.map((window) => window.totals.totalTokens)).toEqual([900, 900]);
  });

  it("keeps the selected-range total separate from shorter comparisons", () => {
    const range = buildUsageCostWindowSummary(daily, "2026-06-01", "2026-07-01");

    expect(range?.days).toBe(31);
    expect(range?.totals.totalCost).toBe(10);
    expect(range?.totals.totalTokens).toBe(1_000);
  });

  it("rejects malformed and reversed ranges", () => {
    expect(buildUsageCostWindows(daily, "bad", "2026-07-01")).toEqual([]);
    expect(buildUsageCostWindowSummary(daily, "2026-07-02", "2026-07-01")).toBeNull();
  });
});
