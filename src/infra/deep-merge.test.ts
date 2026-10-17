import { describe, expect, it } from "vitest";
import { mergeDeep } from "./deep-merge.js";

describe("mergeDeep", () => {
  it("merges nested objects while replacing arrays and preserving explicit null", () => {
    expect(
      mergeDeep(
        {
          provider: { model: "base", voice: "alloy", nullable: "base" },
          packages: ["base"],
        },
        {
          provider: { voice: undefined, nullable: null },
          packages: ["override"],
          introduced: { nullable: null },
        },
      ),
    ).toEqual({
      provider: { model: "base", voice: "alloy", nullable: null },
      packages: ["override"],
      introduced: { nullable: null },
    });
  });

  it("supports include-style array concatenation and undefined replacement", () => {
    const merged = mergeDeep(
      { nested: { values: ["base"], removed: true } },
      { nested: { values: ["override"], removed: undefined } },
      { arrays: "concat", undefinedValues: "replace" },
    ) as { nested: { values: string[]; removed?: boolean } };

    expect(merged.nested.values).toEqual(["base", "override"]);
    expect(Object.hasOwn(merged.nested, "removed")).toBe(true);
    expect(merged.nested.removed).toBeUndefined();
  });

  it("blocks prototype mutation keys at every merged object level", () => {
    const override = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":{"polluted":true},"safe":{"prototype":{"polluted":true},"next":true}}',
    );

    expect(mergeDeep({ safe: { keep: true } }, override)).toEqual({
      safe: { keep: true, next: true },
    });
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("applies policies to top-level arrays and undefined values", () => {
    expect(mergeDeep(["base"], ["override"])).toEqual(["override"]);
    expect(mergeDeep(["base"], ["override"], { arrays: "concat" })).toEqual(["base", "override"]);
    expect(mergeDeep("base", undefined)).toBe("base");
    expect(mergeDeep("base", undefined, { undefinedValues: "replace" })).toBeUndefined();
  });

  it("replaces unlike array and object value kinds", () => {
    expect(mergeDeep({ value: ["base"] }, { value: { enabled: true } })).toEqual({
      value: { enabled: true },
    });
    expect(
      mergeDeep({ value: { enabled: true } }, { value: ["override"] }, { arrays: "concat" }),
    ).toEqual({ value: ["override"] });
  });
  it("merges deeply nested documents without overflowing the call stack", () => {
    const depth = 50_000;
    let base: unknown = "leaf";
    for (let i = 0; i < depth; i += 1) {
      base = { x: base };
    }
    const merged = mergeDeep(base, base) as Record<string, unknown>;
    // Walk the merged tree iteratively: a recursive toEqual would overflow the
    // test's own call stack at the depth under test.
    let current: unknown = merged;
    let levels = 0;
    let strayKeys = 0;
    while (typeof current === "object" && current !== null) {
      const record = current as Record<string, unknown>;
      if (Object.keys(record).length !== 1) {
        strayKeys += 1;
      }
      current = record.x;
      levels += 1;
    }
    expect(strayKeys).toBe(0);
    expect(levels).toBe(depth);
    expect(current).toBe("leaf");
  });
});
