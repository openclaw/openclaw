// Vitest ui config wires the ui test shard.
import type { ViteUserConfig } from "vitest/config";
import { controlUiLocaleModulesPlugin } from "../../ui/config/control-ui-locales.ts";
import { nonBrowserTestBasenamePattern } from "./vitest.include-patterns.ts";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";
import { jsdomOptimizedDeps } from "./vitest.shared.config.ts";
import { uiIsolatedTestFiles } from "./vitest.ui-isolated-paths.mjs";
import {
  controlUiE2eTestGlobs,
  controlUiTestGlobs,
  uiNodeDrivenBrowserTestFiles,
  uiTimingTestFiles,
} from "./vitest.ui-paths.mjs";

// Explicit nameable return type: inference reaches vite-internal names (TS4058/TS4082).
export function createUiVitestConfig(env?: Record<string, string | undefined>): ViteUserConfig {
  const includePatterns = [
    ...new Set(
      controlUiTestGlobs.map((pattern) =>
        pattern.replace(/\*\.test\.tsx?$/u, nonBrowserTestBasenamePattern),
      ),
    ),
    ...uiNodeDrivenBrowserTestFiles,
  ];
  // Isolated files must never enter the shared module graph, including scoped runs.
  const exclude = [...controlUiE2eTestGlobs, ...uiIsolatedTestFiles, ...uiTimingTestFiles];
  const config = createScopedVitestConfig(includePatterns, {
    deps: jsdomOptimizedDeps,
    environment: "jsdom",
    env,
    exclude,
    excludeUnitFastTests: false,
    includeOpenClawRuntimeSetup: false,
    intersectIncludeFile: true,
    isolate: false,
    name: "ui",
    setupFiles: ["ui/src/test-helpers/lit-warnings.setup.ts"],
    // Web Awesome otherwise stays on Node's loader and imports a second native Lit
    // beside the optimized lit/** graph. The UI package runner must not opt in:
    // it already prebundles these components.
    serverDepsInline: ["@awesome.me/webawesome"],
    useNonIsolatedRunner: true,
  });
  return {
    ...config,
    plugins: [...(config.plugins ?? []), controlUiLocaleModulesPlugin()],
  };
}

export default createUiVitestConfig();
