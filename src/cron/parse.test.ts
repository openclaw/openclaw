import { describe, expect, it } from "vitest";
import { parseAbsoluteTimeMs } from "./parse.js";

describe("parseAbsoluteTimeMs", () => {
  describe("Unix timestamp (seconds)", () => {
    it("converts Unix timestamp to milliseconds (#15724)", () => {
      // 2026-02-13T18:00:00.000Z in seconds
      const unixSeconds = 1771005600;
      const result = parseAbsoluteTimeMs(String(unixSeconds));
      
      // Should convert seconds to milliseconds
      expect(result).toBe(unixSeconds * 1000);
      
      // Verify the date is correct
      expect(new Date(result!).toISOString()).toBe("2026-02-13T18:00:00.000Z");
    });

    it("handles recent timestamps correctly", () => {
      // 2024-01-01T00:00:00.000Z in seconds
      const unixSeconds = 1704067200;
      const result = parseAbsoluteTimeMs(String(unixSeconds));
      
      expect(result).toBe(unixSeconds * 1000);
      expect(new Date(result!).toISOString()).toBe("2024-01-01T00:00:00.000Z");
    });

    it("handles future timestamps correctly", () => {
      // 2030-01-01T00:00:00.000Z in seconds
      const unixSeconds = 1893456000;
      const result = parseAbsoluteTimeMs(String(unixSeconds));
      
      expect(result).toBe(unixSeconds * 1000);
      expect(new Date(result!).toISOString()).toBe("2030-01-01T00:00:00.000Z");
    });
  });

  describe("ISO 8601 format", () => {
    it("parses full ISO timestamp", () => {
      const iso = "2026-02-13T18:00:00.000Z";
      const result = parseAbsoluteTimeMs(iso);
      
      expect(result).toBe(Date.parse(iso));
      expect(result).toBe(1771005600000);
    });

    it("parses ISO timestamp without milliseconds", () => {
      const iso = "2026-02-13T18:00:00Z";
      const result = parseAbsoluteTimeMs(iso);
      
      expect(result).toBe(Date.parse(iso));
    });

    it("parses ISO date without time (assumes 00:00:00Z)", () => {
      const iso = "2026-02-13";
      const result = parseAbsoluteTimeMs(iso);
      
      expect(result).toBe(Date.parse("2026-02-13T00:00:00Z"));
    });

    it("parses ISO timestamp without timezone (assumes Z)", () => {
      const iso = "2026-02-13T18:00:00";
      const result = parseAbsoluteTimeMs(iso);
      
      expect(result).toBe(Date.parse("2026-02-13T18:00:00Z"));
    });

    it("parses ISO timestamp with timezone offset", () => {
      const iso = "2026-02-13T18:00:00+09:00";
      const result = parseAbsoluteTimeMs(iso);
      
      // +09:00 is 9 hours ahead of UTC
      expect(result).toBe(Date.parse("2026-02-13T09:00:00Z"));
    });
  });

  describe("edge cases", () => {
    it("returns null for empty string", () => {
      expect(parseAbsoluteTimeMs("")).toBe(null);
    });

    it("returns null for whitespace", () => {
      expect(parseAbsoluteTimeMs("   ")).toBe(null);
    });

    it("returns null for zero", () => {
      expect(parseAbsoluteTimeMs("0")).toBe(null);
    });

    it("returns null for negative number", () => {
      expect(parseAbsoluteTimeMs("-1234567890")).toBe(null);
    });

    it("returns null for invalid ISO string", () => {
      expect(parseAbsoluteTimeMs("not-a-date")).toBe(null);
    });

    it("returns null for malformed timestamp", () => {
      expect(parseAbsoluteTimeMs("12345abc")).toBe(null);
    });

    it("handles very large Unix timestamps", () => {
      // 2099-12-31T23:59:59Z in seconds
      const unixSeconds = 4102444799;
      const result = parseAbsoluteTimeMs(String(unixSeconds));
      
      expect(result).toBe(unixSeconds * 1000);
    });

    it("trims whitespace around Unix timestamp", () => {
      const unixSeconds = 1771005600;
      const result = parseAbsoluteTimeMs(`  ${unixSeconds}  `);
      
      expect(result).toBe(unixSeconds * 1000);
    });

    it("trims whitespace around ISO string", () => {
      const iso = "  2026-02-13T18:00:00Z  ";
      const result = parseAbsoluteTimeMs(iso);
      
      expect(result).toBe(Date.parse("2026-02-13T18:00:00Z"));
    });
  });

  describe("regression: issue #15724", () => {
    it("Unix timestamp should not be treated as milliseconds", () => {
      // Before fix: returned 1771005600 (treated as ms -> 1970-01-21)
      // After fix: returns 1771005600000 (treated as s -> 2026-02-13)
      const unixSeconds = 1771005600;
      const result = parseAbsoluteTimeMs(String(unixSeconds));
      const date = new Date(result!);
      
      // Should be in 2026, not 1970
      expect(date.getFullYear()).toBe(2026);
      expect(date.getFullYear()).not.toBe(1970);
      
      // Exact timestamp
      expect(result).toBe(1771005600000);
      expect(date.toISOString()).toBe("2026-02-13T18:00:00.000Z");
    });
  });
});
