// Vitest config for Phase 4F2 registry validation observer tests.
import { defineConfig } from "vitest/config";
import { nonIsolatedRunnerPath, sharedVitestConfig } from "./vitest.shared.config.ts";

export default defineConfig({
  ...sharedVitestConfig,
  test: {
    ...sharedVitestConfig.test,
    include: ["src/registry-validation/**/*.test.ts"],
    runner: nonIsolatedRunnerPath,
  },
});
