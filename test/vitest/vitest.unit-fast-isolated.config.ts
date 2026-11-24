// Vitest unit fast isolated config wires audited stateful tests out of shared module caches.
import { defineConfig } from "vitest/config";
import {
  createScopedVitestPatternPlugin,
  withoutVitestPatternFields,
} from "./vitest.scoped-patterns.ts";
import { resolveRepoRootPath, sharedVitestConfig } from "./vitest.shared.config.ts";
import { getUnitFastIsolatedTestFiles } from "./vitest.unit-fast-paths.mjs";
import { unitTestIncludePatterns } from "./vitest.unit-paths.mjs";

export function createUnitFastIsolatedVitestConfig(
  env: Record<string, string | undefined> = process.env,
  options: { argv?: string[] } = {},
) {
  const sharedTest = sharedVitestConfig.test ?? {};
  return defineConfig({
    ...sharedVitestConfig,
    plugins: [
      ...sharedVitestConfig.plugins,
      createScopedVitestPatternPlugin(
        unitTestIncludePatterns,
        {
          env,
          argv: options.argv,
          intersectIncludeFile: true,
          excludeUnitFastTests: false,
          selectOwnedInclude: getUnitFastIsolatedTestFiles,
        },
        sharedTest.exclude ?? [],
      ),
    ],
    test: {
      ...withoutVitestPatternFields(sharedTest),
      name: "unit-fast-isolated",
      // Forced stateful tests can mock modules imported by later files, so each gets a fresh graph.
      isolate: true,
      runner: undefined,
      setupFiles: [resolveRepoRootPath("test/setup.env.ts")],
      passWithNoTests: true,
    },
  });
}

export default createUnitFastIsolatedVitestConfig();
