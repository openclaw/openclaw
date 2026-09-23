// Vitest process config wires the process test shard.
import type { ViteUserConfig } from "vitest/config";
import { databaseWorkerCoreTestFiles } from "./vitest.database-worker-core-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createProcessVitestConfig(
  env?: Record<string, string | undefined>,
): ViteUserConfig {
  const config = createScopedVitestConfig(["src/process/**/*.test.ts"], {
    dir: "src",
    env,
    exclude: databaseWorkerCoreTestFiles,
    includeOpenClawRuntimeSetup: false,
    name: "process",
    passWithNoTests: true,
  });
  return {
    ...config,
    test: {
      ...config.test,
      sequence: {
        ...config.test?.sequence,
        groupOrder: 2,
      },
    },
  };
}

export default createProcessVitestConfig();
