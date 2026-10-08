// Vitest tooling config wires the tooling test shard.
import { databaseWorkerCoreTestFiles } from "./vitest.database-worker-core-paths.mjs";
import {
  gatewayDatabaseWorkerTestFiles,
  gatewayPluginTestFiles,
} from "./vitest.gateway-server-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";
import { sharedVitestConfig } from "./vitest.shared.config.ts";
import { toolingDockerTestFiles } from "./vitest.tooling-docker.config.ts";
import { toolingIsolatedTestFiles } from "./vitest.tooling-isolated-paths.mjs";
import { boundaryTestFiles } from "./vitest.unit-paths.mjs";

export function createToolingVitestConfig(env?: Record<string, string | undefined>) {
  const config = createScopedVitestConfig(["test/**/*.test.ts", "src/scripts/**/*.test.ts"], {
    env,
    exclude: [
      ...databaseWorkerCoreTestFiles,
      ...gatewayDatabaseWorkerTestFiles,
      ...boundaryTestFiles,
      ...toolingDockerTestFiles,
      ...toolingIsolatedTestFiles,
      ...gatewayPluginTestFiles,
    ],
    includeOpenClawRuntimeSetup: false,
    name: "tooling",
    passWithNoTests: true,
  });
  return {
    ...config,
    test: {
      ...config.test,
      // Refit needs native file elapsed time; concurrent verbose case sums overstate it.
      reporters: [...sharedVitestConfig.test.reporters, "default"],
    },
  };
}

export default createToolingVitestConfig();
