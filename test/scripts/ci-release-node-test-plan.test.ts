import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { listWholeConfigSplitFiles } from "../../scripts/lib/ci-node-test-inventory.mts";
import type { NodeTestShard } from "../../scripts/lib/ci-node-test-plan.mts";
import * as testTimings from "../../scripts/lib/ci-test-timings.mts";
import * as testFileInventory from "../../scripts/lib/list-test-files.mts";
import * as shardMetadata from "../../scripts/lib/vitest-shard-metadata.mts";
import { fullSuiteVitestShards as shards } from "../vitest/vitest.test-shards.mjs";

type Env = NodeTestShard["env"];
const original = shards.slice();
afterEach(() => {
  shards.splice(0, shards.length, ...original);
  vi.restoreAllMocks();
});

async function releaseFixture(configs: string[], estimate = 1, files?: string[]) {
  const selected = original.flatMap((shard) => {
    const projects = shard.projects.filter((config) => configs.includes(config));
    return projects.length ? [{ ...shard, projects }] : [];
  });
  shards.splice(0, shards.length, ...selected);
  if (files) {
    vi.spyOn(testFileInventory, "listTrackedTestFiles").mockReturnValue(files);
  }
  const weights = vi.spyOn(shardMetadata, "estimateVitestTestFileSeconds");
  weights.mockReturnValue(estimate);
  const prices: Record<string, number> = {};
  vi.spyOn(testTimings, "readCompactGroupTimings").mockReturnValue(prices);
  const { createNodeTestShardBundles: plan } =
    await import("../../scripts/lib/ci-node-test-plan.mts");
  const price = (rows: ReadonlyArray<{ timing_key?: string }>, seconds: number) => {
    for (const row of rows) {
      prices[expectDefined(row.timing_key, "split timing identity")] = seconds;
    }
  };
  const clear = () => Object.keys(prices).forEach((key) => delete prices[key]);
  const measure = (parent: string, stripes: string[][], seconds: number[], env?: Env) => {
    const options = { configs, env, parentShardName: parent, stripes };
    const { timingKeys } = shardMetadata.createCompactSplitTimingGeneration(options);
    seconds.forEach((value, index) => {
      prices[timingKeys[index]!] = value;
    });
    return timingKeys;
  };
  const full = () => plan({ runnerBackend: "github" });
  return { plan, full, prices, weights, price, clear, measure };
}

const rowFiles = (row: NodeTestShard) =>
  (row.groups ?? [row]).flatMap((group) => group.includePatterns ?? []);
// Release packing may pair measured stripes into one job; each stripe keeps its
// own process and timing identity as a packed group.
const splitUnits = (rows: NodeTestShard[]): Array<{ shardName: string; timing_key?: string }> =>
  rows.flatMap((row) =>
    row.groups
      ? row.groups.map((group) => ({ shardName: group.shard_name, timing_key: group.timing_key }))
      : [{ shardName: row.shardName, timing_key: row.timing_key }],
  );
const totalSeconds = (rows: NodeTestShard[]) =>
  rows.reduce((sum, row) => sum + row.predictedSeconds!, 0);
function expectInventory(rows: NodeTestShard[], files: string[]) {
  expect(rows.flatMap(rowFiles).toSorted()).toEqual(files.toSorted());
}

it.each([
  ["agentic-gateway-methods", ["gateway-methods", "gateway-methods-isolated"], undefined],
  ["agentic-agents-support", ["agents-support"], 90],
  ["agentic-cli-process", ["cli-process"], 90],
] as const)("keeps %s timing walls until refitted", async (owner, names, timeout) => {
  const configs = names.map((name) => `test/vitest/vitest.${name}.config.ts`);
  const files = expectDefined(listWholeConfigSplitFiles(owner), "release owner inventory");
  const { plan, full, prices, price, measure } = await releaseFixture(configs);
  const retiredFile = "src/gateway/server-methods/retired-timing-fixture.test.ts";
  const historicalFiles = [...files.slice(0, -2), retiredFile];
  const parentShardName = `release-full-${owner}`;
  const stripes = [historicalFiles.slice(0, 2), historicalFiles.slice(2)];
  const historical = measure(parentShardName, stripes, [3000]);
  expect(full().map((row) => [row.predictedSeconds, row.timeoutMinutes])).toEqual([
    [undefined, timeout],
  ]);
  const pullRequest = { compactMode: "pull-request", runnerBackend: "github" } as const;
  const beforePr = plan(pullRequest);
  const beforeBlacksmith = plan({ runnerBackend: "blacksmith" });
  prices[historical[1]!] = 355;
  measure(parentShardName, [[historicalFiles.at(-1)!]], [900]);
  const rows = full();
  expect(rows.length).toBeGreaterThan(1);
  expectInventory(rows, files);
  expect(totalSeconds(rows)).toBeGreaterThanOrEqual(3355);
  const units = splitUnits(rows);
  for (const unit of units) {
    expect(unit.shardName).toMatch(new RegExp(`^${owner}-hosted-\\d+$`, "u"));
  }
  for (const row of rows) {
    expect(row.predictedSeconds).toBeLessThanOrEqual(720);
    expect(row.env).toBeUndefined();
    expect(row.timeoutMinutes).toBe(beforeBlacksmith[0]!.timeoutMinutes);
  }
  price(units, 50);
  expect(plan(pullRequest)).toEqual(beforePr);
  expect(plan({ runnerBackend: "blacksmith" })).toEqual(beforeBlacksmith);
  expect(full().map((row) => row.predictedSeconds)).toEqual([units.length * 50]);
  price(units, 0);
  expect(full()).toHaveLength(1);
});

it("splits measured full-release hosted rows without losing their execution contract", async () => {
  const config = "test/vitest/vitest.auto-reply-reply.config.ts";
  const prefix = "src/auto-reply/reply/session-release-fixture";
  const files = Array.from({ length: 6 }, (_, i) => `${prefix}-${i}.test.ts`);
  const fixture = await releaseFixture([config], 10, files);
  const { plan, full, prices, weights, price, clear } = fixture;
  const blacksmith = plan({ runnerBackend: "blacksmith" });
  const releaseRows = () =>
    full().filter((row) => rowFiles(row).some((file) => files.includes(file)));
  const before = releaseRows();
  expect(before).toHaveLength(1);
  const owner = before[0]!;
  const mode = owner.pretestBuildMode;
  const parentKey = `release-full-${owner.shardName}`;
  const measure = (stripes: string[][], seconds: number[]) =>
    fixture.measure(parentKey, stripes, seconds, owner.env);
  prices[parentKey] = 1800;
  const split = releaseRows();
  expect(split).toHaveLength(3);
  expectInventory(split, files);
  expect(new Set(split.map((row) => row.checkName)).size).toBe(3);
  expect(split.every((row) => row.predictedSeconds! <= 720)).toBe(true);
  expect(split.map((row) => row.env)).toEqual(split.map(() => owner.env));
  expect(split.map((row) => row.pretestBuildMode)).toEqual(split.map(() => mode));
  price(split, 700);
  delete prices[parentKey];
  const next = releaseRows();
  expect(next).toHaveLength(3);
  expectInventory(next, files);
  expect(plan({ runnerBackend: "blacksmith" })).toEqual(blacksmith);
  prices[expectDefined(next[0]?.timing_key, "first split identity")] = 2000;
  const resplit = releaseRows();
  expect(resplit.length).toBeGreaterThan(3);
  expect(resplit.every((row) => row.predictedSeconds! <= 720)).toBe(true);
  expectInventory(resplit, files);
  price(resplit, 600);
  weights.mockImplementation((file) => (file === files[0] ? 9 : 1));
  expect(releaseRows().map((row) => row.predictedSeconds)).toEqual(files.map(() => 600));
  price(resplit, 2000);
  expect(releaseRows).toThrow("indivisible test above the hosted budget");
  clear();
  weights.mockImplementation((file) => (files.slice(0, 2).includes(file) ? 200 : 25));
  measure([[files[0]!], [files[1]!], files.slice(2, 4), files.slice(4)], [240, 269, 941, 1111]);
  const repriced = releaseRows();
  expectInventory(repriced, files);
  expect(repriced.every((row) => row.predictedSeconds! <= 720)).toBe(true);
  expect(totalSeconds(repriced)).toBeGreaterThanOrEqual(2561);
  const packedKnown = expectDefined(
    repriced.find((row) => rowFiles(row).includes(files[0]!)),
    "measured singleton job",
  );
  expect(rowFiles(packedKnown).toSorted()).toEqual(files.slice(0, 2));
  expect(packedKnown).toMatchObject({ predictedSeconds: 509, planConcurrency: 1 });
  clear();
  weights.mockReturnValue(10);
  measure(
    files.toReversed().map((file) => [file]),
    files.map(() => 100),
  );
  prices[parentKey] = 1200;
  const allKnown = releaseRows();
  expect(allKnown.every((row) => row.predictedSeconds! <= 720)).toBe(true);
  expect(totalSeconds(allKnown)).toBeGreaterThanOrEqual(1200);
  price(allKnown, 500);
  expect(releaseRows().every((row) => row.predictedSeconds === 500)).toBe(true);
  clear();
  const oldStripes = [files.slice(0, 2), ...files.slice(2).map((file) => [file])];
  measure(
    oldStripes,
    oldStripes.map((_, index) => (index === 1 ? 2000 : 10)),
  );
  expect(releaseRows).toThrow("indivisible test above the hosted budget");
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
      .flatMap((group) => {
        const { configs, env, pretestBuildMode, requiresDist, runner } = group;
        const workerKey = "OPENCLAW_VITEST_MAX_WORKERS";
        const workers = String(Math.min(2, Number(env?.[workerKey] ?? 2)));
        const sortedEnv = Object.entries({ ...env, [workerKey]: workers }).toSorted(
          ([left], [right]) => left.localeCompare(right),
        );
        const files = group.includePatterns ??
          listWholeConfigSplitFiles(group.shard_name) ?? ["whole-config"];
        return files.map((file) =>
          JSON.stringify([configs, sortedEnv, pretestBuildMode, requiresDist, runner, file]),
        );
      })
      .toSorted();
  expect(contracts(rows)).toEqual(contracts(before));
  const split = rows.filter((row) =>
    groupsOf([row]).some((group) => /-hosted-\d+$/u.test(group.shard_name)),
  );
  expect(split.length).toBeGreaterThan(0);
  for (const row of split) {
    expect(row.predictedSeconds).toBeLessThanOrEqual(720);
    expect(row.timeoutMinutes).not.toBe(90);
    for (const group of groupsOf([row]).filter((entry) => /-hosted-\d+$/u.test(entry.shard_name))) {
      expect(group.includePatterns!.length).toBeLessThanOrEqual(64);
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
