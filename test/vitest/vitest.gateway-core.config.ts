// Vitest gateway core config wires the gateway core test shard.
import { gatewayCoreTestInclude, gatewayCoreTestExclude } from "./vitest.gateway-server-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createGatewayCoreVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(gatewayCoreTestInclude, {
    dir: "src/gateway",
    env,
    exclude: gatewayCoreTestExclude,
    // Gateway child projects share one include file; preserve this project's ownership.
    intersectIncludeFile: true,
    isolate: true,
    useNonIsolatedRunner: true,
    name: "gateway-core",
  });
}

export default createGatewayCoreVitestConfig();
