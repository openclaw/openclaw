// Vitest Gateway methods isolated config gives deep module mocks a fresh graph
// while retaining the shared Gateway methods runner and setup.
import type { ViteUserConfig } from "vitest/config";
import { gatewayMethodsIsolatedTestFiles } from "./vitest.gateway-server-paths.mjs";
import { matchesVitestGlob } from "./vitest.pattern-file.ts";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createGatewayMethodsIsolatedVitestConfig(
  env: Record<string, string | undefined> = process.env,
): ViteUserConfig {
  const config = createScopedVitestConfig(gatewayMethodsIsolatedTestFiles, {
    dir: "src/gateway",
    env,
    intersectIncludeFile: true,
    isolate: true,
    name: "gateway-methods-isolated",
    passWithNoTests: true,
    // Native Date timezone changes require a process rather than a worker's copied environment.
    pool: "forks",
    useNonIsolatedRunner: true,
  });
  const setupTest = "server-methods/system-agent-setup-control-ui.test.ts";
  if (
    !config.test?.include?.some((pattern) => matchesVitestGlob(setupTest, pattern)) ||
    config.test.exclude?.some((pattern) => matchesVitestGlob(setupTest, pattern))
  ) {
    return config;
  }
  return {
    ...config,
    // This Gateway composition owns native Node modules and renders the actual Solid UI.
    plugins: [
      ...(config.plugins ?? []),
      import("../../ui/config/control-ui-solid.ts").then(({ controlUiSolidPlugin }) =>
        controlUiSolidPlugin(),
      ),
    ],
  };
}

export default createGatewayMethodsIsolatedVitestConfig();
