import { describe, expect, it } from "vitest";
import { deepMerge } from "./includes.js";

describe("deepMerge prototype pollution guard", () => {
  it("ignores __proto__ keys in source", () => {
    const target = { a: 1 };
    const source = JSON.parse('{"__proto__": {"polluted": true}, "b": 2}');
    const result = deepMerge(target, source) as Record<string, unknown>;
    expect(result.b).toBe(2);
    expect(result.a).toBe(1);
    expect(Object.prototype.hasOwnProperty.call(result, "__proto__")).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("ignores constructor key in source", () => {
    const target = { a: 1 };
    const source = { constructor: { polluted: true }, b: 2 };
    const result = deepMerge(target, source) as Record<string, unknown>;
    expect(result.b).toBe(2);
    expect(Object.prototype.hasOwnProperty.call(result, "constructor")).toBe(false);
  });

  it("ignores __proto__ in nested objects", () => {
    const target = { nested: { x: 1 } };
    const source = JSON.parse('{"nested": {"__proto__": {"polluted": true}, "y": 2}}');
    const result = deepMerge(target, source) as { nested: Record<string, unknown> };
    expect(result.nested.y).toBe(2);
    expect(Object.prototype.hasOwnProperty.call(result.nested, "__proto__")).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
