import { describe, expect, it } from "vitest";
import {
  selectMemoryHeavyFiles,
  selectTimedHeavyFiles,
  selectUnitHeavyFileGroups,
} from "../../scripts/test-runner-manifest.mjs";

describe("scripts/test-runner-manifest timed selection", () => {
  it("only selects known timed heavy files above the minimum", () => {
    expect(
      selectTimedHeavyFiles({
        candidates: ["a.test.ts", "b.test.ts", "c.test.ts"],
        limit: 3,
        minDurationMs: 1000,
        exclude: new Set(["c.test.ts"]),
        timings: {
          defaultDurationMs: 250,
          files: {
            "a.test.ts": { durationMs: 2500 },
            "b.test.ts": { durationMs: 900 },
            "c.test.ts": { durationMs: 5000 },
          },
        },
      }),
    ).toEqual(["a.test.ts"]);
  });
});

describe("scripts/test-runner-manifest memory selection", () => {
  it("selects known memory hotspots above the minimum", () => {
    expect(
      selectMemoryHeavyFiles({
        candidates: ["a.test.ts", "b.test.ts", "c.test.ts", "d.test.ts"],
        limit: 3,
        minDeltaKb: 256 * 1024,
        exclude: new Set(["c.test.ts"]),
        hotspots: {
          files: {
            "a.test.ts": { deltaKb: 600 * 1024 },
            "b.test.ts": { deltaKb: 120 * 1024 },
            "c.test.ts": { deltaKb: 900 * 1024 },
          },
        },
      }),
    ).toEqual(["a.test.ts"]);
  });

  it("orders selected memory hotspots by descending retained heap", () => {
    expect(
      selectMemoryHeavyFiles({
        candidates: ["a.test.ts", "b.test.ts", "c.test.ts"],
        limit: 2,
        minDeltaKb: 1,
        hotspots: {
          files: {
            "a.test.ts": { deltaKb: 300 },
            "b.test.ts": { deltaKb: 700 },
            "c.test.ts": { deltaKb: 500 },
          },
        },
      }),
    ).toEqual(["b.test.ts", "c.test.ts"]);
  });

  it("gives memory-heavy isolation precedence over timed-heavy buckets", () => {
    expect(
      selectUnitHeavyFileGroups({
        candidates: ["overlap.test.ts", "memory-only.test.ts", "timed-only.test.ts"],
        behaviorOverrides: new Set(),
        timedLimit: 3,
        timedMinDurationMs: 1000,
        memoryLimit: 3,
        memoryMinDeltaKb: 256 * 1024,
        timings: {
          defaultDurationMs: 250,
          files: {
            "overlap.test.ts": { durationMs: 5000 },
            "timed-only.test.ts": { durationMs: 4200 },
          },
        },
        hotspots: {
          files: {
            "overlap.test.ts": { deltaKb: 900 * 1024 },
            "memory-only.test.ts": { deltaKb: 700 * 1024 },
          },
        },
      }),
    ).toEqual({
      memoryHeavyFiles: ["overlap.test.ts", "memory-only.test.ts"],
      timedHeavyFiles: ["timed-only.test.ts"],
    });
  });
});
