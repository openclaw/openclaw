import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCronCreateScheduleFromArgs } from "./schedule-options.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("resolveCronCreateScheduleFromArgs positional schedule disambiguation", () => {
  it("routes an every-prefixed positional to the every slot only", () => {
    expect(resolveCronCreateScheduleFromArgs({ positionalSchedule: "every 10m" })).toEqual({
      kind: "every",
      everyMs: 600_000,
    });
  });

  it.each([
    "every day at 9am sharp",
    "every 1h of the day",
    "every tuesday at 9am",
    "every minute",
  ])("reports an invalid --every for %j instead of a schedule-count error", (input) => {
    expect(() => resolveCronCreateScheduleFromArgs({ positionalSchedule: input })).toThrow(
      "Invalid --every. Use a duration like 10m, 1h, or 1d.",
    );
  });

  it("treats 5- and 6-field positionals as cron schedules", () => {
    expect(resolveCronCreateScheduleFromArgs({ positionalSchedule: "0 9 * * *" })).toEqual({
      kind: "cron",
      expr: "0 9 * * *",
      tz: undefined,
      staggerMs: undefined,
    });
    expect(resolveCronCreateScheduleFromArgs({ positionalSchedule: "0 0 9 * * *" })).toEqual({
      kind: "cron",
      expr: "0 0 9 * * *",
      tz: undefined,
      staggerMs: undefined,
    });
  });

  it("falls back to an at schedule for other positionals", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-25T00:00:00.000Z"));
    expect(resolveCronCreateScheduleFromArgs({ positionalSchedule: "30m" })).toEqual({
      kind: "at",
      at: "2026-05-25T00:30:00.000Z",
    });
    expect(
      resolveCronCreateScheduleFromArgs({ positionalSchedule: "2027-01-01T00:00:00Z" }),
    ).toEqual({ kind: "at", at: "2027-01-01T00:00:00.000Z" });
  });

  it("reports an invalid --tz before validating the expression", () => {
    expect(() => resolveCronCreateScheduleFromArgs({ cron: "0 9 * * *", tz: "Not/AZone" })).toThrow(
      /Invalid --tz/,
    );
  });
});
