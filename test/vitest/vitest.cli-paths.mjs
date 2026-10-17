import { cliProcessTestFiles } from "./vitest.cli-process-paths.mjs";
import { databaseWorkerCoreTestFiles } from "./vitest.database-worker-core-paths.mjs";
import { toolingIsolatedTestFiles } from "./vitest.tooling-isolated-paths.mjs";

export function getCliVitestProjectOwner() {
  return {
    root: "src/cli",
    include: ["src/cli/**/*.test.ts"],
    exclude: [...cliProcessTestFiles, ...databaseWorkerCoreTestFiles, ...toolingIsolatedTestFiles],
  };
}
