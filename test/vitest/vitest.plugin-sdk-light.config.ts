import { pluginSdkLightTestFiles } from "./vitest.plugin-sdk-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";
import { unitFastTestFiles } from "./vitest.unit-fast-paths.mjs";

export function createPluginSdkLightVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(pluginSdkLightTestFiles, {
    dir: "src",
    env,
    exclude: unitFastTestFiles,
    includeOpenClawRuntimeSetup: false,
    name: "plugin-sdk-light",
    passWithNoTests: true,
  });
}

export default createPluginSdkLightVitestConfig();
