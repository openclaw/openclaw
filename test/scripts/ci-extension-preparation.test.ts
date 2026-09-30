import { readFileSync } from "node:fs";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { resolveShardPlans, runShardPlans } from "../../scripts/ci-run-node-test-shard.mts";
import { createChangedExtensionFallbackShards } from "../../scripts/lib/ci-changed-node-test-plan.mts";
import { packChangedExtensionConfigShards } from "../../scripts/lib/ci-extension-test-shards.mts";
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

function fallbackGroups(shards: ReturnType<typeof createChangedExtensionFallbackShards>) {
  return shards.flatMap((shard) => shard.groups ?? [{ ...shard, shard_name: shard.shardName }]);
}

function listExecutableExtensionFiles(roots: string[]) {
  return listExtensionTestFilesForRoots(roots).filter(
    (file) => !isSharedVitestExcludedPath(file, "extensions"),
  );
}

const cases: Array<{
  name: string;
  second: Partial<ExtensionShard>;
  jobs: number;
  seconds?: number;
}> = [
  { name: "same preparation", second: {}, jobs: 1, seconds: runtimePreparationSeconds + 26 },
  {
    name: "exact time bound",
    second: { predictedSeconds: 282, predictedTestSeconds: 222 },
    jobs: 1,
    seconds: 300,
  },
  {
    name: "over time bound",
    second: { predictedSeconds: 283, predictedTestSeconds: 223 },
    jobs: 2,
  },
  {
    name: "unprepared reader",
    second: { pretestBuildMode: undefined, predictedSeconds: 8 },
    jobs: 2,
  },
  {
    name: "different preparation",
    second: {
      pretestBuildMode: "private-qa",
      predictedSeconds: VITEST_PRETEST_BUILD_SECONDS["private-qa"] + 8,
    },
    jobs: 2,
  },
  { name: "different runner", second: { runner: "ubuntu-24.04" }, jobs: 2 },
  { name: "different dist requirement", second: { requiresDist: true }, jobs: 2 },
];

describe("extension preparation packing", () => {
  it.each(cases)("preserves process ownership for $name", async ({ second, jobs, seconds }) => {
    const inputs: ExtensionShard[] = [
      {
        checkName: "first",
        shardName: "first",
        configs: ["test/vitest/vitest.extension-database-workers.config.ts"],
        includePatterns: ["extensions/codex/src/app-server/settled-turn-finalizer.native.test.ts"],
        env: { OPENCLAW_NODE_TEST_VITEST_ARGS_JSON: '["--isolate"]' },
        pretestBuildMode: "runtime",
        predictedSeconds: runtimePreparationSeconds + 18,
        predictedTestSeconds: 18,
        runner: "blacksmith-8vcpu-ubuntu-2404",
        requiresDist: false,
        planConcurrency: 1,
      },
      {
        checkName: "second",
        shardName: "second",
        configs: ["test/vitest/vitest.extension-telegram.config.ts"],
        includePatterns: ["extensions/telegram/src/sticker-cache.selection.test.ts"],
        env: { OPENCLAW_NODE_TEST_VITEST_ARGS_JSON: '["--fileParallelism=false"]' },
        pretestBuildMode: "runtime",
        predictedSeconds: runtimePreparationSeconds + 8,
        predictedTestSeconds: 8,
        runner: "blacksmith-8vcpu-ubuntu-2404",
        requiresDist: false,
        planConcurrency: 1,
        ...second,
      },
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
    const calls: Array<{ args: string[]; files: unknown }> = [];
    expect(
      await runShardPlans(resolveShardPlans(env), {
        env,
        scratchDir: tempDirs.make("extension-preparation-"),
        runChild: async (args, childEnv) => {
          active++;
          peak = Math.max(peak, active);
          calls.push({
            args,
            files: JSON.parse(
              readFileSync(
                expectDefined(childEnv.OPENCLAW_VITEST_INCLUDE_FILE, "include file"),
                "utf8",
              ),
            ),
          });
          expect(childEnv.OPENCLAW_VITEST_MAX_WORKERS).toBe("2");
          await Promise.resolve();
          active--;
          return 0;
        },
      }),
    ).toBe(0);
    expect(peak).toBe(1);
    expect(calls).toHaveLength(2);
    expect(calls).toEqual(
      expect.arrayContaining([
        {
          args: ["test/vitest/vitest.extension-database-workers.config.ts", "--", "--isolate"],
          files: ["extensions/codex/src/app-server/settled-turn-finalizer.native.test.ts"],
        },
        {
          args: [
            "test/vitest/vitest.extension-telegram.config.ts",
            "--",
            "--fileParallelism=false",
          ],
          files: ["extensions/telegram/src/sticker-cache.selection.test.ts"],
        },
      ]),
    );
  });

  it("packs separate Telegram envelopes into serial fallback jobs without merging file scopes", () => {
    const result = createChangedExtensionFallbackShards(["extensions/telegram/src/channel.ts"]);
    expect(result).not.toBeNull();
    const shards = result ?? [];
    const groups = fallbackGroups(shards);
    const targets = groups.flatMap((group) => group.includePatterns ?? []);

    expect(shards.length).toBeLessThan(groups.length);
    expect(shards.every((shard) => shard.planConcurrency === 1)).toBe(true);
    expect(shards.every((shard) => shard.predictedSeconds! <= 300)).toBe(true);
    expect(
      groups.every(
        (group) =>
          group.configs[0] ===
            (group.includePatterns?.every((file) => databaseWorkerExtensionTestFiles.includes(file))
              ? "test/vitest/vitest.extension-database-workers.config.ts"
              : "test/vitest/vitest.extension-telegram.config.ts") &&
          (group.includePatterns?.length ?? 0) > 0 &&
          (group.includePatterns?.length ?? 0) <= 10,
      ),
    ).toBe(true);
    expect(targets.toSorted()).toEqual(
      listExecutableExtensionFiles(["extensions/telegram"]).toSorted(),
    );
    const runtimeFiles = new Set(
      listVitestRuntimeConsumerFiles([
        "test/vitest/vitest.extension-telegram.config.ts",
        "test/vitest/vitest.extension-database-workers.config.ts",
      ]),
    );
    const preparedConsumers: string[] = [];
    for (const shard of shards) {
      const consumers = fallbackGroups([shard])
        .flatMap((group) => group.includePatterns ?? [])
        .filter((file) => runtimeFiles.has(file));
      expect(Boolean(shard.pretestBuildMode)).toBe(consumers.length > 0);
      if (consumers.length > 0) {
        expect(shard.pretestBuildMode).toBe("runtime");
        expect(fallbackGroups([shard]).every((group) => group.pretestBuildMode === "runtime")).toBe(
          true,
        );
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
});
