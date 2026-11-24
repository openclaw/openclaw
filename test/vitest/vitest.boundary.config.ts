// Vitest boundary config wires the boundary test shard.
import { defineProject, type TestProjectInlineConfiguration } from "vitest/config";
import {
  createScopedVitestPatternPlugin,
  withoutVitestPatternFields,
} from "./vitest.scoped-patterns.ts";
import { nonIsolatedRunnerPath, sharedVitestConfig } from "./vitest.shared.config.ts";
import { boundaryTestFiles } from "./vitest.unit-paths.mjs";

export function createBoundaryVitestConfig(
  env: Record<string, string | undefined> = process.env,
  argv: string[] = process.argv,
) {
  return defineProject({
    ...sharedVitestConfig,
    plugins: [
      ...sharedVitestConfig.plugins,
      createScopedVitestPatternPlugin(
        boundaryTestFiles,
        { env, argv, excludeUnitFastTests: false },
        sharedVitestConfig.test.exclude ?? [],
        (patterns, test) =>
          test.passWithNoTests === undefined && patterns.scopedCliInclude?.length === 0
            ? { passWithNoTests: true }
            : {},
      ),
    ],
    test: {
      ...withoutVitestPatternFields(sharedVitestConfig.test),
      name: "boundary",
      isolate: false,
      runner: nonIsolatedRunnerPath,
      // Boundary workers still need the shared isolated HOME/bootstrap. Only
      // per-file module isolation is disabled here.
      setupFiles: sharedVitestConfig.test.setupFiles,
    },
  } as TestProjectInlineConfiguration);
}

export default createBoundaryVitestConfig();
