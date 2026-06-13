// Cron stagger tests cover deterministic schedule spreading across jobs.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOP_OF_HOUR_STAGGER_MS,
  isRecurringTopOfHourCronExpr,
  normalizeCronStaggerMs,
  resolveDefaultCronStaggerMs,
  resolveCronStaggerMs,
} from "./stagger.js";

describe("cron stagger helpers", () => {
  it("detects recurring top-of-hour cron expressions for 5-field and 6-field cron", () => {
    expect(isRecurringTopOfHourCronExpr("0 * * * *")).toBe(true);
    expect(isRecurringTopOfHourCronExpr("0 */2 * * *")).toBe(true);
    expect(isRecurringTopOfHourCronExpr("0 0 */3 * * *")).toBe(true);
    expect(isRecurringTopOfHourCronExpr("0 */2,3 * * *")).toBe(true);
    expect(isRecurringTopOfHourCronExpr("0 */2,? * * *")).toBe(true);
    expect(isRecurringTopOfHourCronExpr("0 7 * * *")).toBe(false);
    expect(isRecurringTopOfHourCronExpr("15 * * * *")).toBe(false);
  });

  it("rejects malformed hour fields that merely contain a wildcard", () => {
    expect(isRecurringTopOfHourCronExpr("0 5* * * *")).toBe(false);
    expect(isRecurringTopOfHourCronExpr("0 *5 * * *")).toBe(false);
    expect(isRecurringTopOfHourCronExpr("0 1-*/2 * * *")).toBe(false);
    expect(isRecurringTopOfHourCronExpr("0 0 5* * * *")).toBe(false);
  });

  it("normalizes explicit stagger values", () => {
    expect(normalizeCronStaggerMs("30000")).toBe(30_000);
    expect(normalizeCronStaggerMs(42.8)).toBe(42);
    expect(normalizeCronStaggerMs(-10)).toBe(0);
    expect(normalizeCronStaggerMs("")).toBeUndefined();
    expect(normalizeCronStaggerMs("abc")).toBeUndefined();
    expect(normalizeCronStaggerMs("1e3")).toBeUndefined();
    expect(normalizeCronStaggerMs("0x10")).toBeUndefined();
  });

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

  it("detects 6-field top-of-hour expressions (second minute hour …)", () => {
    // second=0, minute=0, hour=* → true
    expect(isRecurringTopOfHourCronExpr("0 0 * * * *")).toBe(true);
    // second=0, minute=0, hour=*/6 → true (contains *)
    expect(isRecurringTopOfHourCronExpr("0 0 */6 * * *")).toBe(true);
    // second≠0 → false
    expect(isRecurringTopOfHourCronExpr("1 0 * * * *")).toBe(false);
    // minute≠0 → false
    expect(isRecurringTopOfHourCronExpr("0 5 * * * *")).toBe(false);
    // hour field has no wildcard → false
    expect(isRecurringTopOfHourCronExpr("0 0 1 * * *")).toBe(false);
  });

  it("returns false for range-only hour fields, wrong field counts, and empty input", () => {
    // Range without * in 5-field hour slot → false
    expect(isRecurringTopOfHourCronExpr("0 0-23 * * *")).toBe(false);
    // 4 fields → false
    expect(isRecurringTopOfHourCronExpr("* * * *")).toBe(false);
    // 7 fields → false
    expect(isRecurringTopOfHourCronExpr("0 0 * * * * *")).toBe(false);
    // Empty string → false
    expect(isRecurringTopOfHourCronExpr("")).toBe(false);
  });

  it("tolerates extra surrounding and internal whitespace in cron expressions", () => {
    expect(isRecurringTopOfHourCronExpr("  0   *   *   *   *  ")).toBe(true);
    expect(isRecurringTopOfHourCronExpr("  15   *   *   *   *  ")).toBe(false);
  });

  it("normalizes non-numeric and special-value stagger inputs", () => {
    expect(normalizeCronStaggerMs(undefined)).toBeUndefined();
    expect(normalizeCronStaggerMs(null)).toBeUndefined();
    expect(normalizeCronStaggerMs(Infinity)).toBeUndefined();
    expect(normalizeCronStaggerMs(-Infinity)).toBeUndefined();
    expect(normalizeCronStaggerMs(NaN)).toBeUndefined();
    expect(normalizeCronStaggerMs("Infinity")).toBeUndefined();
    expect(normalizeCronStaggerMs("NaN")).toBeUndefined();
    // Zero is a valid explicit-disable value
    expect(normalizeCronStaggerMs(0)).toBe(0);
    expect(normalizeCronStaggerMs("0")).toBe(0);
    // Whitespace-padded integer string
    expect(normalizeCronStaggerMs("  42  ")).toBe(42);
  });

  it("resolveDefaultCronStaggerMs returns default stagger only for top-of-hour expressions", () => {
    expect(resolveDefaultCronStaggerMs("0 * * * *")).toBe(DEFAULT_TOP_OF_HOUR_STAGGER_MS);
    expect(resolveDefaultCronStaggerMs("0 */2 * * *")).toBe(DEFAULT_TOP_OF_HOUR_STAGGER_MS);
    expect(resolveDefaultCronStaggerMs("15 * * * *")).toBeUndefined();
    expect(resolveDefaultCronStaggerMs("0 7 * * *")).toBeUndefined();
    expect(resolveDefaultCronStaggerMs("")).toBeUndefined();
  });

  it("resolveCronStaggerMs falls through to default when staggerMs is non-finite", () => {
    // NaN → normalized to undefined → falls through to default
    expect(resolveCronStaggerMs({ kind: "cron", expr: "0 * * * *", staggerMs: NaN })).toBe(
      DEFAULT_TOP_OF_HOUR_STAGGER_MS,
    );
    // Infinity → normalized to undefined → falls through to default
    expect(resolveCronStaggerMs({ kind: "cron", expr: "0 * * * *", staggerMs: Infinity })).toBe(
      DEFAULT_TOP_OF_HOUR_STAGGER_MS,
    );
    // String staggerMs (narrow cast) is normalized to a valid number
    expect(
      resolveCronStaggerMs({
        kind: "cron",
        expr: "0 * * * *",
        staggerMs: "30000" as unknown as number,
      }),
    ).toBe(30_000);
  });
});
