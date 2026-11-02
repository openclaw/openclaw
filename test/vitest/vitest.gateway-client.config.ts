// Vitest gateway client config wires the gateway client test shard.
import {
  gatewayClientTestInclude,
  gatewayClientTestExclude,
} from "./vitest.gateway-server-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createGatewayClientVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(gatewayClientTestInclude, {
    env,
    exclude: gatewayClientTestExclude,
    // Gateway child projects share one include file; preserve this project's ownership.
    intersectIncludeFile: true,
    isolate: true,
    name: "gateway-client",
  });
}

export default createGatewayClientVitestConfig();
