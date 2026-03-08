import { describe, expect, it } from "vitest";
import { formatTimestamp } from "./format-datetime.js";

describe("formatTimestamp", () => {
  const testDate = new Date("2024-01-15T14:30:45.123Z");

  describe("styles", () => {
    it("short style - HH:MM:SS±HH:MM", () => {
      const result = formatTimestamp(testDate, { style: "short" });
      expect(result).toMatch(/^\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    });

    it("medium style - HH:MM:SS.mmm±HH:MM", () => {
      const result = formatTimestamp(testDate, { style: "medium" });
      expect(result).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
    });

    it("long style - YYYY-MM-DDTHH:MM:SS.mmm±HH:MM", () => {
      const result = formatTimestamp(testDate, { style: "long" });
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
    });
  });

  describe("timezone options", () => {
    it("uses explicit timezone when provided", () => {
      const result = formatTimestamp(testDate, { style: "short", timeZone: "America/New_York" });
      expect(result).toMatch(/^\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    });

    it("defaults to system timezone when not specified", () => {
      const result = formatTimestamp(testDate, { style: "short" });
      expect(result).toMatch(/^\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    });
  });

  describe("always includes offset", () => {
    it("short style always includes offset", () => {
      const result = formatTimestamp(testDate, { style: "short" });
      expect(result).toMatch(/[+-]\d{2}:\d{2}$/);
    });

    it("medium style always includes offset", () => {
      const result = formatTimestamp(testDate, { style: "medium" });
      expect(result).toMatch(/[+-]\d{2}:\d{2}$/);
    });

    it("long style always includes offset", () => {
      const result = formatTimestamp(testDate, { style: "long" });
      expect(result).toMatch(/[+-]\d{2}:\d{2}$/);
    });

    it("UTC timezone shows +00:00", () => {
      const result = formatTimestamp(testDate, { style: "medium", timeZone: "UTC" });
      expect(result).toMatch(/\+00:00$/);
    });
  });

  describe("default style", () => {
    it("defaults to medium style", () => {
      const result = formatTimestamp(testDate);
      expect(result).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
    });
  });

  describe("different timezones", () => {
    it("handles UTC", () => {
      const result = formatTimestamp(testDate, { style: "medium", timeZone: "UTC" });
      expect(result).toBe("14:30:45.123+00:00");
    });

    it("handles US Eastern", () => {
      const result = formatTimestamp(testDate, { style: "short", timeZone: "America/New_York" });
      expect(result).toMatch(/^\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    });

    it("handles Europe Central", () => {
      const result = formatTimestamp(testDate, { style: "short", timeZone: "Europe/Paris" });
      expect(result).toMatch(/^\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    });
  });
});
