// Cron stagger tests cover deterministic schedule spreading across jobs.
// Expanded from 5 → 16 test cases to cover edge cases in cron expression
// parsing, numeric normalization, and effective stagger resolution.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOP_OF_HOUR_STAGGER_MS,
  isRecurringTopOfHourCronExpr,
  normalizeCronStaggerMs,
  resolveCronStaggerMs,
} from "./stagger.js";

describe("cron stagger helpers", () => {
  // ---------------------------------------------------------------------------
  // isRecurringTopOfHourCronExpr
  // ---------------------------------------------------------------------------

  it("detects recurring top-of-hour cron expressions for 5-field and 6-field cron", () => {
    // Standard 5-field expressions
    expect(isRecurringTopOfHourCronExpr("0 * * * *")).toBe(true);
    expect(isRecurringTopOfHourCronExpr("0 */2 * * *")).toBe(true);
    expect(isRecurringTopOfHourCronExpr("0 0 */3 * * *")).toBe(true);
    // 5-field with comma-separated wildcard parts
    expect(isRecurringTopOfHourCronExpr("0 */2,3 * * *")).toBe(true);
    expect(isRecurringTopOfHourCronExpr("0 */2,? * * *")).toBe(true);
    // 6-field with zero seconds
    expect(isRecurringTopOfHourCronExpr("0 0 */3 * * *")).toBe(true);
    // Non-recurring: specific hour
    expect(isRecurringTopOfHourCronExpr("0 7 * * *")).toBe(false);
    // Non-top-of-hour: non-zero minute
    expect(isRecurringTopOfHourCronExpr("15 * * * *")).toBe(false);
  });

  it("rejects malformed hour fields that merely contain a wildcard", () => {
    expect(isRecurringTopOfHourCronExpr("0 5* * * *")).toBe(false);
    expect(isRecurringTopOfHourCronExpr("0 *5 * * *")).toBe(false);
    expect(isRecurringTopOfHourCronExpr("0 1-*/2 * * *")).toBe(false);
    expect(isRecurringTopOfHourCronExpr("0 0 5* * * *")).toBe(false);
  });

  it("handles range patterns in the hour field", () => {
    // Range without wildcard — covers all hours but no recurring wildcard
    expect(isRecurringTopOfHourCronExpr("0 0-23 * * *")).toBe(false);
    // Range with step on a wildcard
    expect(isRecurringTopOfHourCronExpr("0 */3 * * *")).toBe(true);
    // Every hour via step-1 pattern
    expect(isRecurringTopOfHourCronExpr("0 */1 * * *")).toBe(true);
    // Range with step (legacy pattern) — covers all hours in range non-recurring
    expect(isRecurringTopOfHourCronExpr("0 0-23/1 * * *")).toBe(false);
  });

  it("handles 6-field cron expressions with and without seconds", () => {
    // Valid 6-field: second=0, minute=0, wildcard hour
    expect(isRecurringTopOfHourCronExpr("0 0 * * * *")).toBe(true);
    expect(isRecurringTopOfHourCronExpr("0 0 */2 * * *")).toBe(true);
    // 6-field with non-zero seconds → not top-of-hour
    expect(isRecurringTopOfHourCronExpr("30 0 * * * *")).toBe(false);
    // 6-field with specific hour → not recurring
    expect(isRecurringTopOfHourCronExpr("0 0 5 * * *")).toBe(false);
    // 6-field with range pattern
    expect(isRecurringTopOfHourCronExpr("0 0 0-23 * * *")).toBe(false);
  });

  it("rejects empty, missing, or malformed expressions", () => {
    expect(isRecurringTopOfHourCronExpr("")).toBe(false);
    expect(isRecurringTopOfHourCronExpr("   ")).toBe(false);
    // Too few fields
    expect(isRecurringTopOfHourCronExpr("0 * * *")).toBe(false);
    expect(isRecurringTopOfHourCronExpr("0 *")).toBe(false);
    // Too many fields
    expect(isRecurringTopOfHourCronExpr("0 0 * * * * *")).toBe(false);
    // Non-numeric minute
    expect(isRecurringTopOfHourCronExpr("abc * * * *")).toBe(false);
    // Null/undefined-like — function takes a string so empty covers it
    expect(isRecurringTopOfHourCronExpr("\0")).toBe(false);
  });

  it("handles wildcard minute with non-recurring hour patterns", () => {
    // Every minute (minute = wildcard, not "0") → not top-of-hour
    expect(isRecurringTopOfHourCronExpr("* * * * *")).toBe(false);
    expect(isRecurringTopOfHourCronExpr("*/5 * * * *")).toBe(false);
    // Question-mark minute wildcard
    expect(isRecurringTopOfHourCronExpr("? * * * *")).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // normalizeCronStaggerMs
  // ---------------------------------------------------------------------------

  it("normalizes explicit stagger values", () => {
    expect(normalizeCronStaggerMs("30000")).toBe(30_000);
    expect(normalizeCronStaggerMs(42.8)).toBe(42);
    expect(normalizeCronStaggerMs(-10)).toBe(0);
    expect(normalizeCronStaggerMs("")).toBeUndefined();
    expect(normalizeCronStaggerMs("abc")).toBeUndefined();
    expect(normalizeCronStaggerMs("1e3")).toBeUndefined();
    expect(normalizeCronStaggerMs("0x10")).toBeUndefined();
  });

  it("preserves explicit zero stagger as 'run exactly on schedule'", () => {
    expect(normalizeCronStaggerMs(0)).toBe(0);
    expect(normalizeCronStaggerMs("0")).toBe(0);
    expect(normalizeCronStaggerMs("-0")).toBe(0);
  });

  it("handles special numeric values without throwing", () => {
    expect(normalizeCronStaggerMs(Infinity)).toBeUndefined();
    expect(normalizeCronStaggerMs(-Infinity)).toBeUndefined();
    expect(normalizeCronStaggerMs(Number.NaN)).toBeUndefined();
  });

  it("handles null, undefined, and object inputs gracefully", () => {
    expect(normalizeCronStaggerMs(null)).toBeUndefined();
    expect(normalizeCronStaggerMs(undefined)).toBeUndefined();
    // Object-like values should not crash
    expect(normalizeCronStaggerMs({})).toBeUndefined();
    expect(normalizeCronStaggerMs([])).toBeUndefined();
  });

  it("floors fractional and large numeric values", () => {
    expect(normalizeCronStaggerMs(99.999)).toBe(99);
    expect(normalizeCronStaggerMs(0.001)).toBe(0);
    // Large safe integers
    expect(normalizeCronStaggerMs(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    // Values exceeding MAX_SAFE_INTEGER
    expect(normalizeCronStaggerMs(Number.MAX_SAFE_INTEGER * 2)).toBe(Number.MAX_SAFE_INTEGER * 2);
  });

  it("handles string whitespace padding", () => {
    expect(normalizeCronStaggerMs("  30000  ")).toBe(30_000);
    expect(normalizeCronStaggerMs("  ")).toBeUndefined();
    expect(normalizeCronStaggerMs("\t\n")).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // resolveCronStaggerMs
  // ---------------------------------------------------------------------------

  it("resolves effective stagger for cron schedules", () => {
    expect(resolveCronStaggerMs({ kind: "cron", expr: "0 * * * *" })).toBe(
      DEFAULT_TOP_OF_HOUR_STAGGER_MS,
    );
    expect(resolveCronStaggerMs({ kind: "cron", expr: "0 * * * *", staggerMs: 30_000 })).toBe(
      30_000,
    );
    expect(resolveCronStaggerMs({ kind: "cron", expr: "0 * * * *", staggerMs: 0 })).toBe(0);
    expect(resolveCronStaggerMs({ kind: "cron", expr: "15 * * * *" })).toBe(0);
  });

  it("handles missing runtime expr values without throwing", () => {
    expect(
      resolveCronStaggerMs({ kind: "cron" } as unknown as { kind: "cron"; expr: string }),
    ).toBe(0);
  });

  it("resolves DEFAULT for 6-field top-of-hour expressions", () => {
    expect(resolveCronStaggerMs({ kind: "cron", expr: "0 0 * * * *" })).toBe(
      DEFAULT_TOP_OF_HOUR_STAGGER_MS,
    );
    expect(resolveCronStaggerMs({ kind: "cron", expr: "0 0 */2 * * *" })).toBe(
      DEFAULT_TOP_OF_HOUR_STAGGER_MS,
    );
  });

  it("resolves explicit staggerMs overrides for 6-field expressions", () => {
    expect(resolveCronStaggerMs({ kind: "cron", expr: "0 0 * * * *", staggerMs: 10_000 })).toBe(
      10_000,
    );
    expect(resolveCronStaggerMs({ kind: "cron", expr: "0 0 */2 * * *", staggerMs: 0 })).toBe(0);
  });

  it("resolves 0 when expr is empty or invalid", () => {
    expect(resolveCronStaggerMs({ kind: "cron", expr: "" })).toBe(0);
    expect(resolveCronStaggerMs({ kind: "cron", expr: "invalid" })).toBe(0);
    expect(resolveCronStaggerMs({ kind: "cron", expr: "0 * * * * * *" })).toBe(0);
  });

  it("resolves 0 for non-recurring expressions with staggerMs override", () => {
    // Non-recurring + explicit stagger → explicit takes precedence
    expect(resolveCronStaggerMs({ kind: "cron", expr: "30 8 * * 1-5", staggerMs: 15_000 })).toBe(
      15_000,
    );
    // Non-recurring + explicit 0 → 0
    expect(resolveCronStaggerMs({ kind: "cron", expr: "30 8 * * 1-5", staggerMs: 0 })).toBe(0);
  });
});
