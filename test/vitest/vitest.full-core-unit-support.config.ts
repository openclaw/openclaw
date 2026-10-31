// Vitest full core unit support config wires the full core unit support test shard.
import { createProjectShardVitestConfig } from "./vitest.project-shard-config.ts";

export default createProjectShardVitestConfig(
  "test/vitest/vitest.full-core-unit-support.config.ts",
);
