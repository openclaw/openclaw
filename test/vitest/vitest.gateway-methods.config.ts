// Vitest gateway methods config wires the gateway methods test shard.
import {
  gatewayMethodsIsolatedTestFiles,
  gatewayPluginTestFiles,
} from "./vitest.gateway-server-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createGatewayMethodsVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(
    ["src/gateway/server-methods/**/*.test.ts", ...gatewayPluginTestFiles],
    {
      dir: ".",
      env,
      exclude: gatewayMethodsIsolatedTestFiles,
      // Gateway child projects share one include file; preserve this project's ownership.
      intersectIncludeFile: true,
      name: "gateway-methods",
    },
  );
}

export default createGatewayMethodsVitestConfig();
