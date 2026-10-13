// These package contracts build their own artifacts without launching the root runtime.
// Keep E2E isolation and cleanup without an unrelated private-QA build.
import { defineConfig } from "vitest/config";
import e2eConfig from "./vitest.e2e.config.ts";
import { packageContractTestFiles } from "./vitest.package-contract-paths.mjs";
import { sharedVitestConfig } from "./vitest.shared.config.ts";

export default defineConfig({
  ...e2eConfig,
  test: {
    ...e2eConfig.test,
    fileParallelism: sharedVitestConfig.test.fileParallelism,
    globalSetup: [],
    include: [...packageContractTestFiles],
    isolate: true,
    maxWorkers: sharedVitestConfig.test.maxWorkers,
    name: "package-contract",
    runner: undefined,
  },
});
