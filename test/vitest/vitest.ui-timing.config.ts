// Root runs give wall-clock UI budgets their own scheduling group.
import type { ViteUserConfig } from "vitest/config";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";
import { jsdomOptimizedDeps } from "./vitest.shared.config.ts";
import uiIsolatedConfig from "./vitest.ui-isolated.config.ts";
import { uiTimingTestFiles } from "./vitest.ui-paths.mjs";
import uiConfig from "./vitest.ui.config.ts";

export function createUiTimingVitestConfig(
  env?: Record<string, string | undefined>,
): ViteUserConfig {
  const config = createScopedVitestConfig(uiTimingTestFiles, {
    deps: jsdomOptimizedDeps,
    environment: "jsdom",
    env,
    excludeUnitFastTests: false,
    includeOpenClawRuntimeSetup: false,
    intersectIncludeFile: true,
    isolate: true,
    name: "ui-timing",
    setupFiles: ["ui/src/test-helpers/lit-warnings.setup.ts"],
  });
  return {
    ...config,
    test: {
      ...config.test,
      sequence: {
        ...config.test?.sequence,
        // Root UI groups are not zero: follow both owners, not their hashed names.
        groupOrder:
          Math.max(
            uiConfig.test?.sequence?.groupOrder ?? 0,
            uiIsolatedConfig.test?.sequence?.groupOrder ?? 0,
          ) + 1,
      },
    },
  };
}

export default createUiTimingVitestConfig();
