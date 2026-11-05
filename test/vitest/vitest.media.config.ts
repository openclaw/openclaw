// Vitest media config wires the media test shard.
import { databaseWorkerCoreTestFiles } from "./vitest.database-worker-core-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createMediaVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(["src/media/**/*.test.ts"], {
    dir: "src",
    env,
    intersectIncludeFile: true,
    exclude: databaseWorkerCoreTestFiles,
    name: "media",
    passWithNoTests: true,
  });
}

export default createMediaVitestConfig();
