import { expect, it } from "vitest";
import { mapArrayIfChanged } from "./map-array-if-changed.js";

it("retains unchanged arrays and preserves unaffected entry identities when mapping", () => {
  const first = { value: 1 };
  const second = { value: 2 };
  const source = [first, second];
  expect(mapArrayIfChanged(source, (value) => value)).toBe(source);

  const next = mapArrayIfChanged(source, (value) => (value === second ? { value: 3 } : value));
  expect(next).toEqual([first, { value: 3 }]);
  expect(next[0]).toBe(first);
  expect(source[1]).toBe(second);
});

it("preserves sparse visitation and holes in a changed array", () => {
  const source: number[] = [];
  source.length = 3;
  source[1] = 2;
  const visited: number[] = [];
  const next = mapArrayIfChanged(source, (value) => {
    visited.push(value);
    return value + 1;
  });
  expect(visited).toEqual([2]);
  expect(next).toHaveLength(3);
  expect(0 in next).toBe(false);
  expect(next[1]).toBe(3);
  expect(2 in next).toBe(false);
});

it("uses strict equality rather than Object.is for identity preservation", () => {
  const nan = [Number.NaN];
  const zero = [0];
  expect(mapArrayIfChanged(nan, (value) => value)).not.toBe(nan);
  expect(mapArrayIfChanged(zero, () => -0)).toBe(zero);
});
