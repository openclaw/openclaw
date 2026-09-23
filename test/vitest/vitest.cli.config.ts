import { cliProcessTestFiles } from "./vitest.cli-process-paths.mjs";
import { databaseWorkerCoreTestFiles } from "./vitest.database-worker-core-paths.mjs";
// Vitest cli config wires the cli test shard.
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";
import { toolingIsolatedTestFiles } from "./vitest.tooling-isolated-paths.mjs";

export function createCliVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(["src/cli/**/*.test.ts"], {
    dir: "src/cli",
    env,
    exclude: [...cliProcessTestFiles, ...databaseWorkerCoreTestFiles, ...toolingIsolatedTestFiles],
    name: "cli",
    passWithNoTests: true,
  });
}

export default createCliVitestConfig();
