import { defineConfig } from "vitest/config";
import { nonIsolatedRunnerPath, sharedVitestConfig } from "./vitest.shared.config.ts";

const base = sharedVitestConfig as Record<string, unknown>;
const baseTest = sharedVitestConfig.test ?? {};

export function createContractsVitestConfig() {
  return defineConfig({
    ...base,
    test: {
      ...baseTest,
      isolate: false,
      runner: nonIsolatedRunnerPath,
      setupFiles: baseTest.setupFiles ?? [],
      include: [
        "src/channels/plugins/contracts/**/*.test.ts",
        "src/plugins/contracts/**/*.test.ts",
      ],
      passWithNoTests: true,
    },
  });
}

export default createContractsVitestConfig();
