import { databaseWorkerCoreTestFiles } from "./vitest.database-worker-core-paths.mjs";
import {
  gatewayDatabaseWorkerTestFiles,
  gatewayPluginTestFiles,
} from "./vitest.gateway-server-paths.mjs";
import { toolingIsolatedTestFiles } from "./vitest.tooling-isolated-paths.mjs";
import { boundaryTestFiles } from "./vitest.unit-paths.mjs";

export const toolingTestInclude = ["test/**/*.test.ts", "src/scripts/**/*.test.ts"];

export const toolingDockerTestFiles = [
  "test/scripts/docker-build-helper.test.ts",
  "test/scripts/docker-e2e-update-suppression.test.ts",
];

export const toolingTestExclude = [
  ...databaseWorkerCoreTestFiles,
  ...gatewayDatabaseWorkerTestFiles,
  ...boundaryTestFiles,
  ...toolingDockerTestFiles,
  ...toolingIsolatedTestFiles,
  ...gatewayPluginTestFiles,
];
