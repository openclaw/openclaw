// Vitest infra config wires the infra test shard.
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";
import { infraTestOwner } from "./vitest.test-shards.mjs";

export function createInfraVitestConfig(
  env?: Record<string, string | undefined>,
  include?: string[],
) {
  return createScopedVitestConfig(include ?? infraTestOwner.include, {
    env,
    exclude: infraTestOwner.exclude,
    isolate: true,
    name: "infra",
    intersectIncludeFile: true,
    passWithNoTests: true,
    pool: "forks",
  });
}

export default createInfraVitestConfig();
