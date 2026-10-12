// Cron schedule tests cover schedule parsing and next-run calculations.
import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { Cron } from "croner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeNextRunAtMs, computePreviousRunAtMs } from "./schedule.js";

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

describe("cron schedule", () => {
  beforeEach(() => {
    cronConstructed.mockClear();
  });

  describe("daylight-saving transitions", () => {
    it.each([
      {
        label: "Lord Howe repeated half-hour skips duplicate per-second occurrences",
        timezone: "Australia/Lord_Howe",
        expression: "* * * * * *",
        now: "2026-04-04T15:10:00.000Z",
        next: "2026-04-04T15:30:00.000Z",
        previous: "2026-04-04T14:59:59.000Z",
      },
      {
        label: "New York preserves the final valid second before a spring-forward gap",
        timezone: "America/New_York",
        expression: "59 59 1,2 * * *",
        now: "2027-03-14T07:05:00.000Z",
        next: "2027-03-15T05:59:59.000Z",
        previous: "2027-03-14T06:59:59.000Z",
      },
      {
        label: "Oslo skips a nonexistent spring-forward reminder",
        timezone: "Europe/Oslo",
        expression: "30 2 * * *",
        now: "2026-03-29T00:45:00.000Z",
        next: "2026-03-30T00:30:00.000Z",
        previous: "2026-03-28T01:30:00.000Z",
      },
    ])("$label", ({ timezone, expression, now, next, previous }) => {
      const schedule = { kind: "cron" as const, expr: expression, tz: timezone };
      const nowMs = Date.parse(now);

      expect(computeNextRunAtMs(schedule, nowMs)).toBe(Date.parse(next));
      expect(computePreviousRunAtMs(schedule, nowMs)).toBe(Date.parse(previous));
    });

    it.each(["30 2 * 3 SUN#2"])(
      "skips nonexistent future occurrences but preserves historical timezone rules for %s",
      (expression) => {
        const schedule = { kind: "cron" as const, expr: expression, tz: "America/New_York" };
        const nowMs = Date.parse("2026-01-01T00:00:00.000Z");

        expect(computeNextRunAtMs(schedule, nowMs)).toBeUndefined();
        expect(computePreviousRunAtMs(schedule, nowMs)).toBe(
          Date.parse("2006-03-12T07:30:00.000Z"),
        );
      },
    );

    it("never spills a nonexistent year-limited reminder into another year", () => {
      const schedule = {
        kind: "cron" as const,
        expr: "0 30 2 14 3 * 2027",
        tz: "America/New_York",
      };
      const nowMs = Date.parse("2026-07-01T00:00:00.000Z");

      expect(computeNextRunAtMs(schedule, nowMs)).toBeUndefined();
      expect(computePreviousRunAtMs(schedule, nowMs)).toBeUndefined();
    });

    it("recovers the first occurrence of a year-limited reminder during its repeated hour", () => {
      const schedule = {
        kind: "cron" as const,
        expr: "0 30 1 1 11 * 2026",
        tz: "America/New_York",
      };
      const nowMs = Date.parse("2026-11-01T06:15:00.000Z");

      expect(computeNextRunAtMs(schedule, nowMs)).toBeUndefined();
      expect(computePreviousRunAtMs(schedule, nowMs)).toBe(Date.parse("2026-11-01T05:30:00.000Z"));
    });

    it.each([
      {
        label: "next-second retry rejects a real spring-forward gap",
        timezone: "America/New_York",
        expression: "30 2 * * *",
        now: "2027-03-14T06:45:00.000Z",
        prior: "2027-03-13T07:30:00.000Z",
        forcedPastCalls: 1,
        expected: "2027-03-15T06:30:00.000Z",
      },
      {
        label: "tomorrow retry rejects a real spring-forward gap",
        timezone: "America/New_York",
        expression: "30 2 * * *",
        now: "2027-03-13T23:45:00.000Z",
        prior: "2027-03-13T07:30:00.000Z",
        forcedPastCalls: 2,
        expected: "2027-03-15T06:30:00.000Z",
      },
    ])("$label", ({ timezone, expression, now, prior, forcedPastCalls, expected }) => {
      const spy = vi.spyOn(Cron.prototype, "nextRun");
      for (let count = 0; count < forcedPastCalls; count += 1) {
        spy.mockImplementationOnce(() => new Date(prior));
      }
      try {
        expect(
          computeNextRunAtMs({ kind: "cron", expr: expression, tz: timezone }, Date.parse(now)),
        ).toBe(Date.parse(expected));
      } finally {
        spy.mockRestore();
      }
    });
  });

  it("throws a clear error when cron expr is missing at runtime", () => {
    const nowMs = Date.parse("2025-12-13T00:00:00.000Z");
    expect(() =>
      computeNextRunAtMs(
        {
          kind: "cron",
        } as unknown as { kind: "cron"; expr: string; tz?: string },
        nowMs,
      ),
    ).toThrow("invalid cron schedule: expr is required");
  });

  it("computes next run for every schedule when anchorMs is not provided", () => {
    const now = Date.parse("2025-12-13T00:00:00.000Z");
    const next = computeNextRunAtMs({ kind: "every", everyMs: 30_000 }, now);

    // Should return nowMs + everyMs, not nowMs (which would cause infinite loop)
    expect(next).toBe(now + 30_000);
  });

  it("rejects every schedule numbers outside the ECMAScript Date range", () => {
    expect(
      computeNextRunAtMs({ kind: "every", everyMs: MAX_DATE_TIMESTAMP_MS + 1 }, 0),
    ).toBeUndefined();
    expect(
      computeNextRunAtMs({ kind: "every", everyMs: 1, anchorMs: MAX_DATE_TIMESTAMP_MS + 1 }, 0),
    ).toBeUndefined();
    expect(computeNextRunAtMs({ kind: "every", everyMs: 0.5, anchorMs: 0 }, 0)).toBeUndefined();
    expect(computeNextRunAtMs({ kind: "every", everyMs: 1, anchorMs: -1 }, 0)).toBeUndefined();
  });

  it.each([["NaN", Number.NaN]])(
    "returns undefined instead of throwing for an invalid %s cursor",
    (_label, nowMs) => {
      expect(computeNextRunAtMs({ kind: "every", everyMs: 60_000 }, nowMs)).toBeUndefined();
      expect(
        computeNextRunAtMs({ kind: "cron", expr: "0 * * * *", tz: "UTC" }, nowMs),
      ).toBeUndefined();
      expect(
        computePreviousRunAtMs({ kind: "cron", expr: "0 * * * *", tz: "UTC" }, nowMs),
      ).toBeUndefined();
    },
  );

  it("reuses compiled cron evaluators for the same expression/timezone", () => {
    const nowMs = Date.parse("2026-03-01T00:00:00.000Z");
    expect(
      computeNextRunAtMs({ kind: "cron", expr: "0 8 * * *", tz: "Asia/Shanghai" }, nowMs),
    ).toBe(Date.parse("2026-03-02T00:00:00.000Z"));
    const initialConstructions = cronConstructed.mock.calls.length;
    expect(
      computeNextRunAtMs({ kind: "cron", expr: "0 8 * * *", tz: "Asia/Shanghai" }, nowMs + 1_000),
    ).toBe(Date.parse("2026-03-02T00:00:00.000Z"));
    expect(cronConstructed).toHaveBeenCalledTimes(initialConstructions);

    expect(computeNextRunAtMs({ kind: "cron", expr: "0 8 * * *", tz: "UTC" }, nowMs)).toBe(
      Date.parse("2026-03-01T08:00:00.000Z"),
    );
    const timezoneConstructions = cronConstructed.mock.calls.length;
    expect(computeNextRunAtMs({ kind: "cron", expr: "0 8 * * *", tz: "UTC" }, nowMs + 1_000)).toBe(
      Date.parse("2026-03-01T08:00:00.000Z"),
    );
    expect(cronConstructed).toHaveBeenCalledTimes(timezoneConstructions);
  });

  describe("cron with specific seconds (6-field pattern)", () => {
    // Pattern: fire at exactly second 0 of minute 0 of hour 12 every day
    const dailyNoon = { kind: "cron" as const, expr: "0 0 12 * * *", tz: "UTC" };
    const noonMs = Date.parse("2026-02-08T12:00:00.000Z");

    it("advances to next day when job completes within same second it fired (#17821)", () => {
      // Regression test for #17821: cron jobs that fire and complete within
      // the same second (e.g., fire at 12:00:00.014, complete at 12:00:00.021)
      // were getting nextRunAtMs set to the same second, causing a spin loop.
      //
      // Simulating: job scheduled for 12:00:00, fires at .014, completes at .021
      const completedAtMs = noonMs + 21; // 12:00:00.021
      const next = computeNextRunAtMs(dailyNoon, completedAtMs);
      expect(next).toBe(noonMs + 86_400_000); // must be next day, NOT noonMs
    });
  });
});

describe("computeNextRunAtMs stream", () => {
  it("never reports a time-due run for event stream schedules", () => {
    expect(computeNextRunAtMs({ kind: "stream", command: ["node", "events.mjs"] }, 0)).toBe(
      undefined,
    );
  });
});
