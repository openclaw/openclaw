// Vitest plugins config wires the plugins test shard.
import { defineConfig } from "vitest/config";
import { databaseWorkerCoreTestFiles } from "./vitest.database-worker-core-paths.mjs";
import { relativizeScopedPatterns } from "./vitest.pattern-file.ts";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

// These suites exercise the plugin loader's own native require()/import()
// semantics on fixture packages. The shared tsx/esm worker preload rewrites
// .ts and ambiguous .js loading in-process and would replace the runtime under
// test, so they run in Node workers without it.
export const nativeLoaderPluginTestFiles = [
  "src/plugins/bundled-plugin-metadata.public-surfaces.test.ts",
  "src/plugins/capability-provider-runtime.generation.test.ts",
  "src/plugins/manifest-registry.test.ts",
  "src/plugins/plugin-module-generation.interop.test.ts",
  "src/plugins/plugin-module-generation.test.ts",
  "src/plugins/plugin-runtime-artifact-resolution.test.ts",
  "src/plugins/public-surface-loader.test.ts",
  "src/plugins/stage-bundled-plugin-runtime.test.ts",
];

export function createPluginsVitestConfig(env?: Record<string, string | undefined>) {
  const options = {
    dir: "src/plugins",
    env,
    exclude: [
      "src/plugins/contracts/**",
      "src/plugins/loader.test.ts",
      ...databaseWorkerCoreTestFiles,
    ],
    isolate: true,
    // Runtime ingress uses the application main-thread SQLite worker broker.
    pool: "forks" as const,
    passWithNoTests: true,
  };
  const config = createScopedVitestConfig(["src/plugins/**/*.test.ts"], {
    ...options,
    name: "plugins",
  });
  const nativeLoader = createScopedVitestConfig(nativeLoaderPluginTestFiles, {
    ...options,
    execArgv: [],
    intersectIncludeFile: true,
    name: "plugins-native-loader",
  });
  return defineConfig({
    ...config,
    test: {
      ...config.test,
      // Config discovery retains the complete inventory; only the inline leaves run.
      projects: [
        {
          ...config,
          extends: false,
          test: {
            ...config.test,
            exclude: [
              ...(config.test?.exclude ?? []),
              ...relativizeScopedPatterns(nativeLoaderPluginTestFiles, options.dir),
            ],
          },
        },
        { ...nativeLoader, extends: false },
      ],
    },
  });
}

export default createPluginsVitestConfig();
