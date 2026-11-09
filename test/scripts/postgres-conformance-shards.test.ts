import { describe, expect, it } from "vitest";
import {
  PG16_GATEWAY_SMOKE_RESERVATION_SECONDS,
  assignPostgresConformanceShards,
  createPostgresConformanceEstimator,
} from "../../scripts/lib/postgres-conformance-shards.mts";

const timings: Parameters<typeof createPostgresConformanceEstimator>[0] = {
  workers: 3,
  preparationSeconds: { base: 10, runtime: 100 },
  groupSeconds: { infra: 2, commands: 3 },
  runtimeTargets: ["runtime-a", "runtime-b"],
  files: {
    a: { group: "infra", seconds: 30 },
    b: { group: "infra", seconds: 20 },
    c: { group: "commands", seconds: 40 },
    d: { group: "infra", seconds: 10 },
    "runtime-a": { group: "infra", seconds: 10 },
    "runtime-b": { group: "infra", seconds: 10 },
  },
};
const estimate = createPostgresConformanceEstimator(timings, () => 1);

describe("PostgreSQL conformance cost model", () => {
  it("shares workers within a configuration and sums sequential configurations", () => {
    expect(estimate(["a", "b"])).toBe(42);
    expect(estimate(["a", "b", "c"])).toBe(85);
  });

  it("charges runtime preparation once per occupied shard", () => {
    expect(estimate(["runtime-a", "runtime-b"])).toBe(112);
    const shards = assignPostgresConformanceShards(["runtime-a", "runtime-b", "c"], 2, estimate);
    expect(shards.some((shard) => shard.includes("runtime-a") && shard.includes("runtime-b"))).toBe(
      true,
    );
  });

  it("reserves the first shard's PG16 smoke while balancing PG17 work", () => {
    const targets = Array.from({ length: 12 }, (_, index) => `test-${index}`);
    const estimateWork = (selected: readonly string[]) => selected.length * 50;
    const shards = assignPostgresConformanceShards(targets, 3, estimateWork);
    expect(shards.map(estimateWork)).toEqual([
      250 - PG16_GATEWAY_SMOKE_RESERVATION_SECONDS,
      250,
      250,
    ]);
    expect(shards.flat().toSorted()).toEqual(targets.toSorted());
  });

  it("prices the cold file-size order instead of optimistically running slow files first", () => {
    const model = createPostgresConformanceEstimator(
      {
        ...timings,
        workers: 2,
        files: {
          "dir/large": { group: "infra", seconds: 10 },
          "dir/medium": { group: "infra", seconds: 10 },
          "dir/small": { group: "infra", seconds: 30 },
        },
      },
      (file) => ({ "dir/large": 3, "dir/medium": 2, "dir/small": 1 })[file] ?? 0,
    );
    expect(model(["dir"])).toBe(52);
  });

  it("retains unsampled targets and deterministically partitions the complete inventory", () => {
    const targets = ["a", "b", "c", "d", "new.test.ts"];
    const shards = assignPostgresConformanceShards(targets, 3, estimate);
    expect(shards.flat().toSorted()).toEqual(targets.toSorted());
    expect(assignPostgresConformanceShards(targets.toReversed(), 3, estimate)).toEqual(shards);
    expect(estimate(["new.test.ts"])).toBe(40);
    expect(estimate([])).toBe(0);
  });
});
