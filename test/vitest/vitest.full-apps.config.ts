import { createProjectShardVitestConfig } from "./vitest.full-shard.config.ts";
import { fullSuiteVitestShards } from "./vitest.test-shards.mjs";

export default createProjectShardVitestConfig(
  fullSuiteVitestShards.find((shard) => shard.name === "apps")?.projects ?? [],
);
