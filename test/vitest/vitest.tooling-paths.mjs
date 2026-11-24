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

// Config construction and watch admission share these competing owners.
// A shared include file must not move a fixture into another owner's pool.
export const toolingVitestProjectScopes = {
  tooling: {
    name: "tooling",
    include: toolingTestInclude,
    exclude: toolingTestExclude,
  },
  toolingIsolated: {
    name: "tooling-isolated",
    include: toolingIsolatedTestFiles,
    intersectIncludeFile: true,
    // Explicit isolation wins even when a thin wrapper qualifies as unit-fast.
    excludeUnitFastTests: false,
  },
  toolingDocker: {
    name: "tooling-docker",
    include: toolingDockerTestFiles,
    intersectIncludeFile: true,
  },
};
