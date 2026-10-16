// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  BOARD_GRID_COLUMNS,
  layout,
  nudge,
  previewDrag,
  resize,
  type BoardGridItem,
  type BoardGridRect,
} from "./grid.ts";

function item(name: string, w: number, h: number, order: number): BoardGridItem {
  return { name, w, h, order };
}

function overlaps(left: BoardGridRect, right: BoardGridRect): boolean {
  return (
    left.x < right.x + right.w &&
    right.x < left.x + left.w &&
    left.y < right.y + right.h &&
    right.y < left.y + left.h
  );
}

function expectValid(rects: readonly BoardGridRect[]): void {
  for (const [index, rect] of rects.entries()) {
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.w).toBeLessThanOrEqual(BOARD_GRID_COLUMNS);
    expect(rect.y).toBeGreaterThanOrEqual(0);
    expect(rect.w).toBeGreaterThanOrEqual(1);
    expect(rect.h).toBeGreaterThanOrEqual(1);
    for (const other of rects.slice(index + 1)) {
      expect(overlaps(rect, other), `${rect.name} overlaps ${other.name}`).toBe(false);
    }
  }
}

function expectGravityTight(rects: readonly BoardGridRect[]): void {
  for (const rect of rects) {
    if (rect.y === 0) {
      continue;
    }
    const raised = { ...rect, y: rect.y - 1 };
    expect(
      rects.some((other) => other.name !== rect.name && overlaps(raised, other)),
      `${rect.name} leaves a hole above itself`,
    ).toBe(true);
  }
}

function propertyItems(seed: number, count: number): BoardGridItem[] {
  let value = seed;
  const random = () => {
    value = (value * 1_664_525 + 1_013_904_223) >>> 0;
    return value;
  };
  return Array.from({ length: count }, (_entry, order) =>
    item(
      `widget-${String(order).padStart(2, "0")}`,
      (random() % 18) - 2,
      (random() % 28) - 3,
      order,
    ),
  );
}

describe("board grid layout", () => {
  it("breaks duplicate order ties by name", () => {
    expect(layout([item("z", 2, 1, 0), item("a", 2, 1, 0)]).map((rect) => rect.name)).toEqual([
      "a",
      "z",
    ]);
  });
});

describe("board grid drag preview", () => {
  const items = [item("a", 4, 2, 0), item("b", 4, 2, 1), item("c", 4, 2, 2)];

  it("chooses the next empty-cell target by rendered row-major geometry", () => {
    const heterogeneous = [
      item("a", 1, 4, 0),
      item("b", 3, 2, 1),
      item("c", 5, 4, 2),
      item("d", 7, 2, 3),
      item("e", 1, 4, 4),
      item("f", 3, 2, 5),
      item("g", 9, 4, 6),
      item("h", 11, 2, 7),
    ];
    expect(
      previewDrag(heterogeneous, "a", { name: undefined, x: 10, y: 0 }).map((entry) => entry.name),
    ).toEqual(["b", "c", "d", "e", "a", "f", "g", "h"]);
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
      const rects = layout(preview);
      expectValid(rects);
      expectGravityTight(rects);
      expect(preview.map((entry) => entry.order)).toEqual(
        Array.from({ length: generated.length }, (_entry, order) => order),
      );
    }
  });

  it("returns a compact canonical board for an unknown item", () => {
    const preview = previewDrag([item("b", 3, 1, 5), item("a", 3, 1, 2)], "missing", {
      name: "a",
      x: 0,
      y: 0,
    });
    expect(preview.map((entry) => [entry.name, entry.order])).toEqual([
      ["a", 0],
      ["b", 1],
    ]);
    expectValid(layout(preview));
  });

  it("preserves empty widget names in moving and target positions", () => {
    const emptyNameItems = [item("", 6, 1, 0), item("b", 6, 1, 1)];
    const preview = previewDrag(emptyNameItems, "b", {
      name: "",
      x: 100,
      y: 100,
    });
    expect(preview.map((entry) => entry.name)).toEqual(["b", ""]);
    expectValid(layout(preview));
    expect(
      previewDrag(emptyNameItems, "", { name: undefined, x: 100, y: 100 }).map(
        (entry) => entry.name,
      ),
    ).toEqual(["b", ""]);
  });

  it("resolves successive named targets from the latest preview through pointerup", () => {
    const before = structuredClone(items);
    const first = previewDrag(items, "c", { name: "a", x: 100, y: 100 });
    expect(first.map((entry) => entry.name)).toEqual(["c", "a", "b"]);
    const firstSnapshot = structuredClone(first);
    const second = previewDrag(first, "c", { name: "b", x: 100, y: 100 });
    expect(second.map((entry) => entry.name)).toEqual(["a", "c", "b"]);
    expect(first).toEqual(firstSnapshot);
    expect(previewDrag(second, "c", { name: "b", x: 100, y: 100 })).toEqual(second);
    expectValid(layout(second));
    expectGravityTight(layout(second));
    expect(items).toEqual(before);
  });
});

describe("board grid mutations", () => {
  it("resizes immutably and clamps both axes", () => {
    const items = [item("a", 3, 3, 0), item("b", 4, 4, 1)];
    expect(resize(items, "a", 40, -2)).toEqual([item("a", 12, 1, 0), item("b", 4, 4, 1)]);
    expect(items[0]).toEqual(item("a", 3, 3, 0));
  });

  it.each([
    ["up", ["b", "a", "c"]],
    ["right", ["a", "c", "b"]],
  ] as const)("nudges order %s", (direction, expected) => {
    const result = nudge(
      [item("a", 1, 1, 0), item("b", 1, 1, 1), item("c", 1, 1, 2)],
      "b",
      direction,
    );
    expect(result.map((entry) => entry.name)).toEqual(expected);
    expect(result.map((entry) => entry.order)).toEqual([0, 1, 2]);
  });
});
