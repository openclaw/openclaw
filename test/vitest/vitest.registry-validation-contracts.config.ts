// Vitest config for the Phase 4F1 registry validation contract tests.
import { defineConfig } from "vitest/config";
import { nonIsolatedRunnerPath, sharedVitestConfig } from "./vitest.shared.config.ts";

export default defineConfig({
  ...sharedVitestConfig,
  test: {
    ...sharedVitestConfig.test,
    include: ["src/config/registry-validation.contract.test.ts"],
    runner: nonIsolatedRunnerPath,
  },
});
