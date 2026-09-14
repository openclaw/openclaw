import {
  gatewayDatabaseWorkerTestFiles,
  gatewayServerBackedHttpTestFiles,
  gatewayServerExcludedTestFiles,
  gatewayServerIsolatedTestFiles,
} from "./vitest.gateway-server-paths.mjs";
// Vitest gateway server config wires the gateway server test shard.
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createGatewayServerVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(
    ["src/gateway/**/*server*.test.ts", ...gatewayServerBackedHttpTestFiles],
    {
      dir: "src/gateway",
      env,
      exclude: [
        ...gatewayDatabaseWorkerTestFiles,
        "src/gateway/server-methods/**/*.test.ts",
        ...gatewayServerExcludedTestFiles,
        ...gatewayServerIsolatedTestFiles,
      ],
      fileParallelism: false,
      // Gateway child projects share one include file; preserve this project's ownership.
      intersectIncludeFile: true,
      isolate: false,
      // The real Gateway owns the shared-state broker on its process main thread.
      pool: "forks",
      name: "gateway-server",
    },
  );
}

export default createGatewayServerVitestConfig();
