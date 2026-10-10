import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveCronCreateScheduleFromArgs,
  resolveCronEditScheduleRequest,
} from "./schedule-options.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("resolveCronCreateScheduleFromArgs positional schedule", () => {
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

  it.each(["9am standup with the team today", "run standup every single day"])(
    "rejects a %j positional that is not a parseable cron expression",
    (input) => {
      expect(() => resolveCronCreateScheduleFromArgs({ positionalSchedule: input })).toThrow(
        /Invalid cron expression/,
      );
    },
  );

  it("quotes the offending expression and shows valid examples", () => {
    expect(() =>
      resolveCronCreateScheduleFromArgs({ positionalSchedule: "9am standup with the team today" }),
    ).toThrow(
      'Invalid cron expression "9am standup with the team today". Use 5 fields like "0 9 * * *" or 6 fields like "0 0 9 * * *".',
    );
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

  it("keeps stagger metadata on valid cron schedules", () => {
    expect(resolveCronCreateScheduleFromArgs({ cron: "0 9 * * *", stagger: "5m" })).toEqual({
      kind: "cron",
      expr: "0 9 * * *",
      tz: undefined,
      staggerMs: 300_000,
    });
  });
});

describe("resolveCronCreateScheduleFromArgs --cron validation", () => {
  it("rejects an invalid --cron expression with the quoted input", () => {
    expect(() => resolveCronCreateScheduleFromArgs({ cron: "9am standup" })).toThrow(
      'Invalid cron expression "9am standup". Use 5 fields like "0 9 * * *" or 6 fields like "0 0 9 * * *".',
    );
  });

  it("keeps valid --cron expressions and preserves --tz", () => {
    expect(resolveCronCreateScheduleFromArgs({ cron: "0 9 * * *", tz: "Asia/Shanghai" })).toEqual({
      kind: "cron",
      expr: "0 9 * * *",
      tz: "Asia/Shanghai",
      staggerMs: undefined,
    });
  });

  it("reports an invalid --tz before validating the expression", () => {
    expect(() => resolveCronCreateScheduleFromArgs({ cron: "0 9 * * *", tz: "Not/AZone" })).toThrow(
      /Invalid --tz/,
    );
  });
});

describe("resolveCronEditScheduleRequest --cron validation", () => {
  it("rejects an invalid --cron expression", () => {
    expect(() => resolveCronEditScheduleRequest({ cron: "9am standup" })).toThrow(
      /Invalid cron expression/,
    );
  });
});
