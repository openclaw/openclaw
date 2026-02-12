import { visibleWidth } from "@mariozechner/pi-tui";
import chalk from "chalk";
import { describe, expect, it } from "vitest";
import { clampLinesToWidth } from "./safe-render.js";

describe("clampLinesToWidth", () => {
  it("returns short lines unchanged", () => {
    const lines = ["hello", "world"];
    const result = clampLinesToWidth(lines, 80);
    expect(result).toEqual(["hello", "world"]);
  });

  it("truncates lines that exceed width", () => {
    const longLine = "x".repeat(200);
    const lines = [longLine];
    const result = clampLinesToWidth(lines, 80);
    expect(result.length).toBe(1);
    expect(visibleWidth(result[0])).toBeLessThanOrEqual(80);
  });

  it("handles lines with ANSI codes", () => {
    const styledLine = chalk.red("x".repeat(200));
    const lines = [styledLine];
    const result = clampLinesToWidth(lines, 80);
    expect(result.length).toBe(1);
    expect(visibleWidth(result[0])).toBeLessThanOrEqual(80);
  });

  it("handles mixed short and long lines", () => {
    const lines = ["short", "x".repeat(200), "also short"];
    const result = clampLinesToWidth(lines, 80);
    expect(result.length).toBe(3);
    for (const line of result) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(80);
    }
    expect(result[0]).toBe("short");
    expect(result[2]).toBe("also short");
  });

  it("handles empty lines", () => {
    const lines = ["", "x".repeat(200), ""];
    const result = clampLinesToWidth(lines, 80);
    expect(result.length).toBe(3);
    expect(result[0]).toBe("");
    expect(result[2]).toBe("");
    expect(visibleWidth(result[1])).toBeLessThanOrEqual(80);
  });

  it("handles zero-width target", () => {
    const lines = ["hello"];
    const result = clampLinesToWidth(lines, 0);
    expect(result.length).toBe(1);
    // With width 0, truncateToWidth with empty ellipsis returns empty string
    expect(visibleWidth(result[0])).toBe(0);
  });

  it("handles lines at exactly the width limit", () => {
    const line = "x".repeat(80);
    const result = clampLinesToWidth([line], 80);
    expect(result[0]).toBe(line);
  });

  it("handles nested ANSI codes from chalk", () => {
    // Simulate deeply nested chalk styling like the Markdown component produces
    const content = "a".repeat(200);
    const nested = chalk.bgHex("#2B2F36")(chalk.hex("#F3EEE0")(chalk.bold(content)));
    const result = clampLinesToWidth([nested], 80);
    expect(visibleWidth(result[0])).toBeLessThanOrEqual(80);
  });
});
