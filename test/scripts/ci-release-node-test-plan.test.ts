import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import * as testTimings from "../../scripts/lib/ci-test-timings.mts";
import * as testFileInventory from "../../scripts/lib/list-test-files.mts";
import * as shardMetadata from "../../scripts/lib/vitest-shard-metadata.mts";
import { fullSuiteVitestShards } from "../vitest/vitest.test-shards.mjs";

afterEach(() => vi.restoreAllMocks());

it("splits measured full-release hosted rows without losing their execution contract", async () => {
  const original = fullSuiteVitestShards.slice();
  const config = "test/vitest/vitest.auto-reply-reply.config.ts";
  const files = Array.from(
    { length: 6 },
    (_, index) => `src/auto-reply/reply/session-release-fixture-${index}.test.ts`,
  );
  fullSuiteVitestShards.splice(
    0,
    fullSuiteVitestShards.length,
    ...original
      .map((shard) => ({ ...shard, projects: shard.projects.filter((entry) => entry === config) }))
      .filter((shard) => shard.projects.length > 0),
  );
  vi.spyOn(testFileInventory, "listTrackedTestFiles").mockReturnValue(files);
  const weights = vi.spyOn(shardMetadata, "estimateVitestTestFileSeconds").mockReturnValue(10);
  const measurements: Record<string, number> = {};
  vi.spyOn(testTimings, "readCompactGroupTimings").mockReturnValue(measurements);
  try {
    const { createNodeTestShardBundles } = await import("../../scripts/lib/ci-node-test-plan.mts");
    const blacksmith = createNodeTestShardBundles({ runnerBackend: "blacksmith" });
    const releaseRows = () =>
      createNodeTestShardBundles({ runnerBackend: "github" }).filter((row) =>
        row.includePatterns?.some((file) => files.includes(file)),
      );
    const before = releaseRows();
    expect(before).toHaveLength(1);
    const owner = before[0]!;
    const parentKey = `release-full-${owner.shardName}`;
    measurements[parentKey] = 1800;
    const split = releaseRows();
    expect(split).toHaveLength(3);
    expect(split.flatMap((row) => row.includePatterns ?? []).toSorted()).toEqual(files);
    expect(new Set(split.map((row) => row.checkName)).size).toBe(3);
    for (const row of split) {
      expect(row.predictedSeconds).toBeLessThanOrEqual(720);
      expect(row).toMatchObject({
        configs: owner.configs,
        runner: owner.runner,
        requiresDist: owner.requiresDist,
      });
      expect(row.env).toEqual(owner.env);
      expect(row.pretestBuildMode).toBe(owner.pretestBuildMode);
      measurements[expectDefined(row.timing_key, "split timing identity")] = 700;
    }
    delete measurements[parentKey];
    const next = releaseRows();
    expect(next).toHaveLength(3);
    expect(next.flatMap((row) => row.includePatterns ?? []).toSorted()).toEqual(files);
    expect(createNodeTestShardBundles({ runnerBackend: "blacksmith" })).toEqual(blacksmith);
    measurements[expectDefined(next[0]?.timing_key, "first split identity")] = 2000;
    const resplit = releaseRows();
    expect(resplit.length).toBeGreaterThan(3);
    expect(resplit.every((row) => row.predictedSeconds! <= 720)).toBe(true);
    expect(resplit.flatMap((row) => row.includePatterns ?? []).toSorted()).toEqual(files);
    for (const row of resplit) {
      measurements[row.timing_key!] = 600;
    }
    weights.mockImplementation((file) => (file === files[0] ? 9 : 1));
    expect(releaseRows().map((row) => row.predictedSeconds)).toEqual(files.map(() => 600));
    for (const row of resplit) {
      measurements[row.timing_key!] = 2000;
    }
    expect(releaseRows).toThrow("indivisible test above the hosted budget");
    for (const key of Object.keys(measurements)) {
      delete measurements[key];
    }
    weights.mockReturnValue(10);
    const oldGeneration = shardMetadata.createCompactSplitTimingGeneration({
      configs: owner.configs,
      env: owner.env,
      parentShardName: parentKey,
      stripes: [files.slice(0, 2), ...files.slice(2).map((file) => [file])],
    });
    oldGeneration.timingKeys.forEach((key, index) => {
      measurements[key] = index === 1 ? 2000 : 10;
    });
    expect(releaseRows).toThrow("indivisible test above the hosted budget");
  } finally {
    fullSuiteVitestShards.splice(0, fullSuiteVitestShards.length, ...original);
  }
});
