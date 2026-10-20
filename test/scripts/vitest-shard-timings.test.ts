import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCompactSplitTimingGeneration,
  resolveShardTimingKey,
} from "../../scripts/lib/vitest-shard-metadata.mts";
import {
  createShardTimingSample,
  readShardTimings,
  writeShardTimings,
} from "../../scripts/lib/vitest-shard-timings.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const unitConfig = "test/vitest/vitest.unit-fast.config.ts";
function fixture(shardName?: string) {
  const tempDir = tempDirs.make("openclaw-shard-timings-");
  const env = {
    OPENCLAW_TEST_PROJECTS_TIMINGS_PATH: path.join(tempDir, "timings.json"),
    ...(shardName ? { OPENCLAW_VITEST_SHARD_NAME: shardName } : {}),
  };
  return {
    tempDir,
    env,
    persisted: () =>
      JSON.parse(fs.readFileSync(env.OPENCLAW_TEST_PROJECTS_TIMINGS_PATH, "utf8")).configs,
  };
}

describe("scripts/lib/vitest-shard-timings.mts", () => {
  it("identifies conflicting file ownership across stripes", () => {
    expect(() =>
      createCompactSplitTimingGeneration({
        configs: ["test/vitest/vitest.infra.config.ts"],
        parentShardName: "changed-core-runtime-infra-storage-state",
        stripes: [["a.test.ts"], ["a.test.ts"]],
      }),
    ).toThrow(
      "duplicate test ownership for a.test.ts in changed-core-runtime-infra-storage-state " +
        "(configs: test/vitest/vitest.infra.config.ts; stripes: 1 and 2)",
    );
  });

  it("uses the config path as the timing key for whole-config runs", () => {
    expect(
      resolveShardTimingKey({
        config: unitConfig,
        env: {},
        includePatterns: null,
      }),
    ).toBe(unitConfig);
  });

  it("keeps expanded chunk samples separate under one inherited shard name", () => {
    const { tempDir, env } = fixture("same-parent");
    const config = "test/vitest/vitest.tooling.config.ts";
    const first = { config, env, includePatterns: null, timingTargets: ["src/a.test.ts"] };
    const second = { ...first, timingTargets: ["src/b.test.ts"] };
    const firstKey = resolveShardTimingKey(first);
    const secondKey = resolveShardTimingKey(second);
    expect(firstKey).not.toBe(config);
    expect(firstKey).not.toBe(secondKey);
    const firstSample = createShardTimingSample(first, 1000)!;
    const secondSample = createShardTimingSample(second, 3000)!;
    expect(firstSample.includePatternCount).toBe(1);
    expect(secondSample.includePatternCount).toBe(1);

    writeShardTimings([firstSample, secondSample], tempDir, env);

    expect(readShardTimings(tempDir, env)).toEqual(
      new Map([
        [firstKey, 1000],
        [secondKey, 3000],
      ]),
    );
  });

  it("reuses timing history for reordered selections", () => {
    const { tempDir, env, persisted } = fixture();
    const config = unitConfig;
    const includePatterns = Object.freeze(["src/ä.test.ts", "src/z.test.ts", "src/A.test.ts"]);
    const sample = createShardTimingSample({ config, env, includePatterns }, 1000)!;
    writeShardTimings([sample], tempDir, env);
    const reordered = createShardTimingSample(
      { config, env, includePatterns: includePatterns.toReversed() },
      2000,
    )!;
    writeShardTimings([reordered], tempDir, env);

    expect(readShardTimings(tempDir, env)).toEqual(new Map([[sample.config, 1300]]));
    expect(persisted()[sample.config].sampleCount).toBe(2);
    expect(
      resolveShardTimingKey({
        config,
        env,
        includePatterns: [...includePatterns, "src/c.test.ts"],
      }),
    ).not.toBe(sample.config);
  });

  it("persists include-pattern timing metadata", () => {
    const { tempDir, env, persisted } = fixture("auto-reply-reply-agent-runner");
    const baseConfig = "test/vitest/vitest.auto-reply-reply.config.ts";
    const config = `${baseConfig}#auto-reply-reply-agent-runner`;
    const sample = createShardTimingSample(
      {
        config: baseConfig,
        env,
        includePatterns: ["src/auto-reply/reply/agent-runner.test.ts"],
        watchMode: false,
      },
      1234,
    );

    expect(sample).toEqual({
      baseConfig,
      config,
      durationMs: 1234,
      includePatternCount: 1,
    });

    writeShardTimings([sample], tempDir, env);

    expect(readShardTimings(tempDir, env)).toEqual(new Map([[config, 1234]]));
    const persistedTiming = persisted()[config];
    expect(typeof persistedTiming.updatedAt).toBe("string");
    expect(persistedTiming.updatedAt.length).toBeGreaterThan(0);
    expect({ ...persistedTiming, updatedAt: "<dynamic>" }).toStrictEqual({
      averageMs: 1234,
      baseConfig,
      includePatternCount: 1,
      lastMs: 1234,
      sampleCount: 1,
      updatedAt: "<dynamic>",
    });
  });
});
