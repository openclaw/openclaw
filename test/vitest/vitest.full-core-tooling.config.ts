// Vitest full core tooling config wires the full core tooling test shard.
import { createProjectShardVitestConfig } from "./vitest.project-shard-config.ts";

export default createProjectShardVitestConfig(
  "test/vitest/vitest.full-core-tooling.config.ts",
  // Keep only one large tooling project graph resident in the full-suite process.
  { maxWorkers: 1 },
);
