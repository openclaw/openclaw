import path from "node:path";
import { loadConfigFromFile, type UserConfig } from "vite";
import { defineConfig } from "vitest/config";
import {
  DATABASE_WORKER_WATCH_OWNER_ENV_KEY,
  DATABASE_WORKER_WATCH_TESTS_ENV_KEY,
  databaseWorkerCoreTestFiles,
} from "./vitest.database-worker-core-paths.mjs";
import { databaseWorkerExtensionTestFiles } from "./vitest.extension-database-workers-paths.mjs";
import { createExtensionDatabaseWorkersVitestConfig } from "./vitest.extension-database-workers.config.ts";
import { intersectIncludePatterns, relativizeScopedPatterns } from "./vitest.include-patterns.ts";
import { createInfraVitestConfig } from "./vitest.infra.config.ts";
import { loadPatternListFromEnv, matchesVitestGlob } from "./vitest.pattern-file.ts";
import { resolveRepoRootPath } from "./vitest.shared.config.ts";

export function createDatabaseWorkerWatchVitestConfig(
  owner: UserConfig,
  workerTests: string[],
  env: Record<string, string | undefined> = process.env,
) {
  const createWorkerConfig = workerTests.some((file) => file.startsWith("extensions/"))
    ? createExtensionDatabaseWorkersVitestConfig
    : createInfraVitestConfig;
  const worker = createWorkerConfig({ ...env, OPENCLAW_VITEST_INCLUDE_FILE: undefined });
  return defineConfig({
    ...owner,
    test: {
      ...owner.test,
      projects: [
        { ...owner, extends: false },
        {
          ...worker,
          extends: false,
          test: {
            ...worker.test,
            include: relativizeScopedPatterns(
              intersectIncludePatterns(
                workerTests,
                loadPatternListFromEnv("OPENCLAW_VITEST_INCLUDE_FILE", env),
                matchesVitestGlob,
              ) ?? workerTests,
              path.relative(process.cwd(), worker.test?.dir ?? process.cwd()),
            ),
          },
        },
      ],
    },
  });
}

export default defineConfig(async () => {
  const ownerPath = process.env[DATABASE_WORKER_WATCH_OWNER_ENV_KEY];
  if (!ownerPath) {
    throw new Error("database worker watch requires its selected test owner");
  }
  const workerTests: unknown = JSON.parse(
    process.env[DATABASE_WORKER_WATCH_TESTS_ENV_KEY] ?? "null",
  );
  if (
    !Array.isArray(workerTests) ||
    !workerTests.every(
      (file): file is string =>
        typeof file === "string" &&
        (databaseWorkerCoreTestFiles.includes(file) ||
          databaseWorkerExtensionTestFiles.includes(file)),
    )
  ) {
    throw new Error("database worker watch requires its selected worker tests");
  }
  const owner = await loadConfigFromFile(
    { command: "serve", mode: "test" },
    resolveRepoRootPath(ownerPath),
  );
  if (!owner) {
    throw new Error(`could not load database worker watch owner: ${ownerPath}`);
  }
  return createDatabaseWorkerWatchVitestConfig(owner.config, workerTests);
});
