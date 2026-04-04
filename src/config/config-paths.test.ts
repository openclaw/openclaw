import { describe, expect, it } from "vitest";
import {
  parseConfigPath,
  setConfigValueAtPath,
  unsetConfigValueAtPath,
  getConfigValueAtPath,
} from "./config-paths.js";

describe("parseConfigPath", () => {
  it("parses valid dot-notation paths", () => {
    expect(parseConfigPath("foo")).toEqual({ ok: true, path: ["foo"] });
    expect(parseConfigPath("foo.bar")).toEqual({ ok: true, path: ["foo", "bar"] });
    expect(parseConfigPath("foo.bar.baz")).toEqual({ ok: true, path: ["foo", "bar", "baz"] });
  });

  it("trims whitespace around path segments", () => {
    expect(parseConfigPath("  foo.bar  ")).toEqual({ ok: true, path: ["foo", "bar"] });
    expect(parseConfigPath("foo . bar")).toEqual({ ok: true, path: ["foo", "bar"] });
  });

  it("returns error for empty path", () => {
    expect(parseConfigPath("")).toEqual({
      ok: false,
      error: "Invalid path. Use dot notation (e.g. foo.bar).",
    });
    expect(parseConfigPath("   ")).toEqual({
      ok: false,
      error: "Invalid path. Use dot notation (e.g. foo.bar).",
    });
  });

  it("returns error for path with empty segments", () => {
    expect(parseConfigPath("foo..bar")).toEqual({
      ok: false,
      error: "Invalid path. Use dot notation (e.g. foo.bar).",
    });
    expect(parseConfigPath(".foo")).toEqual({
      ok: false,
      error: "Invalid path. Use dot notation (e.g. foo.bar).",
    });
    expect(parseConfigPath("foo.")).toEqual({
      ok: false,
      error: "Invalid path. Use dot notation (e.g. foo.bar).",
    });
  });

  it("returns error for blocked object keys", () => {
    expect(parseConfigPath("foo.__proto__.bar")).toEqual({
      ok: false,
      error: "Invalid path segment.",
    });
    expect(parseConfigPath("foo.prototype.bar")).toEqual({
      ok: false,
      error: "Invalid path segment.",
    });
    expect(parseConfigPath("foo.constructor.bar")).toEqual({
      ok: false,
      error: "Invalid path segment.",
    });
  });
});

describe("setConfigValueAtPath", () => {
  it("sets value at root level", () => {
    const root: Record<string, unknown> = {};
    setConfigValueAtPath(root, ["foo"], "value");
    expect(root).toEqual({ foo: "value" });
  });

  it("creates nested objects when setting deep path", () => {
    const root: Record<string, unknown> = {};
    setConfigValueAtPath(root, ["foo", "bar", "baz"], 123);
    expect(root).toEqual({ foo: { bar: { baz: 123 } } });
  });

  it("overwrites existing value", () => {
    const root = { foo: { bar: "old" } };
    setConfigValueAtPath(root as any, ["foo", "bar"], "new");
    expect(root).toEqual({ foo: { bar: "new" } });
  });

  it("preserves existing sibling paths", () => {
    const root = { foo: { existing: true }, other: null };
    setConfigValueAtPath(root as any, ["foo", "bar"], "value");
    expect(root).toEqual({
      foo: { existing: true, bar: "value" },
      other: null,
    });
  });
});

describe("getConfigValueAtPath", () => {
  it("gets value at root level", () => {
    const root = { foo: "value" };
    expect(getConfigValueAtPath(root as any, ["foo"])).toBe("value");
  });

  it("gets value at nested path", () => {
    const root = { foo: { bar: { baz: 123 } } };
    expect(getConfigValueAtPath(root as any, ["foo", "bar", "baz"])).toBe(123);
  });

  it("returns undefined for non-existent path", () => {
    const root = { foo: {} };
    expect(getConfigValueAtPath(root as any, ["foo", "bar"])).toBeUndefined();
    expect(getConfigValueAtPath(root as any, ["nonexistent"])).toBeUndefined();
  });

  it("returns undefined when traversing non-object", () => {
    const root = { foo: "string" };
    expect(getConfigValueAtPath(root as any, ["foo", "bar"])).toBeUndefined();
  });
});

describe("unsetConfigValueAtPath", () => {
  it("deletes value at path", () => {
    const root = { foo: { bar: "value" } };
    const result = unsetConfigValueAtPath(root as any, ["foo", "bar"]);
    expect(result).toBe(true);
    // Implementation cleans up empty parent objects
    expect(root).toEqual({});
  });

  it("returns false for non-existent path", () => {
    const root = { foo: {} };
    expect(unsetConfigValueAtPath(root as any, ["foo", "bar"])).toBe(false);
    expect(unsetConfigValueAtPath(root as any, ["nonexistent"])).toBe(false);
  });

  it("returns false when traversing non-object", () => {
    const root = { foo: "string" };
    expect(unsetConfigValueAtPath(root as any, ["foo", "bar"])).toBe(false);
  });

  it("cleans up empty parent objects", () => {
    const root = { foo: { bar: { baz: 1 }, qux: 2 } };
    const result = unsetConfigValueAtPath(root as any, ["foo", "bar", "baz"]);
    expect(result).toBe(true);
    // Implementation cleans up empty parent chain, leaving only sibling
    expect(root).toEqual({ foo: { qux: 2 } });
  });

  it("stops cleanup when sibling keys exist", () => {
    const root = { foo: { bar: { baz: 1 }, sibling: true } };
    unsetConfigValueAtPath(root as any, ["foo", "bar", "baz"]);
    expect(root).toEqual({ foo: { sibling: true } });
  });

  it("handles single-key path at root", () => {
    const root = { foo: "value" };
    const result = unsetConfigValueAtPath(root as any, ["foo"]);
    expect(result).toBe(true);
    expect(root).toEqual({});
  });
});
