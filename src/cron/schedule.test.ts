import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { Cron } from "croner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeNextRunAtMs, computePreviousRunAtMs } from "./schedule.js";
import type { CronSchedule } from "./types.js";

const cronConstructed = vi.hoisted(() => vi.fn());

vi.mock("croner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("croner")>();
  class ObservedCron<T = undefined> extends actual.Cron<T> {
    constructor(...args: ConstructorParameters<typeof actual.Cron<T>>) {
      super(...args);
      cronConstructed(...args);
    }
  }
  return { ...actual, Cron: ObservedCron };
});

function expectOccurrences(schedule: CronSchedule, now: string, next?: string, previous?: string) {
  const nowMs = Date.parse(now);
  expect(computeNextRunAtMs(schedule, nowMs)).toBe(next ? Date.parse(next) : undefined);
  expect(computePreviousRunAtMs(schedule, nowMs)).toBe(previous ? Date.parse(previous) : undefined);
}

describe("cron schedule", () => {
  beforeEach(() => {
    cronConstructed.mockClear();
  });

  describe("daylight-saving transitions", () => {
    it.each([
      [
        "Lord Howe repeated half-hour skips duplicate per-second occurrences",
        "Australia/Lord_Howe",
        "* * * * * *",
        ["2026-04-04T15:10:00.000Z", "2026-04-04T15:30:00.000Z", "2026-04-04T14:59:59.000Z"],
      ],
      [
        "New York preserves the final valid second before a spring-forward gap",
        "America/New_York",
        "59 59 1,2 * * *",
        ["2027-03-14T07:05:00.000Z", "2027-03-15T05:59:59.000Z", "2027-03-14T06:59:59.000Z"],
      ],
      [
        "Oslo skips a nonexistent spring-forward reminder",
        "Europe/Oslo",
        "30 2 * * *",
        ["2026-03-29T00:45:00.000Z", "2026-03-30T00:30:00.000Z", "2026-03-28T01:30:00.000Z"],
      ],
    ] as const)("%s", (_label, tz, expr, [now, next, previous]) => {
      expectOccurrences({ kind: "cron", expr, tz }, now, next, previous);
    });

    it.each([
      [
        "skips nonexistent future occurrences but preserves historical timezone rules",
        "30 2 * 3 SUN#2",
        "2026-01-01T00:00:00.000Z",
        "2006-03-12T07:30:00.000Z",
      ],
      [
        "never spills a nonexistent year-limited reminder into another year",
        "0 30 2 14 3 * 2027",
        "2026-07-01T00:00:00.000Z",
        undefined,
      ],
      [
        "recovers the first occurrence of a year-limited reminder during its repeated hour",
        "0 30 1 1 11 * 2026",
        "2026-11-01T06:15:00.000Z",
        "2026-11-01T05:30:00.000Z",
      ],
    ] as const)("%s", (_name, expr, now, previous) => {
      expectOccurrences({ kind: "cron", expr, tz: "America/New_York" }, now, undefined, previous);
    });

    it.each([
      {
        label: "next-second retry rejects a real spring-forward gap",
        now: "2027-03-14T06:45:00.000Z",
        forcedPastCalls: 1,
      },
      {
        label: "tomorrow retry rejects a real spring-forward gap",
        now: "2027-03-13T23:45:00.000Z",
        forcedPastCalls: 2,
      },
    ])("$label", ({ now, forcedPastCalls }) => {
      const spy = vi.spyOn(Cron.prototype, "nextRun");
      for (let count = 0; count < forcedPastCalls; count += 1) {
        spy.mockImplementationOnce(() => new Date("2027-03-13T07:30:00.000Z"));
      }
      try {
        expect(
          computeNextRunAtMs(
            { kind: "cron", expr: "30 2 * * *", tz: "America/New_York" },
            Date.parse(now),
          ),
        ).toBe(Date.parse("2027-03-15T06:30:00.000Z"));
      } finally {
        spy.mockRestore();
      }
    });
  });

  it("throws a clear error when cron expr is missing at runtime", () => {
    const nowMs = Date.parse("2025-12-13T00:00:00.000Z");
    const malformed = { kind: "cron" } as unknown as { kind: "cron"; expr: string; tz?: string };
    expect(() => computeNextRunAtMs(malformed, nowMs)).toThrow(
      "invalid cron schedule: expr is required",
    );
  });

  it("computes next run for every schedule when anchorMs is not provided", () => {
    const now = Date.parse("2025-12-13T00:00:00.000Z");
    expect(computeNextRunAtMs({ kind: "every", everyMs: 30_000 }, now)).toBe(now + 30_000);
  });

  it("rejects every schedule numbers outside the ECMAScript Date range", () => {
    for (const fields of [
      { everyMs: MAX_DATE_TIMESTAMP_MS + 1 },
      { everyMs: 1, anchorMs: MAX_DATE_TIMESTAMP_MS + 1 },
      { everyMs: 0.5, anchorMs: 0 },
      { everyMs: 1, anchorMs: -1 },
    ]) {
      expect(computeNextRunAtMs({ kind: "every", ...fields }, 0)).toBeUndefined();
    }
  });

  it("returns undefined instead of throwing for an invalid NaN cursor", () => {
    expect(computeNextRunAtMs({ kind: "every", everyMs: 60_000 }, Number.NaN)).toBeUndefined();
    expectOccurrences({ kind: "cron", expr: "0 * * * *", tz: "UTC" }, "invalid");
  });

  it("reuses compiled cron evaluators for the same expression/timezone", () => {
    const nowMs = Date.parse("2026-03-01T00:00:00.000Z");
    for (const [tz, next] of [
      ["Asia/Shanghai", "2026-03-02T00:00:00.000Z"],
      ["UTC", "2026-03-01T08:00:00.000Z"],
    ] as const) {
      const schedule = { kind: "cron" as const, expr: "0 8 * * *", tz };
      expect(computeNextRunAtMs(schedule, nowMs)).toBe(Date.parse(next));
      const constructions = cronConstructed.mock.calls.length;
      expect(computeNextRunAtMs(schedule, nowMs + 1_000)).toBe(Date.parse(next));
      expect(cronConstructed).toHaveBeenCalledTimes(constructions);
    }
  });

  it("advances to next day when job completes within same second it fired (#17821)", () => {
    const noonMs = Date.parse("2026-02-08T12:00:00.000Z");
    // Returning the firing second here caused a scheduler spin loop.
    expect(computeNextRunAtMs({ kind: "cron", expr: "0 0 12 * * *", tz: "UTC" }, noonMs + 21)).toBe(
      noonMs + 86_400_000,
    );
  });
  it("never reports a time-due run for event stream schedules", () => {
    expect(computeNextRunAtMs({ kind: "stream", command: ["node", "events.mjs"] }, 0)).toBe(
      undefined,
    );
  });
});
