// Cron stagger tests cover deterministic schedule spreading across jobs.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOP_OF_HOUR_STAGGER_MS,
  isRecurringTopOfHourCronExpr,
  normalizeCronStaggerMs,
  resolveCronStaggerMs,
} from "./stagger.js";

describe("cron stagger helpers", () => {
  describe("isRecurringTopOfHourCronExpr", () => {
    it("detects recurring top-of-hour cron expressions for 5-field cron", () => {
      // Basic recurring patterns with wildcard hour
      expect(isRecurringTopOfHourCronExpr("0 * * * *")).toBe(true);
      expect(isRecurringTopOfHourCronExpr("0 */2 * * *")).toBe(true);
      expect(isRecurringTopOfHourCronExpr("0 */3 * * *")).toBe(true);
      expect(isRecurringTopOfHourCronExpr("0 */4 * * *")).toBe(true);
      expect(isRecurringTopOfHourCronExpr("0 */6 * * *")).toBe(true);
      expect(isRecurringTopOfHourCronExpr("0 */12 * * *")).toBe(true);

      // Mixed wildcard and specific hours (must contain * or ?)
      expect(isRecurringTopOfHourCronExpr("0 */2,3 * * *")).toBe(true);
      expect(isRecurringTopOfHourCronExpr("0 */2,? * * *")).toBe(true);
      expect(isRecurringTopOfHourCronExpr("0 ?,* * * *")).toBe(true);
      expect(isRecurringTopOfHourCronExpr("0 0,*/2 * * *")).toBe(true);
      expect(isRecurringTopOfHourCronExpr("0 *,0 * * *")).toBe(true);

      // Range patterns without wildcard are NOT recurring (they don't contain * or ?)
      expect(isRecurringTopOfHourCronExpr("0 0-23 * * *")).toBe(false);
      expect(isRecurringTopOfHourCronExpr("0 0-23/2 * * *")).toBe(false);
      expect(isRecurringTopOfHourCronExpr("0 0-23/3 * * *")).toBe(false);

      // Non-recurring patterns (specific hour only, no wildcard)
      expect(isRecurringTopOfHourCronExpr("0 7 * * *")).toBe(false);
      expect(isRecurringTopOfHourCronExpr("0 0 * * *")).toBe(false);
      expect(isRecurringTopOfHourCronExpr("0 12 * * *")).toBe(false);
      expect(isRecurringTopOfHourCronExpr("0 23 * * *")).toBe(false);
      expect(isRecurringTopOfHourCronExpr("0 1,2,3 * * *")).toBe(false);

      // Non-top-of-hour (minute != 0)
      expect(isRecurringTopOfHourCronExpr("15 * * * *")).toBe(false);
      expect(isRecurringTopOfHourCronExpr("30 */2 * * *")).toBe(false);
      expect(isRecurringTopOfHourCronExpr("45 0-23 * * *")).toBe(false);
    });

    it("detects recurring top-of-hour cron expressions for 6-field cron (with seconds)", () => {
      // Basic recurring patterns with seconds field
      expect(isRecurringTopOfHourCronExpr("0 0 * * * *")).toBe(true);
      expect(isRecurringTopOfHourCronExpr("0 0 */2 * * *")).toBe(true);
      expect(isRecurringTopOfHourCronExpr("0 0 */3 * * *")).toBe(true);

      // Range patterns without wildcard are NOT recurring
      expect(isRecurringTopOfHourCronExpr("0 0 0-23 * * *")).toBe(false);
      expect(isRecurringTopOfHourCronExpr("0 0 0-23/2 * * *")).toBe(false);

      // Mixed patterns (must contain * or ?)
      expect(isRecurringTopOfHourCronExpr("0 0 */2,3 * * *")).toBe(true);
      expect(isRecurringTopOfHourCronExpr("0 0 ?,* * * *")).toBe(true);
      expect(isRecurringTopOfHourCronExpr("0 0 *,0 * * *")).toBe(true);

      // Non-recurring patterns (specific hour only)
      expect(isRecurringTopOfHourCronExpr("0 0 7 * * *")).toBe(false);
      expect(isRecurringTopOfHourCronExpr("0 0 0 * * *")).toBe(false);
      expect(isRecurringTopOfHourCronExpr("0 0 1,2,3 * * *")).toBe(false);

      // Non-top-of-hour (seconds or minute != 0)
      expect(isRecurringTopOfHourCronExpr("30 0 * * * *")).toBe(false); // seconds != 0
      expect(isRecurringTopOfHourCronExpr("0 15 * * * *")).toBe(false); // minute != 0
      // Note: "0 0 */2 15 * *" has minute=0, second=0, hour=*/2 (wildcard) - it IS recurring top-of-hour
      // The day-of-month field (15) doesn't affect the top-of-hour classification
      expect(isRecurringTopOfHourCronExpr("0 0 */2 15 * *")).toBe(true);
      // "0 0 * 15 * *" - hour is wildcard, so it's recurring top-of-hour (runs at midnight on 15th of month)
      expect(isRecurringTopOfHourCronExpr("0 0 * 15 * *")).toBe(true);
      // Non-top-of-hour due to minute field
      expect(isRecurringTopOfHourCronExpr("0 30 * * * *")).toBe(false); // minute = 30
      expect(isRecurringTopOfHourCronExpr("0 15 0 * * *")).toBe(false); // minute = 15
    });

    it("rejects malformed hour fields that merely contain a wildcard", () => {
      // Wildcard embedded in numbers (not valid cron syntax but should be handled)
      expect(isRecurringTopOfHourCronExpr("0 5* * * *")).toBe(false);
      expect(isRecurringTopOfHourCronExpr("0 *5 * * *")).toBe(false);
      expect(isRecurringTopOfHourCronExpr("0 1-*/2 * * *")).toBe(false);
      expect(isRecurringTopOfHourCronExpr("0 0 5* * * *")).toBe(false);
      expect(isRecurringTopOfHourCronExpr("0 0 *5 * * *")).toBe(false);

      // Invalid step values - note: */0 still matches the pattern but is handled by cron runtime
      // The function only checks for structural pattern, not semantic validity
      expect(isRecurringTopOfHourCronExpr("0 */0 * * *")).toBe(true);
      expect(isRecurringTopOfHourCronExpr("0 0-23/0 * * *")).toBe(false); // range without wildcard

      // Edge cases with special characters
      expect(isRecurringTopOfHourCronExpr("0 *-* * * *")).toBe(false);
      expect(isRecurringTopOfHourCronExpr("0 ,* * * *")).toBe(false);
      expect(isRecurringTopOfHourCronExpr("0 *, * * *")).toBe(false);
    });

    it("handles edge cases and boundary conditions", () => {
      // Empty or whitespace
      expect(isRecurringTopOfHourCronExpr("")).toBe(false);
      expect(isRecurringTopOfHourCronExpr("   ")).toBe(false);

      // Too few fields
      expect(isRecurringTopOfHourCronExpr("0 * *")).toBe(false);
      expect(isRecurringTopOfHourCronExpr("0 *")).toBe(false);

      // Too many fields (should still parse first 5-6)
      expect(isRecurringTopOfHourCronExpr("0 * * * * extra")).toBe(false);

      // Non-standard field counts
      expect(isRecurringTopOfHourCronExpr("0 * * *")).toBe(false);
      expect(isRecurringTopOfHourCronExpr("0 * * * * * *")).toBe(false);
    });
  });

  describe("normalizeCronStaggerMs", () => {
    it("normalizes string numeric values", () => {
      expect(normalizeCronStaggerMs("30000")).toBe(30_000);
      expect(normalizeCronStaggerMs("0")).toBe(0);
      expect(normalizeCronStaggerMs("1")).toBe(1);
      expect(normalizeCronStaggerMs("60000")).toBe(60_000);
      expect(normalizeCronStaggerMs("3600000")).toBe(3_600_000); // 1 hour
    });

    it("normalizes numeric values", () => {
      expect(normalizeCronStaggerMs(30000)).toBe(30_000);
      expect(normalizeCronStaggerMs(42.8)).toBe(42);
      expect(normalizeCronStaggerMs(0)).toBe(0);
      expect(normalizeCronStaggerMs(1)).toBe(1);
      expect(normalizeCronStaggerMs(-10)).toBe(0); // Negative becomes 0
      expect(normalizeCronStaggerMs(-1000)).toBe(0);
      expect(normalizeCronStaggerMs(1.5)).toBe(1);
      expect(normalizeCronStaggerMs(99.99)).toBe(99);
    });

    it("returns undefined for invalid inputs", () => {
      expect(normalizeCronStaggerMs("")).toBeUndefined();
      expect(normalizeCronStaggerMs("   ")).toBeUndefined();
      expect(normalizeCronStaggerMs("abc")).toBeUndefined();
      expect(normalizeCronStaggerMs("1e3")).toBeUndefined();
      expect(normalizeCronStaggerMs("0x10")).toBeUndefined();
      expect(normalizeCronStaggerMs("Infinity")).toBeUndefined();
      expect(normalizeCronStaggerMs("NaN")).toBeUndefined();
      expect(normalizeCronStaggerMs(null)).toBeUndefined();
      expect(normalizeCronStaggerMs(undefined)).toBeUndefined();
      expect(normalizeCronStaggerMs({})).toBeUndefined();
      expect(normalizeCronStaggerMs([])).toBeUndefined();
      expect(normalizeCronStaggerMs(true)).toBeUndefined();
      expect(normalizeCronStaggerMs(false)).toBeUndefined();
    });

    it("handles special numeric values", () => {
      expect(normalizeCronStaggerMs(Infinity)).toBeUndefined();
      expect(normalizeCronStaggerMs(-Infinity)).toBeUndefined();
      expect(normalizeCronStaggerMs(Number.NaN)).toBeUndefined();
    });

    it("handles very large numbers", () => {
      expect(normalizeCronStaggerMs(86400000)).toBe(86_400_000); // 1 day
      expect(normalizeCronStaggerMs(Number.MAX_SAFE_INTEGER)).toBeGreaterThan(0);
    });
  });

  describe("resolveCronStaggerMs", () => {
    it("returns default stagger for recurring top-of-hour expressions", () => {
      // 5-field expressions with wildcard hour
      expect(resolveCronStaggerMs({ kind: "cron", expr: "0 * * * *" })).toBe(
        DEFAULT_TOP_OF_HOUR_STAGGER_MS,
      );
      expect(resolveCronStaggerMs({ kind: "cron", expr: "0 */2 * * *" })).toBe(
        DEFAULT_TOP_OF_HOUR_STAGGER_MS,
      );
      expect(resolveCronStaggerMs({ kind: "cron", expr: "0 */3 * * *" })).toBe(
        DEFAULT_TOP_OF_HOUR_STAGGER_MS,
      );
      expect(resolveCronStaggerMs({ kind: "cron", expr: "0 0,*/2 * * *" })).toBe(
        DEFAULT_TOP_OF_HOUR_STAGGER_MS,
      );

      // Range patterns without wildcard do NOT get default stagger
      expect(resolveCronStaggerMs({ kind: "cron", expr: "0 0-23 * * *" })).toBe(0);
      expect(resolveCronStaggerMs({ kind: "cron", expr: "0 0-23/2 * * *" })).toBe(0);

      // 6-field expressions with wildcard hour
      expect(resolveCronStaggerMs({ kind: "cron", expr: "0 0 * * * *" })).toBe(
        DEFAULT_TOP_OF_HOUR_STAGGER_MS,
      );
      expect(resolveCronStaggerMs({ kind: "cron", expr: "0 0 */2 * * *" })).toBe(
        DEFAULT_TOP_OF_HOUR_STAGGER_MS,
      );
    });

    it("respects explicit stagger overrides", () => {
      // Explicit staggerMs should override default
      expect(resolveCronStaggerMs({ kind: "cron", expr: "0 * * * *", staggerMs: 30_000 })).toBe(
        30_000,
      );
      expect(resolveCronStaggerMs({ kind: "cron", expr: "0 * * * *", staggerMs: 0 })).toBe(0);
      expect(resolveCronStaggerMs({ kind: "cron", expr: "0 * * * *", staggerMs: 600_000 })).toBe(
        600_000,
      );
      expect(resolveCronStaggerMs({ kind: "cron", expr: "0 * * * *", staggerMs: 30000 })).toBe(
        30_000,
      );
    });

    it("returns 0 for non-recurring cron expressions", () => {
      // Specific hour (not recurring)
      expect(resolveCronStaggerMs({ kind: "cron", expr: "0 7 * * *" })).toBe(0);
      expect(resolveCronStaggerMs({ kind: "cron", expr: "0 0 * * *" })).toBe(0);
      expect(resolveCronStaggerMs({ kind: "cron", expr: "0 12 * * *" })).toBe(0);

      // Non-top-of-hour
      expect(resolveCronStaggerMs({ kind: "cron", expr: "15 * * * *" })).toBe(0);
      expect(resolveCronStaggerMs({ kind: "cron", expr: "30 0 * * *" })).toBe(0);
      expect(resolveCronStaggerMs({ kind: "cron", expr: "0 30 * * *" })).toBe(0);
    });

    it("handles missing or invalid expr gracefully", () => {
      // Missing expr field
      expect(
        resolveCronStaggerMs({ kind: "cron" } as unknown as { kind: "cron"; expr: string }),
      ).toBe(0);

      // Empty expr
      expect(resolveCronStaggerMs({ kind: "cron", expr: "" })).toBe(0);

      // Whitespace expr
      expect(resolveCronStaggerMs({ kind: "cron", expr: "   " })).toBe(0);
    });

    it("returns 0 for non-cron schedule kinds", () => {
      // The function only handles cron kind; other kinds would need different handling
      // This tests that the function doesn't crash on unexpected input
      expect(
        resolveCronStaggerMs({ kind: "every", everyMs: 3600000 } as unknown as {
          kind: "cron";
          expr: string;
        }),
      ).toBe(0);
      expect(
        resolveCronStaggerMs({ kind: "at", at: "2024-01-01T00:00:00Z" } as unknown as {
          kind: "cron";
          expr: string;
        }),
      ).toBe(0);
    });
  });

  describe("DEFAULT_TOP_OF_HOUR_STAGGER_MS constant", () => {
    it("is set to 5 minutes", () => {
      expect(DEFAULT_TOP_OF_HOUR_STAGGER_MS).toBe(5 * 60 * 1000);
      expect(DEFAULT_TOP_OF_HOUR_STAGGER_MS).toBe(300_000);
    });

    it("is a positive finite number", () => {
      expect(typeof DEFAULT_TOP_OF_HOUR_STAGGER_MS).toBe("number");
      expect(Number.isFinite(DEFAULT_TOP_OF_HOUR_STAGGER_MS)).toBe(true);
      expect(DEFAULT_TOP_OF_HOUR_STAGGER_MS).toBeGreaterThan(0);
    });
  });
});
