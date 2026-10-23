// Vitest project shard helper builds configs for full-suite shards.
import { defineConfig } from "vitest/config";
import { nonIsolatedRunnerPath, sharedVitestConfig } from "./vitest.shared.config.ts";

export function createProjectShardVitestConfig(
  projects: readonly string[],
  options: { maxWorkers?: number } = {},
) {
  const maxWorkers = options.maxWorkers ?? sharedVitestConfig.test.maxWorkers;
  if (options.maxWorkers !== undefined) {
    process.env.OPENCLAW_VITEST_MAX_WORKERS = String(options.maxWorkers);
  } else if (!process.env.OPENCLAW_VITEST_MAX_WORKERS && typeof maxWorkers === "number") {
    process.env.OPENCLAW_VITEST_MAX_WORKERS = String(maxWorkers);
  }
  return defineConfig({
    ...sharedVitestConfig,
    test: {
      ...sharedVitestConfig.test,
      runner: nonIsolatedRunnerPath,
      projects: [...projects],
      ...(options.maxWorkers === undefined
        ? {}
        : { fileParallelism: options.maxWorkers > 1, maxWorkers: options.maxWorkers }),
    },
  });
}
