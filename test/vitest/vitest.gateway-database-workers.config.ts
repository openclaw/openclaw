import type { ViteUserConfig } from "vitest/config";
import { controlUiSolidPlugin } from "../../ui/vite.config.ts";
import { gatewayDatabaseWorkerTestFiles } from "./vitest.gateway-server-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createGatewayDatabaseWorkersVitestConfig(
  env?: Record<string, string | undefined>,
): ViteUserConfig {
  const config = createScopedVitestConfig(gatewayDatabaseWorkerTestFiles, {
    dir: ".",
    env,
    fileParallelism: true,
    intersectIncludeFile: true,
    isolate: false,
    name: "gateway-database-workers",
    passWithNoTests: true,
    pool: "forks",
    useNonIsolatedRunner: true,
  });
  return {
    ...config,
    plugins: [...(config.plugins ?? []), controlUiSolidPlugin()],
  };
}

export default createGatewayDatabaseWorkersVitestConfig();
