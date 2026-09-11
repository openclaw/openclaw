import { teamReportsExtensionTestRoots } from "./vitest.extension-team-reports-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";
import { pluginControlUiPathGlob } from "./vitest.ui-paths.mjs";

export function createExtensionTeamReportsVitestConfig(
  env: Record<string, string | undefined> = process.env,
) {
  return createScopedVitestConfig(
    teamReportsExtensionTestRoots.map((root) => `${root}/**/*.test.ts`),
    {
      dir: "extensions",
      env,
      name: "extension-team-reports",
      // The database broker runs in the application main thread and owns its SQLite workers.
      pool: "forks",
      isolate: true,
      passWithNoTests: true,
      setupFiles: ["test/setup.extensions.ts"],
      exclude: [pluginControlUiPathGlob],
    },
  );
}

export default createExtensionTeamReportsVitestConfig();
