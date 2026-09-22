// Vitest infra config wires the infra test shard.
import { databaseWorkerCoreTestFiles } from "./vitest.database-worker-core-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";
import { boundaryTestFiles } from "./vitest.unit-paths.mjs";

export function createInfraVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(["src/infra/**/*.test.ts", ...databaseWorkerCoreTestFiles], {
    env,
    exclude: boundaryTestFiles,
    fileParallelism: false,
    isolate: true,
    name: "infra",
    passWithNoTests: true,
    pool: "forks",
  });
}

export default createInfraVitestConfig();
