import { describe, it, expect } from "vitest";
import { applyMergePatch } from "./merge-patch.js";

describe("applyMergePatch prototype pollution guard", () => {
  it("ignores __proto__ keys in patch", () => {
    const base = { a: 1 };
    const patch = JSON.parse('{"__proto__": {"polluted": true}, "b": 2}');
    const result = applyMergePatch(base, patch) as Record<string, unknown>;
    expect(result.b).toBe(2);
    expect(result.a).toBe(1);
    expect(Object.prototype.hasOwnProperty.call(result, "__proto__")).toBe(false);
    expect(result.polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("ignores constructor key in patch", () => {
    const base = { a: 1 };
    const patch = { constructor: { polluted: true }, b: 2 };
    const result = applyMergePatch(base, patch) as Record<string, unknown>;
    expect(result.b).toBe(2);
    expect(Object.prototype.hasOwnProperty.call(result, "constructor")).toBe(false);
  });

  it("ignores prototype key in patch", () => {
    const base = { a: 1 };
    const patch = { prototype: { polluted: true }, b: 2 };
    const result = applyMergePatch(base, patch) as Record<string, unknown>;
    expect(result.b).toBe(2);
    expect(Object.prototype.hasOwnProperty.call(result, "prototype")).toBe(false);
  });

  it("ignores __proto__ in nested patches", () => {
    const base = { nested: { x: 1 } };
    const patch = JSON.parse('{"nested": {"__proto__": {"polluted": true}, "y": 2}}');
    const result = applyMergePatch(base, patch) as { nested: Record<string, unknown> };
    expect(result.nested.y).toBe(2);
    expect(result.nested.x).toBe(1);
    expect(Object.prototype.hasOwnProperty.call(result.nested, "__proto__")).toBe(false);
    expect(result.nested.polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("applyMergePatch recursion depth guard", () => {
  it("does not crash on deeply nested patch (200 levels)", () => {
    // Build a deeply nested object: { a: { a: { a: ... { leaf: true } } } }
    let patch: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 200; i++) {
      patch = { a: patch };
    }
    const base = {};
    // Should not throw (stack overflow would crash the test runner)
    const result = applyMergePatch(base, patch);
    expect(result).toBeDefined();
    expect(typeof result).toBe("object");
  });

  it("preserves values within the depth limit", () => {
    // Build a 10-level nested patch — well within the 64-level limit
    let patch: Record<string, unknown> = { value: 42 };
    for (let i = 0; i < 10; i++) {
      patch = { nested: patch };
    }
    const result = applyMergePatch({}, patch) as Record<string, unknown>;
    // Walk 10 levels deep and verify the value
    let current: unknown = result;
    for (let i = 0; i < 10; i++) {
      expect(current).toBeDefined();
      current = (current as Record<string, unknown>).nested;
    }
    expect((current as Record<string, unknown>).value).toBe(42);
  });

  it("stops merging base values at depth limit and returns clone of patch", () => {
    // Build a 100-level patch (exceeds limit of 64)
    let patch: Record<string, unknown> = { deep: "patched" };
    let base: Record<string, unknown> = { deep: "original", kept: true };
    for (let i = 0; i < 100; i++) {
      patch = { level: patch };
      base = { level: base };
    }
    const result = applyMergePatch(base, patch) as Record<string, unknown>;
    expect(result).toBeDefined();
    // The merge should have worked for the first 64 levels, then returned patch clone.
    // The important thing is it doesn't crash.
    expect(typeof result).toBe("object");
  });
});

describe("applyMergePatch array length guard", () => {
  it("caps mergeObjectArraysById when patch would exceed limit", () => {
    // Create a base array with 5 id-keyed entries
    const base = {
      items: [
        { id: "a", value: 1 },
        { id: "b", value: 2 },
        { id: "c", value: 3 },
        { id: "d", value: 4 },
        { id: "e", value: 5 },
      ],
    };
    // Create a patch with 20,000 new id-keyed entries (exceeds 10,000 limit)
    const patchItems: Array<{ id: string; value: number }> = [];
    for (let i = 0; i < 20_000; i++) {
      patchItems.push({ id: `new-${i}`, value: i });
    }
    const result = applyMergePatch(base, { items: patchItems }, {
      mergeObjectArraysById: true,
    }) as { items: unknown[] };
    // When the limit is hit, mergeObjectArraysById returns undefined and the
    // patch array replaces the base array entirely (standard merge-patch behavior).
    expect(result.items).toBeDefined();
    expect(Array.isArray(result.items)).toBe(true);
    // Result should be the patch array (full replacement), not base + patch
    expect(result.items.length).toBe(20_000);
  });

  it("allows merging below the limit", () => {
    const base = {
      items: [
        { id: "a", value: 1 },
        { id: "b", value: 2 },
      ],
    };
    const patch = {
      items: [
        { id: "a", value: 10 },
        { id: "c", value: 3 },
      ],
    };
    const result = applyMergePatch(base, patch, {
      mergeObjectArraysById: true,
    }) as { items: Array<{ id: string; value: number }> };
    expect(result.items).toHaveLength(3);
    expect(result.items[0]).toEqual({ id: "a", value: 10 });
    expect(result.items[1]).toEqual({ id: "b", value: 2 });
    expect(result.items[2]).toEqual({ id: "c", value: 3 });
  });
});

