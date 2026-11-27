// Vitest extension matrix config wires the extension matrix test shard.
import { databaseWorkerExtensionTestFiles } from "./vitest.extension-database-workers-paths.mjs";
import { matrixExtensionTestRoots } from "./vitest.extension-matrix-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createExtensionMatrixVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(
    matrixExtensionTestRoots.map((root) => `${root}/**/*.test.ts`),
    {
      dir: "extensions",
      env,
      exclude: databaseWorkerExtensionTestFiles,
      name: "extension-matrix",
      passWithNoTests: true,
      setupFiles: ["test/setup.extensions.ts"],
    },
  );
}

export default createExtensionMatrixVitestConfig();
