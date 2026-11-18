// Vitest full core unit security config wires the full core unit security test shard.
import { createProjectShardVitestConfig } from "./vitest.project-shard-config.ts";

export default createProjectShardVitestConfig(
  "test/vitest/vitest.full-core-unit-security.config.ts",
);
