// These package contracts build their own artifacts without launching the root runtime.
// Keep E2E isolation and cleanup without an unrelated private-QA build.
import { defineConfig } from "vitest/config";
import e2eConfig from "./vitest.e2e.config.ts";
import { packageContractTestFiles } from "./vitest.package-contract-paths.mjs";

export default defineConfig({
  ...e2eConfig,
  test: {
    ...e2eConfig.test,
    fileParallelism: false,
    globalSetup: [],
    include: [...packageContractTestFiles],
    maxWorkers: 1,
    name: "package-contract",
  },
});
