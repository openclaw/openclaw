// Vitest secrets config wires the secrets test shard.
import { databaseWorkerCoreTestFiles } from "./vitest.database-worker-core-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createSecretsVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(["src/secrets/**/*.test.ts"], {
    dir: "src/secrets",
    exclude: databaseWorkerCoreTestFiles,
    env,
    name: "secrets",
    passWithNoTests: true,
  });
}

export default createSecretsVitestConfig();
