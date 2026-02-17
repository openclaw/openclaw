import { describe, expect, it } from "vitest";
import { levelToMinLevel, normalizeLogLevel } from "./levels.js";

describe("normalizeLogLevel", () => {
  it("returns valid levels unchanged", () => {
    expect(normalizeLogLevel("debug")).toBe("debug");
    expect(normalizeLogLevel("error")).toBe("error");
    expect(normalizeLogLevel("silent")).toBe("silent");
  });

  it("falls back for invalid levels", () => {
    expect(normalizeLogLevel("invalid")).toBe("info");
    expect(normalizeLogLevel("invalid", "warn")).toBe("warn");
  });

  it("falls back for undefined", () => {
    expect(normalizeLogLevel(undefined)).toBe("info");
  });

  it("trims whitespace", () => {
    expect(normalizeLogLevel("  debug  ")).toBe("debug");
  });
});

describe("levelToMinLevel", () => {
  it("returns numeric ordering", () => {
    expect(levelToMinLevel("fatal")).toBe(0);
    expect(levelToMinLevel("error")).toBe(1);
    expect(levelToMinLevel("warn")).toBe(2);
    expect(levelToMinLevel("info")).toBe(3);
    expect(levelToMinLevel("debug")).toBe(4);
    expect(levelToMinLevel("trace")).toBe(5);
    expect(levelToMinLevel("silent")).toBe(Number.POSITIVE_INFINITY);
  });

  it("maintains ordering: fatal < error < warn < info < debug < trace", () => {
    expect(levelToMinLevel("fatal")).toBeLessThan(levelToMinLevel("error"));
    expect(levelToMinLevel("error")).toBeLessThan(levelToMinLevel("warn"));
    expect(levelToMinLevel("warn")).toBeLessThan(levelToMinLevel("info"));
    expect(levelToMinLevel("info")).toBeLessThan(levelToMinLevel("debug"));
    expect(levelToMinLevel("debug")).toBeLessThan(levelToMinLevel("trace"));
    expect(levelToMinLevel("trace")).toBeLessThan(levelToMinLevel("silent"));
  });
});
