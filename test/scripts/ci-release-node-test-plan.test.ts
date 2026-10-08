import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { listWholeConfigSplitFiles } from "../../scripts/lib/ci-node-test-inventory.mts";
import * as testTimings from "../../scripts/lib/ci-test-timings.mts";
import * as testFileInventory from "../../scripts/lib/list-test-files.mts";
import * as shardMetadata from "../../scripts/lib/vitest-shard-metadata.mts";
import { fullSuiteVitestShards } from "../vitest/vitest.test-shards.mjs";

afterEach(() => vi.restoreAllMocks());

it("retains complete Gateway methods walls across inventory changes until refitted", async () => {
  const original = fullSuiteVitestShards.slice();
  const owner = "agentic-gateway-methods";
  const configs = [
    "test/vitest/vitest.gateway-methods.config.ts",
    "test/vitest/vitest.gateway-methods-isolated.config.ts",
  ];
  const files = expectDefined(listWholeConfigSplitFiles(owner), "Gateway methods inventory");
  const historicalFiles = [
    ...files.slice(0, -2),
    "src/gateway/server-methods/retired-timing-fixture.test.ts",
  ];
  const parentShardName = `release-full-${owner}`;
  const historical = shardMetadata.createCompactSplitTimingGeneration({
    configs,
    parentShardName,
    stripes: [historicalFiles.slice(0, 2), historicalFiles.slice(2)],
  });
  const measurements: Record<string, number> = { [historical.timingKeys[0]!]: 3000 };
  vi.spyOn(testTimings, "readCompactGroupTimings").mockReturnValue(measurements);
  fullSuiteVitestShards.splice(
    0,
    fullSuiteVitestShards.length,
    ...original
      .map((shard) => ({
        ...shard,
        projects: shard.projects.filter((config) => configs.includes(config)),
      }))
      .filter((shard) => shard.projects.length > 0),
  );
  try {
    const { createNodeTestShardBundles } = await import("../../scripts/lib/ci-node-test-plan.mts");
    const full = () => createNodeTestShardBundles({ runnerBackend: "github" });
    // An incomplete generation cannot price the complete owner.
    expect(full()).toHaveLength(1);
    expect(full()[0]?.predictedSeconds).toBeUndefined();
    const pullRequest = { compactMode: "pull-request", runnerBackend: "github" } as const;
    const beforePr = createNodeTestShardBundles(pullRequest);
    const beforeBlacksmith = createNodeTestShardBundles({ runnerBackend: "blacksmith" });

    measurements[historical.timingKeys[1]!] = 355;
    const rows = full();
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.flatMap((row) => row.includePatterns ?? []).toSorted()).toEqual(files.toSorted());
    expect(rows.reduce((sum, row) => sum + row.predictedSeconds!, 0)).toBeGreaterThanOrEqual(3355);
    for (const row of rows) {
      expect(row.shardName).toMatch(/^agentic-gateway-methods-hosted-\d+$/u);
      expect(row.predictedSeconds).toBeLessThanOrEqual(720);
      expect(row.configs).toEqual(configs);
      expect(row.env).toBeUndefined();
      expect(row.requiresDist).toBe(false);
      expect(row.runner).toBe(beforeBlacksmith[0]!.runner);
      measurements[expectDefined(row.timing_key, "Gateway split timing identity")] = 50;
    }
    expect(createNodeTestShardBundles(pullRequest)).toEqual(beforePr);
    expect(createNodeTestShardBundles({ runnerBackend: "blacksmith" })).toEqual(beforeBlacksmith);

    // A complete observation of the current inventory retires the historical floor.
    const refitted = full();
    expect(refitted).toHaveLength(1);
    expect(refitted[0]?.predictedSeconds).toBe(rows.length * 50);
    for (const row of rows) {
      measurements[row.timing_key!] = 0;
    }
    expect(full()).toHaveLength(1);
  } finally {
    fullSuiteVitestShards.splice(0, fullSuiteVitestShards.length, ...original);
  }
});

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
    weights.mockImplementation((file) => (files.slice(0, 2).includes(file) ? 200 : 25));
    const sampledGeneration = shardMetadata.createCompactSplitTimingGeneration({
      configs: owner.configs,
      env: owner.env,
      parentShardName: parentKey,
      stripes: [[files[0]!], [files[1]!], files.slice(2, 4), files.slice(4)],
    });
    sampledGeneration.timingKeys.forEach((key, index) => {
      measurements[key] = [240, 269, 941, 1111][index]!;
    });
    const repriced = releaseRows();
    expect(repriced.flatMap((row) => row.includePatterns ?? []).toSorted()).toEqual(files);
    expect(repriced.every((row) => row.predictedSeconds! <= 720)).toBe(true);
    expect(repriced.reduce((sum, row) => sum + row.predictedSeconds!, 0)).toBeGreaterThanOrEqual(
      2561,
    );
    for (const [index, seconds] of [240, 269].entries()) {
      expect(
        repriced.find(
          (row) => row.includePatterns?.length === 1 && row.includePatterns[0] === files[index],
        )?.predictedSeconds,
      ).toBe(seconds);
    }
    for (const key of Object.keys(measurements)) {
      delete measurements[key];
    }
    weights.mockReturnValue(10);
    const knownGeneration = shardMetadata.createCompactSplitTimingGeneration({
      configs: owner.configs,
      env: owner.env,
      parentShardName: parentKey,
      stripes: files.toReversed().map((file) => [file]),
    });
    for (const key of knownGeneration.timingKeys) {
      measurements[key] = 100;
    }
    measurements[parentKey] = 1200;
    const allKnown = releaseRows();
    expect(allKnown.every((row) => row.predictedSeconds! <= 720)).toBe(true);
    expect(allKnown.reduce((sum, row) => sum + row.predictedSeconds!, 0)).toBeGreaterThanOrEqual(
      1200,
    );
    for (const row of allKnown) {
      measurements[row.timing_key!] = 500;
    }
    expect(releaseRows().every((row) => row.predictedSeconds === 500)).toBe(true);
    for (const key of Object.keys(measurements)) {
      delete measurements[key];
    }
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

it("gives measured long unfitted release rows room above the hosted job cap", async () => {
  const { createNodeTestShardBundles } = await import("../../scripts/lib/ci-node-test-plan.mts");
  const rows = createNodeTestShardBundles({ runnerBackend: "github" });
  for (const owner of [
    "agentic-cli-process",
    "agentic-control-plane-agent-chat",
    "core-runtime-config",
  ]) {
    const row = rows.find((candidate) => candidate.shardName === owner);
    expect(row?.timeoutMinutes, owner).toBe(90);
  }
});
