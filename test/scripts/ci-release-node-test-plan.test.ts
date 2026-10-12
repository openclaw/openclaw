import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { listWholeConfigSplitFiles } from "../../scripts/lib/ci-node-test-inventory.mts";
import type { NodeTestShard } from "../../scripts/lib/ci-node-test-plan.mts";
import * as testTimings from "../../scripts/lib/ci-test-timings.mts";
import * as testFileInventory from "../../scripts/lib/list-test-files.mts";
import * as shardMetadata from "../../scripts/lib/vitest-shard-metadata.mts";
import { fullSuiteVitestShards } from "../vitest/vitest.test-shards.mjs";

afterEach(() => vi.restoreAllMocks());

it.each([
  {
    owner: "agentic-gateway-methods",
    configs: [
      "test/vitest/vitest.gateway-methods.config.ts",
      "test/vitest/vitest.gateway-methods-isolated.config.ts",
    ],
  },
  { owner: "agentic-cli-process", configs: ["test/vitest/vitest.cli-process.config.ts"] },
  { owner: "core-runtime-config", configs: ["test/vitest/vitest.runtime-config.config.ts"] },
])(
  "retains complete $owner walls across inventory changes until refitted",
  async ({ owner, configs }) => {
    const original = fullSuiteVitestShards.slice();
    const files = expectDefined(listWholeConfigSplitFiles(owner), "release owner inventory");
    vi.spyOn(shardMetadata, "estimateVitestTestFileSeconds").mockReturnValue(1);
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
      const { createNodeTestShardBundles } =
        await import("../../scripts/lib/ci-node-test-plan.mts");
      const full = () => createNodeTestShardBundles({ runnerBackend: "github" });
      // An incomplete generation cannot price the complete owner.
      const unmeasured = full();
      expect(unmeasured).toHaveLength(1);
      expect(unmeasured[0]?.predictedSeconds).toBeUndefined();
      expect(unmeasured[0]?.timeoutMinutes).toBe(
        owner === "agentic-gateway-methods" ? undefined : 90,
      );
      const pullRequest = { compactMode: "pull-request", runnerBackend: "github" } as const;
      const beforePr = createNodeTestShardBundles(pullRequest);
      const beforeBlacksmith = createNodeTestShardBundles({ runnerBackend: "blacksmith" });

      measurements[historical.timingKeys[1]!] = 355;
      const retired = shardMetadata.createCompactSplitTimingGeneration({
        configs,
        parentShardName,
        stripes: [[historicalFiles.at(-1)!]],
      });
      measurements[retired.timingKeys[0]!] = 900;
      const rows = full();
      expect(rows.length).toBeGreaterThan(1);
      expect(rows.flatMap((row) => row.includePatterns ?? []).toSorted()).toEqual(files.toSorted());
      expect(rows.reduce((sum, row) => sum + row.predictedSeconds!, 0)).toBeGreaterThanOrEqual(
        3355,
      );
      for (const row of rows) {
        expect(row.shardName).toMatch(new RegExp(`^${owner}-hosted-\\d+$`, "u"));
        expect(row.predictedSeconds).toBeLessThanOrEqual(720);
        expect(row.configs).toEqual(configs);
        expect(row.env).toBeUndefined();
        expect(row.requiresDist).toBe(false);
        expect(row.runner).toBe(beforeBlacksmith[0]!.runner);
        expect(row.timeoutMinutes).toBe(beforeBlacksmith[0]!.timeoutMinutes);
        measurements[expectDefined(row.timing_key, "release split timing identity")] = 50;
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
  },
);

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
    const rowFiles = (row: NodeTestShard) =>
      (row.groups ?? [row]).flatMap((group) => group.includePatterns ?? []);
    const blacksmith = createNodeTestShardBundles({ runnerBackend: "blacksmith" });
    const releaseRows = () =>
      createNodeTestShardBundles({ runnerBackend: "github" }).filter((row) =>
        rowFiles(row).some((file) => files.includes(file)),
      );
    const before = releaseRows();
    expect(before).toHaveLength(1);
    const owner = before[0]!;
    const parentKey = `release-full-${owner.shardName}`;
    measurements[parentKey] = 1800;
    const split = releaseRows();
    expect(split).toHaveLength(3);
    expect(split.flatMap(rowFiles).toSorted()).toEqual(files);
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
    expect(next.flatMap(rowFiles).toSorted()).toEqual(files);
    expect(createNodeTestShardBundles({ runnerBackend: "blacksmith" })).toEqual(blacksmith);
    measurements[expectDefined(next[0]?.timing_key, "first split identity")] = 2000;
    const resplit = releaseRows();
    expect(resplit.length).toBeGreaterThan(3);
    expect(resplit.every((row) => row.predictedSeconds! <= 720)).toBe(true);
    expect(resplit.flatMap(rowFiles).toSorted()).toEqual(files);
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
    expect(repriced.flatMap(rowFiles).toSorted()).toEqual(files);
    expect(repriced.every((row) => row.predictedSeconds! <= 720)).toBe(true);
    expect(repriced.reduce((sum, row) => sum + row.predictedSeconds!, 0)).toBeGreaterThanOrEqual(
      2561,
    );
    const packedKnown = expectDefined(
      repriced.find((row) => rowFiles(row).includes(files[0]!)),
      "measured singleton job",
    );
    expect(rowFiles(packedKnown).toSorted()).toEqual(files.slice(0, 2));
    expect(packedKnown.predictedSeconds).toBe(509);
    expect(packedKnown.planConcurrency).toBe(1);
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

it("fits measured release work without changing coverage or worker contracts", async () => {
  const { createNodeTestShardBundles } = await import("../../scripts/lib/ci-node-test-plan.mts");
  const options = { includeReleaseOnlyPluginShards: false, includeProofTests: true };
  const rows = createNodeTestShardBundles({ ...options, runnerBackend: "github" });
  const before = createNodeTestShardBundles({ ...options, runnerBackend: "blacksmith" });
  const groupsOf = (jobs: NodeTestShard[]) =>
    jobs.flatMap((row) => row.groups ?? [{ ...row, shard_name: row.shardName }]);
  const contracts = (jobs: NodeTestShard[]) =>
    groupsOf(jobs)
      .flatMap((group) =>
        (
          group.includePatterns ??
          listWholeConfigSplitFiles(group.shard_name) ?? ["whole-config"]
        ).map((file) => [
          group.configs,
          Object.entries({
            ...group.env,
            OPENCLAW_VITEST_MAX_WORKERS: String(
              Math.min(2, Number(group.env?.OPENCLAW_VITEST_MAX_WORKERS ?? 2)),
            ),
          }).toSorted(([left], [right]) => left.localeCompare(right)),
          group.pretestBuildMode,
          group.requiresDist,
          group.runner,
          file,
        ]),
      )
      .map((contract) => JSON.stringify(contract))
      .toSorted();
  expect(contracts(rows)).toEqual(contracts(before));
  const groups = groupsOf(rows);
  for (const owner of [
    "agentic-cli-process",
    "agentic-control-plane-agent-chat",
    "core-runtime-config",
  ]) {
    const owns = (name: string) => name.startsWith(`${owner}-hosted-`);
    const owned = groups.filter((group) => owns(group.shard_name));
    expect(owned.length, owner).toBeGreaterThan(1);
    for (const group of owned) {
      expect(group.includePatterns!.length).toBeLessThanOrEqual(64);
    }
    for (const row of rows.filter((job) =>
      groupsOf([job]).some((group) => owns(group.shard_name)),
    )) {
      expect(row.predictedSeconds, owner).toBeLessThanOrEqual(720);
      expect(row.timeoutMinutes, owner).not.toBe(90);
    }
  }
  const packed = rows.filter((row) => row.groups);
  expect(packed.length).toBeGreaterThan(0);
  for (const row of packed) {
    expect(row.planConcurrency).toBe(1);
    expect(row.predictedSeconds).toBeLessThanOrEqual(720);
    for (const group of row.groups!) {
      expect(Number(group.env?.OPENCLAW_VITEST_MAX_WORKERS)).toBeLessThanOrEqual(2);
      expect(group.timing_key).toMatch(/^release-full-/u);
    }
  }
});
