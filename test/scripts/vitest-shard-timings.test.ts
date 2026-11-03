import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  createCompactSplitTimingGeneration,
  resolveShardTimingKey,
  type VitestShardTimingSpec,
} from "../../scripts/lib/vitest-shard-metadata.mts";
import {
  createShardTimingSample,
  readShardTimings,
  writeShardTimings,
} from "../../scripts/lib/vitest-shard-timings.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const config = "unit.config.ts";
function fixture(shardName = "") {
  const cwd = tempDirs.make("openclaw-shard-timings-");
  const filename = path.join(cwd, "timings.json");
  const env = {
    OPENCLAW_TEST_PROJECTS_TIMINGS_PATH: filename,
    OPENCLAW_VITEST_SHARD_NAME: shardName,
  };
  const spec = { config, env, includePatterns: null };
  return {
    spec,
    sample: (ms: number, selection: Partial<VitestShardTimingSpec>) =>
      createShardTimingSample({ ...spec, ...selection }, ms)!,
    write: (...samples: Parameters<typeof writeShardTimings>[0]) =>
      writeShardTimings(samples, cwd, env),
    read: () => readShardTimings(cwd, env),
    persisted: () => JSON.parse(fs.readFileSync(filename, "utf8")).configs,
  };
}

it("identifies conflicting file ownership across stripes", () => {
  expect(() =>
    createCompactSplitTimingGeneration({
      configs: ["infra.config.ts"],
      parentShardName: "parent",
      stripes: [["a.test.ts"], ["a.test.ts"]],
    }),
  ).toThrow("duplicate test ownership");
});

it("uses the config path as the timing key for whole-config runs", () => {
  expect(resolveShardTimingKey({ config, env: {}, includePatterns: null })).toBe(config);
});

it("reuses timing history for reordered selections", () => {
  const f = fixture();
  const includePatterns = Object.freeze(["src/ä.test.ts", "src/z.test.ts", "src/A.test.ts"]);
  const sample = f.sample(1000, { includePatterns });
  f.write(sample);
  f.write(f.sample(2000, { includePatterns: includePatterns.toReversed() }));
  expect(f.read()).toEqual(new Map([[sample.config, 1300]]));
  expect(f.persisted()[sample.config].sampleCount).toBe(2);
  expect(
    resolveShardTimingKey({ ...f.spec, includePatterns: [...includePatterns, "src/c.test.ts"] }),
  ).not.toBe(sample.config);
});

it("persists include-pattern timing metadata", () => {
  const f = fixture("selected");
  const sample = f.sample(1234, { includePatterns: ["a.test.ts"], watchMode: false });
  const selectedConfig = `${config}#selected`;
  f.write(sample);
  expect(f.read()).toEqual(new Map([[selectedConfig, 1234]]));
});
