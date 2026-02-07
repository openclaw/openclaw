import { describe, expect, it } from "vitest";
import {
  ALLOWED_LOG_LEVELS,
  levelToMinLevel,
  normalizeLogLevel,
} from "./levels.js";

describe("ALLOWED_LOG_LEVELS", () => {
  it("contains all seven standard levels in order", () => {
    expect(ALLOWED_LOG_LEVELS).toEqual([
      "silent",
      "fatal",
      "error",
      "warn",
      "info",
      "debug",
      "trace",
    ]);
  });
});

describe("normalizeLogLevel", () => {
  it("returns a valid log level unchanged", () => {
    expect(normalizeLogLevel("debug")).toBe("debug");
  });

  it("trims whitespace from the input", () => {
    expect(normalizeLogLevel("  warn  ")).toBe("warn");
  });

  it("returns the fallback for an invalid level", () => {
    expect(normalizeLogLevel("verbose")).toBe("info");
  });

  it("returns the fallback for an empty string", () => {
    expect(normalizeLogLevel("")).toBe("info");
  });

  it("returns the fallback when level is undefined", () => {
    expect(normalizeLogLevel(undefined)).toBe("info");
  });

  it("uses a custom fallback when provided", () => {
    expect(normalizeLogLevel("bad-level", "error")).toBe("error");
  });

  it("returns each valid level correctly", () => {
    for (const level of ALLOWED_LOG_LEVELS) {
      expect(normalizeLogLevel(level)).toBe(level);
    }
  });

  it("is case-sensitive (uppercase is rejected)", () => {
    expect(normalizeLogLevel("DEBUG")).toBe("info");
  });
});

describe("levelToMinLevel", () => {
  it("maps fatal to 0", () => {
    expect(levelToMinLevel("fatal")).toBe(0);
  });

  it("maps error to 1", () => {
    expect(levelToMinLevel("error")).toBe(1);
  });

  it("maps warn to 2", () => {
    expect(levelToMinLevel("warn")).toBe(2);
  });

  it("maps info to 3", () => {
    expect(levelToMinLevel("info")).toBe(3);
  });

  it("maps debug to 4", () => {
    expect(levelToMinLevel("debug")).toBe(4);
  });

  it("maps trace to 5", () => {
    expect(levelToMinLevel("trace")).toBe(5);
  });

  it("maps silent to Infinity", () => {
    expect(levelToMinLevel("silent")).toBe(Number.POSITIVE_INFINITY);
  });

  it("preserves ordering: fatal < error < warn < info < debug < trace", () => {
    const ordered = ["fatal", "error", "warn", "info", "debug", "trace"] as const;
    for (let i = 0; i < ordered.length - 1; i++) {
      expect(levelToMinLevel(ordered[i]!)).toBeLessThan(levelToMinLevel(ordered[i + 1]!));
    }
  });
});
