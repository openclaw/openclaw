import { describe, expect, it } from "vitest";
import { formatTuiTimestamp, prefixTimestamp } from "./timestamp.js";

describe("TUI timestamps", () => {
  it("prefixes visible event text with one stable timestamp", () => {
    expect(prefixTimestamp("running command", "10:11:12")).toBe("[10:11:12] running command");
  });

  it("formats timestamps with hour, minute, and second fields", () => {
    const timestamp = formatTuiTimestamp(new Date("2026-04-15T10:11:12Z"));

    expect(timestamp).toMatch(/\d{2}:\d{2}:\d{2}/);
  });
});
