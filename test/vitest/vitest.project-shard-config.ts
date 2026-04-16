import { defineConfig } from "vitest/config";
import { sharedVitestConfig } from "./vitest.shared.config.ts";

export function createProjectShardVitestConfig(projects: readonly string[]) {
  const maxWorkers = sharedVitestConfig.test.maxWorkers;
  if (!process.env.OPENCLAW_VITEST_MAX_WORKERS && typeof maxWorkers === "number") {
    process.env.OPENCLAW_VITEST_MAX_WORKERS = String(maxWorkers);
  }
  return defineConfig({
    ...sharedVitestConfig,
    test: {
      ...sharedVitestConfig.test,
      // Let each child project own its runner. Forcing the shared non-isolated
      // runner at the root combined-project layer can leave Vitest hanging after
      // boundary+tooling completes, even though the child projects exit cleanly
      // when run directly.
      runner: undefined,
      projects: [...projects],
    },
  });
}
