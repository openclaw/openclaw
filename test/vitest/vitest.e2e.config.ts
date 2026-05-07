import { defineConfig } from "vitest/config";
import { BUNDLED_PLUGIN_E2E_TEST_GLOB } from "./vitest.bundled-plugin-paths.ts";
import baseConfig from "./vitest.config.ts";
import { resolveRepoRootPath } from "./vitest.shared.config.ts";

type E2EWorkerEnv = {
  OPENCLAW_E2E_WORKERS?: string;
};

export function resolveE2EWorkerCount(env: E2EWorkerEnv = process.env): number {
  const requestedWorkers = Number.parseInt(env.OPENCLAW_E2E_WORKERS ?? "", 10);
  return Number.isFinite(requestedWorkers) && requestedWorkers > 0
    ? Math.min(16, requestedWorkers)
    : 1;
}

const base = baseConfig as unknown as Record<string, unknown>;
// Keep e2e runs deterministic by default; callers can still opt into parallelism.
const e2eWorkers = resolveE2EWorkerCount();
const verboseE2E = process.env.OPENCLAW_E2E_VERBOSE === "1";

const baseTestWithProjects =
  (baseConfig as { test?: { exclude?: string[]; projects?: string[]; setupFiles?: string[] } })
    .test ?? {};
const { projects: _projects, ...baseTest } = baseTestWithProjects as {
  exclude?: string[];
  projects?: string[];
  setupFiles?: string[];
};
const exclude = (baseTest.exclude ?? []).filter((p) => p !== "**/*.e2e.test.ts");

export default defineConfig({
  ...base,
  test: {
    ...baseTest,
    maxWorkers: e2eWorkers,
    silent: !verboseE2E,
    setupFiles: [
      ...new Set(
        [...(baseTest.setupFiles ?? []), "test/setup-openclaw-runtime.ts"].map(resolveRepoRootPath),
      ),
    ],
    include: [
      "test/**/*.e2e.test.ts",
      "src/**/*.e2e.test.ts",
      "packages/**/*.e2e.test.ts",
      "src/gateway/gateway.test.ts",
      "src/gateway/server.startup-matrix-migration.integration.test.ts",
      "src/gateway/sessions-history-http.test.ts",
      BUNDLED_PLUGIN_E2E_TEST_GLOB,
    ],
    exclude,
  },
});
