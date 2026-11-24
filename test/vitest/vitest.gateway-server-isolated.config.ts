// Vitest gateway isolated config wires module-mocking Gateway tests out of the
// shared module cache.
import { defineConfig } from "vitest/config";
import { gatewayServerIsolatedTestFiles } from "./vitest.gateway-server-paths.mjs";
import {
  createScopedVitestPatternPlugin,
  withoutVitestPatternFields,
} from "./vitest.scoped-patterns.ts";
import { resolveRepoRootPath, sharedVitestConfig } from "./vitest.shared.config.ts";

export function createGatewayServerIsolatedVitestConfig(
  env: Record<string, string | undefined> = process.env,
  options: { argv?: string[] } = {},
) {
  const sharedTest = sharedVitestConfig.test ?? {};
  return defineConfig({
    ...sharedVitestConfig,
    plugins: [
      ...sharedVitestConfig.plugins,
      createScopedVitestPatternPlugin(
        gatewayServerIsolatedTestFiles,
        { env, argv: options.argv, intersectIncludeFile: true, excludeUnitFastTests: false },
        sharedTest.exclude ?? [],
      ),
    ],
    test: {
      ...withoutVitestPatternFields(sharedTest),
      name: "gateway-server-isolated",
      // Keep each file's real or mocked Gateway modules out of neighboring graphs.
      isolate: true,
      // Real Gateway fixtures own the shared-state broker on the process main thread.
      pool: "forks",
      runner: undefined,
      setupFiles: [resolveRepoRootPath("test/setup.env.ts")],
      passWithNoTests: true,
    },
  });
}

export default createGatewayServerIsolatedVitestConfig();
