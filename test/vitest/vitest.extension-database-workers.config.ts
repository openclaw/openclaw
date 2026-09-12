import { databaseWorkerExtensionTestRoots } from "./vitest.extension-database-workers-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";
import { pluginControlUiPathGlob } from "./vitest.ui-paths.mjs";

export function createExtensionDatabaseWorkersVitestConfig(
  env: Record<string, string | undefined> = process.env,
) {
  return createScopedVitestConfig(
    databaseWorkerExtensionTestRoots.map((root) => `${root}/**/*.test.ts`),
    {
      dir: "extensions",
      env,
      name: "extension-database-workers",
      // The database broker runs in the application main thread and owns its SQLite workers.
      pool: "forks",
      isolate: true,
      passWithNoTests: true,
      setupFiles: ["test/setup.extensions.ts"],
      exclude: [pluginControlUiPathGlob],
    },
  );
}

export default createExtensionDatabaseWorkersVitestConfig();
