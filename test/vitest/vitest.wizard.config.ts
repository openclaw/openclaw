import { databaseWorkerCoreTestFiles } from "./vitest.database-worker-core-paths.mjs";
// Vitest wizard config wires the wizard test shard.
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createWizardVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(["src/wizard/**/*.test.ts"], {
    dir: "src",
    env,
    exclude: databaseWorkerCoreTestFiles,
    name: "wizard",
    passWithNoTests: true,
  });
}

export default createWizardVitestConfig();
