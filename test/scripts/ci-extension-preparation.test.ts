import { readFileSync } from "node:fs";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it } from "vitest";
import { resolveShardPlans, runShardPlans } from "../../scripts/ci-run-node-test-shard.mts";
import {
  createChangedExtensionConfigShards,
  packChangedExtensionConfigShards,
} from "../../scripts/lib/ci-extension-test-shards.mts";
import { encodeNodeTestGroups } from "../../scripts/lib/ci-node-test-groups-codec.mts";
import { listExtensionTestFilesForRoots } from "../../scripts/lib/extension-test-plan.mts";
import { listVitestRuntimeConsumerFiles } from "../../scripts/lib/vitest-build-prerequisites.mts";
import { VITEST_PRETEST_BUILD_SECONDS } from "../../scripts/lib/vitest-shard-metadata.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { databaseWorkerExtensionTestFiles } from "../vitest/vitest.extension-database-workers-paths.mjs";
import { isSharedVitestExcludedPath } from "../vitest/vitest.pattern-file.ts";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
type ExtensionShard = Parameters<typeof packChangedExtensionConfigShards>[0][number];
const runtimePreparationSeconds = VITEST_PRETEST_BUILD_SECONDS.runtime;
const configs = {
  database: "test/vitest/vitest.extension-database-workers.config.ts",
  telegram: "test/vitest/vitest.extension-telegram.config.ts",
};
const files = {
  database: "extensions/codex/src/app-server/settled-turn-finalizer.native.test.ts",
  telegram: "extensions/telegram/src/sticker-cache.selection.test.ts",
};
const preparedShard = (
  kind: keyof typeof configs,
  seconds: number,
  args: string[],
): ExtensionShard => ({
  checkName: kind,
  shardName: kind,
  configs: [configs[kind]],
  includePatterns: [files[kind]],
  env: { OPENCLAW_NODE_TEST_VITEST_ARGS_JSON: JSON.stringify(args) },
  pretestBuildMode: "runtime",
  predictedSeconds: runtimePreparationSeconds + seconds,
  predictedTestSeconds: seconds,
  runner: "blacksmith-8vcpu-ubuntu-2404",
  requiresDist: false,
  planConcurrency: 1,
});

function fallbackGroups(shards: ReturnType<typeof packChangedExtensionConfigShards>) {
  return shards.flatMap((shard) => shard.groups ?? [{ ...shard, shard_name: shard.shardName }]);
}

const cases: [string, Partial<ExtensionShard>, number, number?][] = [
  ["same preparation", {}, 1, runtimePreparationSeconds + 26],
  ["exact time bound", { predictedSeconds: 282, predictedTestSeconds: 222 }, 1, 300],
  ["over time bound", { predictedSeconds: 283, predictedTestSeconds: 223 }, 2],
  ["unprepared reader", { pretestBuildMode: undefined, predictedSeconds: 8 }, 2],
  [
    "different preparation",
    {
      pretestBuildMode: "private-qa",
      predictedSeconds: VITEST_PRETEST_BUILD_SECONDS["private-qa"] + 8,
    },
    2,
  ],
  ["different runner", { runner: "ubuntu-24.04" }, 2],
  ["different dist requirement", { requiresDist: true }, 2],
];

it.each(cases)("preserves process ownership for %s", async (_name, second, jobs, seconds) => {
  const inputs = [
    preparedShard("database", 18, ["--isolate"]),
    { ...preparedShard("telegram", 8, ["--fileParallelism=false"]), ...second },
  ];
  const packed = packChangedExtensionConfigShards(inputs);
  expect(packed).toHaveLength(jobs);
  expect(fallbackGroups(packed)).toHaveLength(inputs.length);
  expect(fallbackGroups(packed).map((group) => group.includePatterns)).toEqual(
    expect.arrayContaining(inputs.map((input) => input.includePatterns)),
  );
  if (jobs !== 1) {
    expect(packed).toEqual(inputs);
    return;
  }
  const job = expectDefined(packed[0], "prepared job");
  expect(job).toMatchObject({
    predictedSeconds: seconds,
    pretestBuildMode: "runtime",
    planConcurrency: 1,
  });
  expect(job.groups?.every((group) => group.pretestBuildMode === "runtime")).toBe(true);
  const env = {
    OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: encodeNodeTestGroups(job.groups ?? []),
    OPENCLAW_NODE_TEST_PLAN_CONCURRENCY: String(job.planConcurrency),
    OPENCLAW_VITEST_MAX_WORKERS: "2",
  };
  let active = 0;
  let peak = 0;
  const calls: [args: string[], files: unknown][] = [];
  const exitCode = await runShardPlans(resolveShardPlans(env), {
    env,
    scratchDir: tempDirs.make("extension-preparation-"),
    runChild: async (args, childEnv) => {
      active++;
      peak = Math.max(peak, active);
      const include = expectDefined(childEnv.OPENCLAW_VITEST_INCLUDE_FILE, "include file");
      calls.push([args, JSON.parse(readFileSync(include, "utf8"))]);
      expect(childEnv.OPENCLAW_VITEST_MAX_WORKERS).toBe("2");
      await Promise.resolve();
      active--;
      return 0;
    },
  });
  expect({ exitCode, peak }).toEqual({ exitCode: 0, peak: 1 });
  expect(calls.toSorted(([a], [b]) => a[0]!.localeCompare(b[0]!))).toEqual([
    [[configs.database, "--", "--isolate"], [files.database]],
    [[configs.telegram, "--", "--fileParallelism=false"], [files.telegram]],
  ]);
});

it("packs selected Telegram envelopes into serial jobs without merging file scopes", () => {
  const executable = listExtensionTestFilesForRoots(["extensions/telegram"]).filter(
    (file) => !isSharedVitestExcludedPath(file, "extensions"),
  );
  const shards = packChangedExtensionConfigShards(
    createChangedExtensionConfigShards(["extensions/telegram"], {
      targets: new Set(executable),
    }),
  );
  const groups = fallbackGroups(shards);
  const targets = groups.flatMap((group) => group.includePatterns ?? []);

  expect(shards.length).toBeLessThan(groups.length);
  expect(
    shards.every((shard) => shard.planConcurrency === 1 && shard.predictedSeconds! <= 300),
  ).toBe(true);
  for (const group of groups) {
    const patterns = group.includePatterns ?? [];
    const isDatabase = patterns.every((file) => databaseWorkerExtensionTestFiles.includes(file));
    expect(group.configs[0]).toBe(isDatabase ? configs.database : configs.telegram);
    expect(patterns.length).toBeGreaterThan(0);
    expect(patterns.length).toBeLessThanOrEqual(10);
  }
  expect(targets.toSorted()).toEqual(executable.toSorted());
  const runtimeFiles = new Set(listVitestRuntimeConsumerFiles(Object.values(configs)));
  const preparedConsumers: string[] = [];
  for (const shard of shards) {
    const shardGroups = fallbackGroups([shard]);
    const consumers = shardGroups
      .flatMap((group) => group.includePatterns ?? [])
      .filter((file) => runtimeFiles.has(file));
    expect(shard.pretestBuildMode).toBe(consumers.length > 0 ? "runtime" : undefined);
    if (consumers.length > 0) {
      expect(shardGroups.every((group) => group.pretestBuildMode === "runtime")).toBe(true);
      preparedConsumers.push(...consumers);
    }
  }
  expect(preparedConsumers.toSorted()).toEqual(
    targets.filter((file) => runtimeFiles.has(file)).toSorted(),
  );
  expect(preparedConsumers).toEqual(
    expect.arrayContaining([
      "extensions/telegram/src/polling-session.test.ts",
      "extensions/telegram/src/sticker-cache.selection.test.ts",
    ]),
  );
});
