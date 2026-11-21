// Vitest tooling config wires the tooling test shard.
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";
import { sharedVitestConfig } from "./vitest.shared.config.ts";
import { toolingTestExclude, toolingTestInclude } from "./vitest.tooling-paths.mjs";

export function createToolingVitestConfig(env?: Record<string, string | undefined>) {
  const config = createScopedVitestConfig(toolingTestInclude, {
    env,
    exclude: toolingTestExclude,
    includeOpenClawRuntimeSetup: false,
    name: "tooling",
    passWithNoTests: true,
  });
  return {
    ...config,
    test: {
      ...config.test,
      // Refit needs native file elapsed time; concurrent verbose case sums overstate it.
      reporters: [...sharedVitestConfig.test.reporters, "default"],
    },
  };
}

export default createToolingVitestConfig();
