// Vitest tooling Docker config isolates the slow Docker helper contract tests.
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";
import { toolingVitestProjectScopes } from "./vitest.tooling-paths.mjs";

export { toolingDockerTestFiles } from "./vitest.tooling-paths.mjs";

export function createToolingDockerVitestConfig(env?: Record<string, string | undefined>) {
  const { include, ...scope } = toolingVitestProjectScopes.toolingDocker;
  return createScopedVitestConfig(include, {
    ...scope,
    env,
    // Retain the slow Docker helper process fixtures' separate serial budget.
    fileParallelism: false,
    passWithNoTests: true,
  });
}

export default createToolingDockerVitestConfig();
