import { describe, expect, it } from "vitest";
import { isTruthy, resolveConfigPath, isConfigPathTruthyWithDefaults } from "./config-eval.js";

describe("isTruthy", () => {
  it("returns false for undefined and null", () => {
    expect(isTruthy(undefined)).toBe(false);
    expect(isTruthy(null)).toBe(false);
  });

  it("returns boolean value as-is", () => {
    expect(isTruthy(true)).toBe(true);
    expect(isTruthy(false)).toBe(false);
  });

  it("returns false for 0, true for other numbers", () => {
    expect(isTruthy(0)).toBe(false);
    expect(isTruthy(1)).toBe(true);
    expect(isTruthy(-1)).toBe(true);
  });

  it("checks string length", () => {
    expect(isTruthy("")).toBe(false);
    expect(isTruthy("   ")).toBe(false);
    expect(isTruthy("hello")).toBe(true);
  });

  it("returns true for objects and arrays", () => {
    expect(isTruthy({})).toBe(true);
    expect(isTruthy([])).toBe(true);
  });
});

describe("resolveConfigPath", () => {
  it("resolves nested paths", () => {
    const config = { a: { b: { c: 1 } } };
    expect(resolveConfigPath(config, "a.b.c")).toBe(1);
  });

  it("returns undefined for non-existent path", () => {
    const config = { a: { b: 1 } };
    expect(resolveConfigPath(config, "a.x")).toBeUndefined();
    expect(resolveConfigPath(config, "x.y.z")).toBeUndefined();
  });

  it("returns undefined for null/undefined parent", () => {
    expect(resolveConfigPath(null, "a.b")).toBeUndefined();
    expect(resolveConfigPath(undefined, "a.b")).toBeUndefined();
  });

  it("handles array index paths", () => {
    const config = { items: ["a", "b"] };
    expect(resolveConfigPath(config, "items.0")).toBe("a");
    expect(resolveConfigPath(config, "items.1")).toBe("b");
  });

  it("filters empty path segments", () => {
    const config = { a: { b: 1 } };
    expect(resolveConfigPath(config, ".a..b.")).toBe(1);
  });
});

describe("isConfigPathTruthyWithDefaults", () => {
  it("returns default for undefined path", () => {
    const defaults = { "missing.path": true };
    expect(isConfigPathTruthyWithDefaults({}, "missing.path", defaults)).toBe(true);
  });

  it("returns default for non-existent path", () => {
    const defaults = { "other.path": false };
    expect(isConfigPathTruthyWithDefaults({ a: 1 }, "a.b", defaults)).toBe(false);
  });

  it("returns actual value when present", () => {
    expect(isConfigPathTruthyWithDefaults({ a: true }, "a", {})).toBe(true);
    expect(isConfigPathTruthyWithDefaults({ a: false }, "a", {})).toBe(false);
  });
});
