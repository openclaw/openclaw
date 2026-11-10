import { expect, it } from "vitest";
import { estimateRetainedDataSize } from "./retained-data-size.js";

it("counts shared data once without invoking accessors or serializing contents", () => {
  const shared = { payload: "synthetic-private-content" };
  const root = {
    left: shared,
    right: shared,
    get unsafe() {
      throw new Error("getter ran");
    },
  };
  const measured = estimateRetainedDataSize([root, root]);
  expect(measured).toEqual(estimateRetainedDataSize([root]));
  expect(measured.approximateBytes).toBeGreaterThan(shared.payload.length * 2);
  expect(measured.approximateBytes).toBeLessThan(
    estimateRetainedDataSize([{ left: { ...shared }, right: { ...shared } }]).approximateBytes,
  );
  expect(measured.truncated).toBe(true);
  expect(JSON.stringify(measured)).not.toContain(shared.payload);
});

it("bounds cyclic, deep, and broad retained structures", () => {
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  expect(estimateRetainedDataSize([cycle]).truncated).toBe(false);
  expect(estimateRetainedDataSize([Array(100_001).fill(0)]).truncated).toBe(true);
  let deep: unknown = null;
  for (let index = 0; index < 70; index++) {
    deep = { next: deep };
  }
  expect(estimateRetainedDataSize([deep]).truncated).toBe(true);
});

it("bounds native collections and counts shared values without calling custom iterators", () => {
  const shared = { payload: "synthetic row payload" };
  const map = new Map<unknown, unknown>([["row", shared]]);
  const set = new Set([shared]);
  Object.defineProperty(map, Symbol.iterator, {
    value: () => {
      throw new Error("iterator ran");
    },
  });
  const measured = estimateRetainedDataSize([map, set]);
  expect(measured.truncated).toBe(false);
  expect(measured.objects).toBe(3);
  expect(measured.stringBytes).toBe(2 * ("row".length + "payload".length + shared.payload.length));
  expect(
    estimateRetainedDataSize([new Set(Array.from({ length: 100_001 }, (_, i) => i))]).truncated,
  ).toBe(true);
});
