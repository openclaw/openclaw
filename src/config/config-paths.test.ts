// Regression test: unsetConfigValueAtPath uses Object.hasOwn instead of in operator,
// preventing prototype-named keys (toString, constructor, valueOf) from being falsely
// reported as "found and deleted" when they don't exist as own properties.
import { describe, expect, it } from "vitest";
import { setConfigValueAtPath, unsetConfigValueAtPath } from "./config-paths.js";

describe("unsetConfigValueAtPath — prototype pollution", () => {
  const PROTOTYPE_KEYS = ["toString", "constructor", "valueOf", "hasOwnProperty"];

  for (const key of PROTOTYPE_KEYS) {
    it(`returns false when "${key}" is not an own property`, () => {
      const root = { foo: { bar: "value" } };
      const result = unsetConfigValueAtPath(root, ["foo", key]);
      expect(result).toBe(false);
      expect(Object.hasOwn(root.foo, key)).toBe(false);
    });
  }

  it("correctly deletes an existing prototype-named key", () => {
    const root = { foo: { bar: "value", toString: "myVal" } };
    const result = unsetConfigValueAtPath(root, ["foo", "toString"]);
    expect(result).toBe(true);
    expect(Object.hasOwn(root.foo, "toString")).toBe(false);
    expect(root.foo.bar).toBe("value"); // sibling unaffected
  });

  it("does not incorrectly prune parent when deletion is a no-op", () => {
    const root = { foo: { bar: "value" } };
    unsetConfigValueAtPath(root, ["foo", "toString"]);
    expect(Object.hasOwn(root, "foo")).toBe(true);
    expect(root.foo.bar).toBe("value");
  });
});
