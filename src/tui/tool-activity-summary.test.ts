import { describe, expect, it } from "vitest";
import {
  categorizeToolActivity,
  createEmptyToolActivityCounts,
  formatToolActivitySummary,
} from "./tool-activity-summary.js";

describe("categorizeToolActivity", () => {
  it("maps known tool names to their activity category", () => {
    expect(categorizeToolActivity("read")).toBe("read");
    expect(categorizeToolActivity("write")).toBe("write");
    expect(categorizeToolActivity("edit")).toBe("write");
    expect(categorizeToolActivity("bash")).toBe("exec");
    expect(categorizeToolActivity("exec")).toBe("exec");
    expect(categorizeToolActivity("grep")).toBe("search");
    expect(categorizeToolActivity("web_search")).toBe("search");
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(categorizeToolActivity(" Bash ")).toBe("exec");
    expect(categorizeToolActivity("READ")).toBe("read");
  });

  it("falls back to other for unknown tool names", () => {
    expect(categorizeToolActivity("some_future_tool")).toBe("other");
  });
});

describe("formatToolActivitySummary", () => {
  it("formats a single read", () => {
    const counts = { ...createEmptyToolActivityCounts(), read: 1 };
    expect(formatToolActivitySummary(counts)).toBe("Read a file");
  });

  it("formats a single write", () => {
    const counts = { ...createEmptyToolActivityCounts(), write: 1 };
    expect(formatToolActivitySummary(counts)).toBe("Wrote to a file");
  });

  it("formats a single search", () => {
    const counts = { ...createEmptyToolActivityCounts(), search: 1 };
    expect(formatToolActivitySummary(counts)).toBe("Searched for a pattern");
  });

  it("pluralizes counts greater than one", () => {
    const counts = { ...createEmptyToolActivityCounts(), exec: 3 };
    expect(formatToolActivitySummary(counts)).toBe("Ran 3 commands");
  });

  it("joins multiple categories naturally without an Oxford comma", () => {
    const counts = { read: 2, exec: 3, write: 1, search: 2, other: 0 };
    expect(formatToolActivitySummary(counts)).toBe(
      "Read 2 files, wrote to a file, ran 3 commands and searched for 2 patterns",
    );
  });

  it("appends an other-tools clause when uncategorized tools ran", () => {
    const counts = { ...createEmptyToolActivityCounts(), read: 1, other: 2 };
    expect(formatToolActivitySummary(counts)).toBe("Read a file and used 2 other tools");
  });

  it("returns an empty string when there is no activity", () => {
    expect(formatToolActivitySummary(createEmptyToolActivityCounts())).toBe("");
  });
});
