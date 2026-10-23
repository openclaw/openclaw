// Vitest full core tooling config wires the full core tooling test shard.
import { createProjectShardVitestConfig } from "./vitest.project-shard-config.ts";
import { fullSuiteVitestShards } from "./vitest.test-shards.mjs";

export default createProjectShardVitestConfig(
  fullSuiteVitestShards.find(
    (shard) => shard.config === "test/vitest/vitest.full-core-tooling.config.ts",
  )?.projects ?? [],
  // Keep only one large tooling project graph resident in the full-suite process.
  { maxWorkers: 1 },
);
