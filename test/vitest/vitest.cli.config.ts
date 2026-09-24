import { getCliVitestProjectOwner } from "./vitest.cli-paths.mjs";
// Vitest cli config wires the cli test shard.
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createCliVitestConfig(env?: Record<string, string | undefined>) {
  const owner = getCliVitestProjectOwner();
  return createScopedVitestConfig(owner.include, {
    dir: owner.root,
    env,
    exclude: owner.exclude,
    name: "cli",
    passWithNoTests: true,
  });
}

export default createCliVitestConfig();
