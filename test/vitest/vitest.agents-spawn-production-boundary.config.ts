// Real Gateway admission needs the host-only SQLite broker, so this suite uses forked workers.
import { agentVitestProjectOwners } from "./vitest.agents-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createAgentsSpawnProductionBoundaryVitestConfig(
  env?: Record<string, string | undefined>,
) {
  const owner = agentVitestProjectOwners.spawnProductionBoundary;
  return createScopedVitestConfig(owner.include, {
    dir: owner.dir,
    env,
    fileParallelism: false,
    isolate: true,
    name: owner.name,
    passWithNoTests: true,
    pool: "forks",
    useNonIsolatedRunner: false,
  });
}

export default createAgentsSpawnProductionBoundaryVitestConfig();
