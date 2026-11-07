import { expect, it } from "vitest";
import {
  createChangedExtensionConfigShards,
  packChangedExtensionConfigShards,
} from "../../scripts/lib/ci-extension-test-shards.mts";
import { listExtensionTestFilesForRoots } from "../../scripts/lib/extension-test-plan.mts";
import { listVitestRuntimeConsumerFiles } from "../../scripts/lib/vitest-build-prerequisites.mts";
import { VITEST_PRETEST_BUILD_SECONDS } from "../../scripts/lib/vitest-shard-metadata.mts";
import { isSharedVitestExcludedPath } from "../vitest/vitest.pattern-file.ts";

type Shard = Parameters<typeof packChangedExtensionConfigShards>[0][number];
const preparation = VITEST_PRETEST_BUILD_SECONDS.runtime;
function makeShard(name: string, seconds: number): Shard {
  return {
    checkName: name,
    shardName: name,
    configs: [name],
    includePatterns: [`${name}.test.ts`],
    env: { OPENCLAW_NODE_TEST_VITEST_ARGS_JSON: JSON.stringify([`--${name}`]) },
    pretestBuildMode: "runtime",
    predictedSeconds: preparation + seconds,
    predictedTestSeconds: seconds,
    runner: "blacksmith-8vcpu-ubuntu-2404",
    requiresDist: false,
    planConcurrency: 1,
  };
}
const groups = (shards: ReturnType<typeof packChangedExtensionConfigShards>) =>
  shards.flatMap((shard) => shard.groups ?? [{ ...shard, shard_name: shard.shardName }]);

it.each<[string, Partial<Shard>, number]>([
  ["exact time bound", { predictedSeconds: 282, predictedTestSeconds: 222 }, 1],
  ["over time bound", { predictedSeconds: 283, predictedTestSeconds: 223 }, 2],
  ["unprepared reader", { pretestBuildMode: undefined, predictedSeconds: 8 }, 2],
  ["different preparation", { pretestBuildMode: "private-qa" }, 2],
  ["different runner", { runner: "ubuntu-24.04" }, 2],
  ["different dist requirement", { requiresDist: true }, 2],
])("packs only compatible envelopes: %s", (_name, overrides, count) => {
  const inputs = [makeShard("first", 18), { ...makeShard("second", 8), ...overrides }];
  const packed = packChangedExtensionConfigShards(inputs);
  expect(packed).toHaveLength(count);
  if (count === 2) {
    expect(packed).toEqual(inputs);
  } else {
    expect(packed[0]).toMatchObject({
      predictedSeconds: 300,
      pretestBuildMode: "runtime",
      planConcurrency: 1,
    });
    expect(groups(packed).toSorted((a, b) => a.shard_name.localeCompare(b.shard_name))).toEqual(
      inputs.map(
        ({ configs, includePatterns, env, pretestBuildMode, requiresDist, runner, shardName }) => ({
          configs,
          includePatterns,
          env,
          pretestBuildMode,
          requiresDist,
          runner,
          shard_name: shardName,
        }),
      ),
    );
  }
});

it("keeps selected Telegram scopes and runtime preparation in bounded serial jobs", () => {
  const files = listExtensionTestFilesForRoots(["extensions/telegram"]).filter(
    (file) => !isSharedVitestExcludedPath(file, "extensions"),
  );
  const packed = packChangedExtensionConfigShards(
    createChangedExtensionConfigShards(["extensions/telegram"], { targets: new Set(files) }),
  );
  const runtime = new Set(
    listVitestRuntimeConsumerFiles([...new Set(groups(packed).flatMap((group) => group.configs))]),
  );
  expect(packed.length).toBeLessThan(groups(packed).length);
  expect(
    groups(packed)
      .flatMap((group) => group.includePatterns ?? [])
      .toSorted(),
  ).toEqual(files.toSorted());
  for (const job of packed) {
    const envelopes = groups([job]);
    const needsRuntime = envelopes.some((group) =>
      group.includePatterns?.some((file) => runtime.has(file)),
    );
    expect(job.planConcurrency).toBe(1);
    expect(job.pretestBuildMode).toBe(needsRuntime ? "runtime" : undefined);
    expect(job.predictedSeconds).toBeLessThanOrEqual(300);
    for (const group of envelopes) {
      expect(group.pretestBuildMode).toBe(job.pretestBuildMode);
      expect(group.includePatterns!.length).toBeGreaterThan(0);
      expect(group.includePatterns!.length).toBeLessThanOrEqual(10);
    }
  }
});
