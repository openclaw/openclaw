import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import { recordGcCollections } from "../../scripts/lib/perf-gc-collections.ts";

it("appends only collections starting inside each measurement window", () => {
  const name = "perf-gc-collections-test";
  try {
    const entries = [9, 10, 19, 20].map((start, kind) =>
      performance.measure(name, { start, duration: kind + 1, detail: { kind } }),
    );
    const collections = [{ kind: 8, ms: 0.5 }];
    recordGcCollections(entries.slice(0, 2), collections, 10, 20);
    recordGcCollections(entries.slice(2), collections, 10, 20);
    expect(collections).toEqual([
      { kind: 8, ms: 0.5 },
      { kind: 1, ms: 2 },
      { kind: 2, ms: 3 },
    ]);
    const next: typeof collections = [];
    recordGcCollections(entries, next, 20, 30);
    expect(next).toEqual([{ kind: 3, ms: 4 }]);
  } finally {
    performance.clearMeasures(name);
  }
});
