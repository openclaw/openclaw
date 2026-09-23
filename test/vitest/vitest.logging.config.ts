// Vitest logging config wires the logging test shard.
import { databaseWorkerCoreTestFiles } from "./vitest.database-worker-core-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createLoggingVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(["src/logging/**/*.test.ts"], {
    dir: "src",
    exclude: databaseWorkerCoreTestFiles,
    env,
    name: "logging",
    passWithNoTests: true,
  });
}

export default createLoggingVitestConfig();
