// Vitest media understanding config wires the media understanding test shard.
import { databaseWorkerCoreTestFiles } from "./vitest.database-worker-core-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createMediaUnderstandingVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(["src/media-understanding/**/*.test.ts"], {
    dir: "src",
    env,
    exclude: databaseWorkerCoreTestFiles,
    intersectIncludeFile: true,
    includeOpenClawRuntimeSetup: false,
    name: "media-understanding",
    passWithNoTests: true,
  });
}

export default createMediaUnderstandingVitestConfig();
