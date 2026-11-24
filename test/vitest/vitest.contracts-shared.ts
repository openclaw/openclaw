// Vitest contract shared helpers build contract test project configuration.
import { defineConfig } from "vitest/config";
import {
  channelConfigContractPatterns,
  channelRegistryContractPatterns,
  channelSessionContractPatterns,
  channelSurfaceContractPatterns,
  pluginContractPatterns,
} from "./vitest.contracts-paths.mjs";
import { databaseWorkerCoreTestFiles } from "./vitest.database-worker-core-paths.mjs";
import {
  createScopedVitestPatternPlugin,
  withoutVitestPatternFields,
} from "./vitest.scoped-patterns.ts";
import { nonIsolatedRunnerPath, sharedVitestConfig } from "./vitest.shared.config.ts";

export {
  channelConfigContractPatterns,
  channelRegistryContractPatterns,
  channelSessionContractPatterns,
  channelSurfaceContractPatterns,
  pluginContractPatterns,
};

const base = sharedVitestConfig as Record<string, unknown>;
const baseTest = sharedVitestConfig.test ?? {};

export function createContractsVitestConfig(
  includePatterns: string[],
  env: Record<string, string | undefined> = process.env,
  argv: string[] = process.argv,
  options: { name?: string; pool?: "forks" | "threads" } = {},
) {
  return defineConfig({
    ...base,
    plugins: [
      ...sharedVitestConfig.plugins,
      createScopedVitestPatternPlugin(
        includePatterns,
        {
          env,
          argv,
          intersectIncludeFile: true,
          excludeUnitFastTests: false,
          exclude: databaseWorkerCoreTestFiles,
        },
        baseTest.exclude ?? [],
      ),
    ],
    test: {
      ...withoutVitestPatternFields(baseTest),
      name: options.name ?? "contracts",
      pool: options.pool ?? baseTest.pool,
      isolate: false,
      runner: nonIsolatedRunnerPath,
      setupFiles: baseTest.setupFiles ?? [],
      passWithNoTests: true,
    },
  });
}
