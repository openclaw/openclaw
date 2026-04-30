import { describe, expect, it } from "vitest";
import { validateCronExpression } from "./validate-cron-expression.js";

describe("validateCronExpression", () => {
  describe("valid expressions", () => {
    it("accepts standard 5-field cron expression", () => {
      const result = validateCronExpression("* * * * *");
      expect(result).toEqual({ ok: true });
    });

    it("accepts 6-field cron expression with seconds", () => {
      const result = validateCronExpression("0 * * * * *");
      expect(result).toEqual({ ok: true });
    });

    it("accepts specific time expression", () => {
      const result = validateCronExpression("0 0 * * *");
      expect(result).toEqual({ ok: true });
    });

    it("accepts expression with ranges", () => {
      const result = validateCronExpression("0 9-17 * * 1-5");
      expect(result).toEqual({ ok: true });
    });

    it("accepts expression with timezone", () => {
      const result = validateCronExpression("0 0 * * *", "America/New_York");
      expect(result).toEqual({ ok: true });
    });
  });

  describe("invalid expressions", () => {
    it("rejects empty expression", () => {
      const result = validateCronExpression("");
      expect(result).toEqual({
        ok: false,
        message: "cron expression cannot be empty",
      });
    });

    it("rejects undefined expression", () => {
      const result = validateCronExpression(undefined);
      expect(result).toEqual({
        ok: false,
        message: "cron expression is required",
      });
    });

    it("rejects invalid month value (13)", () => {
      // Issue #74459: "* * * 13 *" should be rejected upfront
      const result = validateCronExpression("* * * 13 *");
      expect(result.ok).toBe(false);
      expect(result.message).toContain("month");
    });

    it("rejects invalid day of week (8)", () => {
      const result = validateCronExpression("* * * * 8");
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/day|week|range/i);
    });

    it("rejects invalid hour value (25)", () => {
      const result = validateCronExpression("0 25 * * *");
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/hour|range/i);
    });

    it("rejects expression with too few fields", () => {
      const result = validateCronExpression("* * *");
      expect(result.ok).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("handles whitespace-only expression", () => {
      const result = validateCronExpression("   ");
      expect(result).toEqual({
        ok: false,
        message: "cron expression cannot be empty",
      });
    });

    it("trims whitespace from valid expression", () => {
      const result = validateCronExpression("  0 0 * * *  ");
      expect(result).toEqual({ ok: true });
    });

    it("accepts predefined alias @daily", () => {
      const result = validateCronExpression("@daily");
      expect(result).toEqual({ ok: true });
    });

    it("accepts predefined alias @hourly", () => {
      const result = validateCronExpression("@hourly");
      expect(result).toEqual({ ok: true });
    });
  });
});