// Vitest acp config wires the acp test shard.
import { databaseWorkerCoreTestFiles } from "./vitest.database-worker-core-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createAcpVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(["src/acp/**/*.test.ts"], {
    dir: "src/acp",
    env,
    exclude: databaseWorkerCoreTestFiles,
    name: "acp",
  });
}

export default createAcpVitestConfig();
