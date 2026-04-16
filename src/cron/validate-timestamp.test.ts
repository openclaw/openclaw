import { describe, expect, it } from "vitest";
import type { CronSchedule } from "./types.js";
import { validateScheduleTimestamp } from "./validate-timestamp.js";

const NOW_MS = Date.parse("2026-04-16T12:00:00.000Z");
const ONE_MINUTE_MS = 60 * 1000;
const ONE_YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;

describe("validateScheduleTimestamp", () => {
  it("passes non-at schedules untouched (every)", () => {
    const schedule: CronSchedule = { kind: "every", everyMs: 60_000 };
    expect(validateScheduleTimestamp(schedule, NOW_MS)).toEqual({ ok: true });
  });

  it("passes non-at schedules untouched (cron)", () => {
    const schedule: CronSchedule = { kind: "cron", expr: "0 9 * * *", tz: "UTC" };
    expect(validateScheduleTimestamp(schedule, NOW_MS)).toEqual({ ok: true });
  });

  it("rejects empty at string", () => {
    const schedule: CronSchedule = { kind: "at", at: "" };
    const result = validateScheduleTimestamp(schedule, NOW_MS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("Invalid schedule.at");
    }
  });

  it("rejects whitespace-only at string", () => {
    const schedule: CronSchedule = { kind: "at", at: "   " };
    const result = validateScheduleTimestamp(schedule, NOW_MS);
    expect(result.ok).toBe(false);
  });

  it("rejects malformed ISO timestamps", () => {
    const schedule: CronSchedule = { kind: "at", at: "not-a-date" };
    const result = validateScheduleTimestamp(schedule, NOW_MS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("Invalid schedule.at");
      expect(result.message).toContain("not-a-date");
    }
  });

  it("accepts timestamps within the 1-minute grace window in the past", () => {
    // 30s in the past — inside the grace window
    const atMs = NOW_MS - 30 * 1000;
    const schedule: CronSchedule = { kind: "at", at: new Date(atMs).toISOString() };
    expect(validateScheduleTimestamp(schedule, NOW_MS)).toEqual({ ok: true });
  });

  it("accepts timestamps at exactly the 1-minute grace boundary", () => {
    // Exactly -60s → diffMs === -ONE_MINUTE_MS, not strictly less than -ONE_MINUTE_MS
    const atMs = NOW_MS - ONE_MINUTE_MS;
    const schedule: CronSchedule = { kind: "at", at: new Date(atMs).toISOString() };
    expect(validateScheduleTimestamp(schedule, NOW_MS)).toEqual({ ok: true });
  });

  it("rejects timestamps more than 1 minute in the past", () => {
    const atMs = NOW_MS - 2 * ONE_MINUTE_MS;
    const schedule: CronSchedule = { kind: "at", at: new Date(atMs).toISOString() };
    const result = validateScheduleTimestamp(schedule, NOW_MS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("in the past");
      expect(result.message).toContain("2 minutes ago");
    }
  });

  it("accepts timestamps 1 year in the future", () => {
    const atMs = NOW_MS + ONE_YEAR_MS;
    const schedule: CronSchedule = { kind: "at", at: new Date(atMs).toISOString() };
    expect(validateScheduleTimestamp(schedule, NOW_MS)).toEqual({ ok: true });
  });

  it("rejects timestamps more than 10 years in the future", () => {
    const atMs = NOW_MS + 11 * ONE_YEAR_MS;
    const schedule: CronSchedule = { kind: "at", at: new Date(atMs).toISOString() };
    const result = validateScheduleTimestamp(schedule, NOW_MS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("too far in the future");
      expect(result.message).toContain("11 years ahead");
    }
  });

  it("accepts epoch-ms strings for at timestamps", () => {
    const atMs = NOW_MS + 60 * 60 * 1000; // 1 hour ahead
    const schedule: CronSchedule = { kind: "at", at: String(atMs) };
    expect(validateScheduleTimestamp(schedule, NOW_MS)).toEqual({ ok: true });
  });

  it("accepts date-only strings as UTC midnight", () => {
    // NOW = 2026-04-16T12:00Z → date-only 2026-04-17 = +12h in the future
    const schedule: CronSchedule = { kind: "at", at: "2026-04-17" };
    expect(validateScheduleTimestamp(schedule, NOW_MS)).toEqual({ ok: true });
  });

  it("uses Date.now() as the default when nowMs is not provided", () => {
    // Very-far-future must still reject without an explicit nowMs
    const farFuture = new Date(Date.now() + 11 * ONE_YEAR_MS).toISOString();
    const schedule: CronSchedule = { kind: "at", at: farFuture };
    const result = validateScheduleTimestamp(schedule);
    expect(result.ok).toBe(false);
  });
});
