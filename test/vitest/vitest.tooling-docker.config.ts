// Vitest tooling Docker config isolates the slow Docker helper contract tests.
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";
import { toolingDockerTestFiles } from "./vitest.tooling-paths.mjs";

export { toolingDockerTestFiles } from "./vitest.tooling-paths.mjs";

export function createToolingDockerVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(toolingDockerTestFiles, {
    env,
    // Retain the slow Docker helper process fixtures' separate serial budget.
    fileParallelism: false,
    name: "tooling-docker",
    passWithNoTests: true,
  });
}

export default createToolingDockerVitestConfig();
