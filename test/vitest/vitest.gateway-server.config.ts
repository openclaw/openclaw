import { defineConfig, type ViteUserConfig } from "vitest/config";
import { resolveLocalVitestScheduling } from "../../scripts/lib/vitest-local-scheduling.mts";
import {
  gatewayDatabaseWorkerTestFiles,
  gatewayServerBackedHttpTestFiles,
  gatewayServerExcludedTestFiles,
  gatewayServerIsolatedTestFiles,
  gatewayServerSerialTestFiles,
} from "./vitest.gateway-server-paths.mjs";
import { relativizeScopedPatterns } from "./vitest.pattern-file.ts";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createGatewayServerVitestConfig(
  env?: Record<string, string | undefined>,
  phaseContainer = false,
): ViteUserConfig {
  const options = {
    dir: "src/gateway",
    env,
    exclude: [
      ...gatewayDatabaseWorkerTestFiles,
      "src/gateway/server-methods/**/*.test.ts",
      ...gatewayServerExcludedTestFiles,
      ...gatewayServerIsolatedTestFiles,
    ],
    fileParallelism: resolveLocalVitestScheduling(env).fileParallelism,
    intersectIncludeFile: true,
    isolate: false,
    // The real Gateway owns its SQLite broker on the process main thread.
    pool: "forks" as const,
    name: "gateway-server",
  };
  const config = createScopedVitestConfig(
    ["src/gateway/**/*server*.test.ts", ...gatewayServerBackedHttpTestFiles],
    options,
  );
  if (!phaseContainer) {
    return defineConfig({
      ...config,
      test: {
        ...config.test,
        // A file-backed container preserves --project gateway-server for direct invocations.
        projects: ["test/vitest/vitest.gateway-server-projects.config.ts"],
      },
    });
  }
  const native = createScopedVitestConfig(gatewayServerSerialTestFiles, {
    ...options,
    fileParallelism: false,
    name: "gateway-server-native",
  });
  const groupOrder = config.test?.sequence?.groupOrder ?? 0;
  return defineConfig({
    ...config,
    test: {
      ...config.test,
      // Config discovery retains the complete inventory; only the inline leaves run.
      projects: [
        {
          ...native,
          extends: false,
          test: {
            ...native.test,
            maxWorkers: 1,
            sequence: { ...native.test?.sequence, groupOrder },
          },
        },
        {
          ...config,
          extends: false,
          test: {
            ...config.test,
            name: "gateway-server-parallel",
            maxWorkers: undefined,
            exclude: [
              ...(config.test?.exclude ?? []),
              ...relativizeScopedPatterns(gatewayServerSerialTestFiles, options.dir),
            ],
            sequence: { ...config.test?.sequence, groupOrder: groupOrder + 1 },
          },
        },
      ],
    },
  });
}

export default createGatewayServerVitestConfig();
