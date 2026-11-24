// Vitest tooling isolated config wires the tooling isolated test shard.
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";
import { toolingVitestProjectScopes } from "./vitest.tooling-paths.mjs";

export function createToolingIsolatedVitestConfig(env?: Record<string, string | undefined>) {
  const { include, ...scope } = toolingVitestProjectScopes.toolingIsolated;
  return createScopedVitestConfig(include, {
    ...scope,
    env,
    isolate: true,
    passWithNoTests: true,
    pool: "forks",
    useNonIsolatedRunner: false,
  });
}

export default createToolingIsolatedVitestConfig();
