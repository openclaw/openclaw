// Vitest plugin sdk config wires the plugin sdk test shard.
import { databaseWorkerCoreTestFiles } from "./vitest.database-worker-core-paths.mjs";
import { pluginSdkLightTestFiles } from "./vitest.plugin-sdk-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";
import { bundledPluginDependentUnitTestFiles } from "./vitest.unit-paths.mjs";

export function createPluginSdkVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(["src/plugin-sdk/**/*.test.ts"], {
    dir: "src",
    env,
    exclude: [
      ...pluginSdkLightTestFiles,
      ...bundledPluginDependentUnitTestFiles,
      ...databaseWorkerCoreTestFiles,
    ],
    name: "plugin-sdk",
    passWithNoTests: true,
  });
}

export default createPluginSdkVitestConfig();
