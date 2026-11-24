// Vitest unit fast fake timers config wires the unit fast fake timers test shard.
import { defineConfig } from "vitest/config";
import {
  createScopedVitestPatternPlugin,
  withoutVitestPatternFields,
} from "./vitest.scoped-patterns.ts";
import {
  nonIsolatedRunnerPath,
  resolveRepoRootPath,
  sharedVitestConfig,
} from "./vitest.shared.config.ts";
import { getUnitFastTimerTestFiles } from "./vitest.unit-fast-paths.mjs";
import { unitTestIncludePatterns } from "./vitest.unit-paths.mjs";

export function createUnitFastFakeTimersVitestConfig(
  env: Record<string, string | undefined> = process.env,
  options: { argv?: string[] } = {},
) {
  const sharedTest = sharedVitestConfig.test ?? {};
  const sharedSequence = (sharedTest as { sequence?: { groupOrder?: number } }).sequence;
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
          selectOwnedInclude: getUnitFastTimerTestFiles,
        },
        sharedTest.exclude ?? [],
      ),
    ],
    test: {
      ...withoutVitestPatternFields(sharedTest),
      name: "unit-fast-fake-timers",
      isolate: false,
      runner: nonIsolatedRunnerPath,
      // Env isolation only (no shared-setup mocks), mirroring unit-fast.
      setupFiles: [resolveRepoRootPath("test/setup.env.ts")],
      maxWorkers: 1,
      fileParallelism: false,
      sequence: {
        ...sharedSequence,
        groupOrder: 1,
      },
      passWithNoTests: true,
    },
  });
}

export default createUnitFastFakeTimersVitestConfig();
