import type { ViteUserConfig } from "vitest/config";
import { gatewayDatabaseWorkerTestFiles } from "./vitest.gateway-server-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createGatewayDatabaseWorkersVitestConfig(
  env?: Record<string, string | undefined>,
): ViteUserConfig {
  return createScopedVitestConfig(gatewayDatabaseWorkerTestFiles, {
    dir: ".",
    env,
    environment: "node",
    fileParallelism: true,
    intersectIncludeFile: true,
    isolate: false,
    name: "gateway-database-workers",
    passWithNoTests: true,
    pool: "forks",
    useNonIsolatedRunner: true,
  });
}

export default createGatewayDatabaseWorkersVitestConfig();
