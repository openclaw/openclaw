import { defineConfig, type ViteUserConfig } from "vitest/config";
import { resolveLocalVitestScheduling } from "../../scripts/lib/vitest-local-scheduling.mts";
import { databaseWorkerCoreTestFiles } from "./vitest.database-worker-core-paths.mjs";
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
  phase?: "native" | "parallel",
): ViteUserConfig {
  const options = {
    dir: "src/gateway",
    env,
    exclude: [
      ...databaseWorkerCoreTestFiles,
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
  if (!phaseContainer && !phase) {
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
  if (phase) {
    const selected = phase === "native" ? native : config;
    return defineConfig({
      ...selected,
      test: {
        ...selected.test,
        name: "gateway-server-" + phase,
        ...(phase === "native"
          ? { maxWorkers: 1 }
          : {
              exclude: [
                ...(config.test?.exclude ?? []),
                ...relativizeScopedPatterns(gatewayServerSerialTestFiles, options.dir),
              ],
            }),
        sequence: {
          ...selected.test?.sequence,
          groupOrder: groupOrder + (phase === "parallel" ? 1 : 0),
        },
      },
    });
  }
  return defineConfig({
    ...config,
    test: {
      ...config.test,
      // File-backed leaves retain their identity during native report replay.
      projects: [
        "test/vitest/vitest.gateway-server-native.config.ts",
        "test/vitest/vitest.gateway-server-parallel.config.ts",
      ],
    },
  });
}

export default createGatewayServerVitestConfig();
