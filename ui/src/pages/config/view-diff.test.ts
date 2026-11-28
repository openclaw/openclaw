import { beforeAll, describe, expect, it } from "vitest";
import { warmJson5 } from "../../lib/json5-runtime.ts";
import { computeRawDiff } from "./view-diff.ts";
import { createConfigViewState } from "./view-state.ts";

describe("raw array diff preservation", () => {
  beforeAll(() => warmJson5().then(() => undefined));

  it.each([
    ["empty", "[]", "[]", false],
    ["nested JSON5", "[null, {a: [true,],},]", "[null, {a: [true]}]", false],
    ["length", "[1]", "[1, 2]", true],
    ["last value", '[1, {"a": [2]}]', '[1, {"a": [3]}]', true],
    ["object key", '[{"a": 1}]', '[{"b": 1}]', true],
  ] as const)("preserves %s comparisons", (_name, original, current, differs) => {
    const diff = computeRawDiff(
      createConfigViewState(),
      `{items: ${original}}`,
      `{items: ${current}}`,
    );
    expect(diff).toEqual(
      differs ? [{ path: ["items"], from: JSON.parse(original), to: JSON.parse(current) }] : [],
    );
  });

  it("does not admit JSON5 array elisions", () => {
    expect(computeRawDiff(createConfigViewState(), "{items: [1, 2]}", "{items: [1,, 2]}")).toEqual(
      [],
    );
  });

  it.each([2000, 2001])("preserves the %i-item conservative comparison boundary", (length) => {
    const raw = JSON.stringify({ items: Array(length).fill(0) });
    const diff = computeRawDiff(createConfigViewState(), raw, raw);
    expect(diff.map(({ path }) => path)).toEqual(length === 2000 ? [] : [["items"]]);
  });

  it.each([31, 32])("preserves the %i-array depth boundary", (depth) => {
    const raw = `{"items":${"[".repeat(depth)}0${"]".repeat(depth)}}`;
    const diff = computeRawDiff(createConfigViewState(), raw, raw);
    expect(diff.map(({ path }) => path)).toEqual(depth === 31 ? [] : [["items"]]);
  });

  it.each([false, true])("preserves node-budget results with an early difference: %s", (early) => {
    const tail = Array.from({ length: 10 }, () => Array(2000).fill(0));
    const diff = computeRawDiff(
      createConfigViewState(),
      JSON.stringify({ items: [0, tail], after: 0 }),
      JSON.stringify({ items: [early ? 1 : 0, tail], after: 1 }),
    );
    expect(diff.map(({ path }) => path)).toEqual(early ? [["items"], ["after"]] : [["items"]]);
  });
});
