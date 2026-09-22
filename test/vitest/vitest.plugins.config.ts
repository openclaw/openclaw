// Vitest plugins config wires the plugins test shard.
import { databaseWorkerCoreTestFiles } from "./vitest.database-worker-core-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createPluginsVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(["src/plugins/**/*.test.ts"], {
    dir: "src/plugins",
    env,
    exclude: [
      "src/plugins/contracts/**",
      "src/plugins/loader.test.ts",
      ...databaseWorkerCoreTestFiles,
    ],
    fileParallelism: false,
    isolate: false,
    name: "plugins",
    passWithNoTests: true,
  });
}

export default createPluginsVitestConfig();
