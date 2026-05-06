import path from "node:path";
import { fileURLToPath } from "node:url";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

const cronGlobalSetupPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "vitest.cron-global-setup.ts",
);

export function createCronVitestConfig(env?: Record<string, string | undefined>) {
  const config = createScopedVitestConfig(["src/cron/**/*.test.ts"], {
    dir: "src",
    env,
    name: "cron",
    passWithNoTests: true,
  });
  const baseGlobalSetup = config.test?.globalSetup;
  const mergedGlobalSetup = [
    ...(Array.isArray(baseGlobalSetup)
      ? baseGlobalSetup
      : baseGlobalSetup
        ? [baseGlobalSetup]
        : []),
    cronGlobalSetupPath,
  ];
  config.test = {
    ...config.test,
    maxWorkers: 1,
    fileParallelism: false,
    globalSetup: mergedGlobalSetup,
    sequence: {
      ...config.test?.sequence,
      groupOrder: 1,
    },
  };
  return config;
}

export default createCronVitestConfig();
