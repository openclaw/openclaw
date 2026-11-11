// @vitest-environment node
import { expect, it } from "vitest";
import { BOARD_GRID_COLUMNS } from "./grid-constants.ts";
import type { BoardGridItem, BoardGridRect } from "./grid.ts";
import { layout, nudge, previewDrag, resize } from "./grid.ts";
function item(name: string, w: number, h: number, order: number): BoardGridItem {
  return { name, w, h, order };
}
function expectNames(items: readonly { name: string }[], names: readonly string[]) {
  expect(items.map((entry) => entry.name)).toEqual(names);
}
const overlaps = (left: BoardGridRect, right: BoardGridRect): boolean =>
  left.x < right.x + right.w &&
  right.x < left.x + left.w &&
  left.y < right.y + right.h &&
  right.y < left.y + left.h;
function expectValid(rects: readonly BoardGridRect[], gravityTight = false): void {
  for (const [index, rect] of rects.entries()) {
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.w).toBeLessThanOrEqual(BOARD_GRID_COLUMNS);
    expect(rect.y).toBeGreaterThanOrEqual(0);
    expect(rect.w).toBeGreaterThanOrEqual(1);
    expect(rect.h).toBeGreaterThanOrEqual(1);
    for (const other of rects.slice(index + 1)) {
      expect(overlaps(rect, other), `${rect.name} overlaps ${other.name}`).toBe(false);
    }
    if (gravityTight && rect.y !== 0) {
      const raised = { ...rect, y: rect.y - 1 };
      expect(
        rects.some((other) => other.name !== rect.name && overlaps(raised, other)),
        `${rect.name} leaves a hole above itself`,
      ).toBe(true);
    }
  }
}
function propertyItems(seed: number, count: number): BoardGridItem[] {
  let value = seed;
  const random = () => {
    value = (value * 1_664_525 + 1_013_904_223) >>> 0;
    return value;
  };
  return Array.from({ length: count }, (_entry, order) =>
    item(String(order), (random() % 18) - 2, (random() % 28) - 3, order),
  );
}
it("breaks duplicate order ties by name", () => {
  expectNames(layout([item("z", 2, 1, 0), item("a", 2, 1, 0)]), ["a", "z"]);
});
it("backfills earlier partial rows after packing a full-width prefix and later full rows", () => {
  const expected = [
    { name: "prefix", x: 0, y: 0, w: 12, h: 3 },
    { name: "left", x: 0, y: 3, w: 5, h: 3 },
    { name: "top-right", x: 5, y: 3, w: 7, h: 1 },
    { name: "lower-full", x: 0, y: 6, w: 12, h: 2 },
    { name: "gap", x: 5, y: 4, w: 7, h: 2 },
    { name: "tail", x: 0, y: 8, w: 1, h: 1 },
  ];
  expect(layout(expected.map(({ name, w, h }, order) => item(name, w, h, order)))).toEqual(
    expected,
  );
});
it("chooses the next empty-cell target by rendered row-major geometry", () => {
  const heterogeneous = [1, 3, 5, 7, 1, 3, 9, 11].map((w, order) =>
    item("abcdefgh"[order]!, w, order % 2 === 0 ? 4 : 2, order),
  );
  const preview = previewDrag(heterogeneous, "a", { name: undefined, x: 10, y: 0 });
  expectNames(preview, ["b", "c", "d", "e", "a", "f", "g", "h"]);
});
it("preserves compaction invariants across generated drag targets", () => {
  for (let seed = 1; seed <= 24; seed += 1) {
    const generated = propertyItems(seed, 24);
    const moving = generated[(seed * 7) % generated.length]!;
    const preview = previewDrag(generated, moving.name, {
      name: undefined,
      x: (seed * 5) % BOARD_GRID_COLUMNS,
      y: (seed * 3) % 18,
    });
    expectValid(layout(preview), true);
    expect(preview.map((entry) => entry.order)).toEqual(
      Array.from({ length: generated.length }, (_entry, order) => order),
    );
  }
});
const emptyNameItems = [item("", 6, 1, 0), item("b", 6, 1, 1)];
it.each([
  ["missing", "a", [item("b", 3, 1, 5), item("a", 3, 1, 2)], ["a", "b"]],
  ["b", "", emptyNameItems, ["b", ""]],
  ["", undefined, emptyNameItems, ["b", ""]],
] as const)("canonicalizes a drag from %s to %s", (moving, target, items, names) => {
  const preview = previewDrag(items, moving, { name: target, x: 100, y: 100 });
  expect(preview.map(({ name, order }) => [name, order])).toEqual(
    names.map((name, order) => [name, order]),
  );
  expectValid(layout(preview));
});
it("resolves successive named targets from the latest preview through pointerup", () => {
  const items = [item("a", 4, 2, 0), item("b", 4, 2, 1), item("c", 4, 2, 2)];
  const before = structuredClone(items);
  const first = previewDrag(items, "c", { name: "a", x: 100, y: 100 });
  expectNames(first, ["c", "a", "b"]);
  const firstSnapshot = structuredClone(first);
  const second = previewDrag(first, "c", { name: "b", x: 100, y: 100 });
  expectNames(second, ["a", "c", "b"]);
  expect(first).toEqual(firstSnapshot);
  expect(previewDrag(second, "c", { name: "b", x: 100, y: 100 })).toEqual(second);
  expect(items).toEqual(before);
});
it("resizes immutably and clamps both axes", () => {
  const items = [item("a", 3, 3, 0), item("b", 4, 4, 1)];
  expect(resize(items, "a", 40, -2)).toEqual([item("a", 12, 1, 0), item("b", 4, 4, 1)]);
  expect(items[0]).toEqual(item("a", 3, 3, 0));
});
it.each([
  ["up", ["b", "a", "c"]],
  ["right", ["a", "c", "b"]],
] as const)("nudges order %s", (direction, expected) => {
  const items = [item("a", 1, 1, 0), item("b", 1, 1, 1), item("c", 1, 1, 2)];
  const result = nudge(items, "b", direction);
  expectNames(result, expected);
  expect(result.map((entry) => entry.order)).toEqual([0, 1, 2]);
});
