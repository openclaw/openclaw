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
    isolate: true,
    name: "plugins",
    // Runtime ingress uses the application main-thread SQLite worker broker.
    pool: "forks",
    passWithNoTests: true,
  });
}

export default createPluginsVitestConfig();
