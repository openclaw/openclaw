// Vitest unit fast config wires the unit fast test shard.
import path from "node:path";
import { defineConfig } from "vitest/config";
import {
  createScopedVitestPatternPlugin,
  withoutVitestPatternFields,
} from "./vitest.scoped-patterns.ts";
import { resolveRepoRootPath, sharedVitestConfig } from "./vitest.shared.config.ts";
import {
  getUnitFastIsolatedTestFiles,
  getUnitFastTestFiles,
  getUnitFastTimerTestFiles,
} from "./vitest.unit-fast-paths.mjs";
import { unitTestIncludePatterns } from "./vitest.unit-paths.mjs";

export function createUnitFastVitestConfig(
  env: Record<string, string | undefined> = process.env,
  options: { argv?: string[]; runner?: string } = {},
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
          selectOwnedInclude: (discoveryPatterns, root) => {
            const timerTestFiles = new Set(getUnitFastTimerTestFiles(discoveryPatterns, root));
            const isolatedTestFiles = new Set(
              getUnitFastIsolatedTestFiles(discoveryPatterns, root),
            );
            return getUnitFastTestFiles(discoveryPatterns, root).filter(
              (file) => !timerTestFiles.has(file) && !isolatedTestFiles.has(file),
            );
          },
        },
        sharedTest.exclude ?? [],
      ),
    ],
    // Keep the pilot's native dependency history private to this invocation.
    ...(env.OPENCLAW_VITEST_OBSERVATION_DIR
      ? { cacheDir: path.join(env.OPENCLAW_VITEST_OBSERVATION_DIR, "vite") }
      : {}),
    test: {
      ...withoutVitestPatternFields(sharedTest),
      name: "unit-fast",
      isolate: false,
      runner: options.runner,
      // Env isolation only (no shared-setup mocks): membership is auto-curated,
      // so tests must never read the developer's real config/state.
      setupFiles: [resolveRepoRootPath("test/setup.env.ts")],
      passWithNoTests: true,
    },
  });
}

export default createUnitFastVitestConfig();
