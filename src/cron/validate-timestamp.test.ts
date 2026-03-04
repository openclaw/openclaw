import { describe, expect, it } from "vitest";
import { validateScheduleTimestamp } from "./validate-timestamp.js";
import type { CronSchedule } from "./types.js";

describe("validateScheduleTimestamp", () => {
  const NOW = Date.parse("2026-02-16T20:00:00.000Z");

  it("accepts kind='every' without checking timestamps", () => {
    const schedule = { kind: "every", everyMs: 60_000 } as CronSchedule;
    expect(validateScheduleTimestamp(schedule, NOW)).toEqual({ ok: true });
  });

  it("accepts kind='cron' without checking timestamps", () => {
    const schedule = { kind: "cron", expr: "0 * * * *" } as CronSchedule;
    expect(validateScheduleTimestamp(schedule, NOW)).toEqual({ ok: true });
  });

  it("accepts a future at timestamp", () => {
    const futureDate = new Date(NOW + 3_600_000).toISOString(); // 1 hour ahead
    const schedule = { kind: "at", at: futureDate } as CronSchedule;
    expect(validateScheduleTimestamp(schedule, NOW)).toEqual({ ok: true });
  });

  it("accepts a timestamp within the 1-minute grace period", () => {
    const recentPast = new Date(NOW - 30_000).toISOString(); // 30 seconds ago
    const schedule = { kind: "at", at: recentPast } as CronSchedule;
    expect(validateScheduleTimestamp(schedule, NOW)).toEqual({ ok: true });
  });

  it("rejects a timestamp more than 1 minute in the past", () => {
    const pastDate = new Date(NOW - 120_000).toISOString(); // 2 minutes ago
    const schedule = { kind: "at", at: pastDate } as CronSchedule;
    const result = validateScheduleTimestamp(schedule, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/in the past/);
    }
  });

  it("rejects a timestamp 1 year in the past (the LLM timestamp bug)", () => {
    // This is the exact bug: LLM computes Feb 16, 2025 instead of Feb 16, 2026
    const pastDate = new Date("2025-02-16T20:30:00.000Z").toISOString();
    const schedule = { kind: "at", at: pastDate } as CronSchedule;
    const result = validateScheduleTimestamp(schedule, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/in the past/);
      expect(result.message).toMatch(/minutes ago/);
    }
  });

  it("rejects a timestamp more than 10 years in the future", () => {
    const farFuture = new Date(NOW + 11 * 365.25 * 86_400_000).toISOString();
    const schedule = { kind: "at", at: farFuture } as CronSchedule;
    const result = validateScheduleTimestamp(schedule, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/too far in the future/);
    }
  });

  it("rejects an invalid at value", () => {
    const schedule = { kind: "at", at: "not-a-date" } as CronSchedule;
    const result = validateScheduleTimestamp(schedule, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/Invalid schedule\.at/i);
    }
  });

  it("rejects missing at field on kind='at'", () => {
    const schedule = { kind: "at" } as CronSchedule;
    const result = validateScheduleTimestamp(schedule, NOW);
    expect(result.ok).toBe(false);
  });

  it("uses Date.now() as default when nowMs not provided", () => {
    const farFuture = new Date(Date.now() + 3_600_000).toISOString();
    const schedule = { kind: "at", at: farFuture } as CronSchedule;
    // Should use Date.now() internally and accept the future timestamp
    expect(validateScheduleTimestamp(schedule)).toEqual({ ok: true });
  });
});
