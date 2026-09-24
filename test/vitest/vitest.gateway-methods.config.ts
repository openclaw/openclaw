// Vitest gateway methods config wires the gateway methods test shard.
import {
  gatewayMethodsTestInclude,
  gatewayMethodsTestExclude,
} from "./vitest.gateway-server-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createGatewayMethodsVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(gatewayMethodsTestInclude, {
    dir: ".",
    env,
    exclude: gatewayMethodsTestExclude,
    // Gateway child projects share one include file; preserve this project's ownership.
    intersectIncludeFile: true,
    name: "gateway-methods",
    pool: "forks",
  });
}

export default createGatewayMethodsVitestConfig();
