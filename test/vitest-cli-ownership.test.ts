import fs from "node:fs";
import path from "node:path";
import { afterEach, assert, expect, it } from "vitest";
import { buildVitestRunPlans } from "../scripts/test-projects.test-support.mts";
import { createPatternFileHelper } from "./helpers/pattern-file.js";
import { createGatewayClientVitestConfig } from "./vitest/vitest.gateway-client.config.ts";
import { createGatewayCoreVitestConfig } from "./vitest/vitest.gateway-core.config.ts";
import { createGatewayDatabaseWorkersVitestConfig } from "./vitest/vitest.gateway-database-workers.config.ts";
import { createGatewayMethodsIsolatedVitestConfig } from "./vitest/vitest.gateway-methods-isolated.config.ts";
import { createGatewayMethodsVitestConfig } from "./vitest/vitest.gateway-methods.config.ts";
import { createGatewayServerIsolatedVitestConfig } from "./vitest/vitest.gateway-server-isolated.config.ts";
import { gatewayDatabaseWorkerTestFiles } from "./vitest/vitest.gateway-server-paths.mjs";
import { createGatewayServerVitestConfig } from "./vitest/vitest.gateway-server.config.ts";

const patternFiles = createPatternFileHelper("gateway-watch-ownership-");
afterEach(() => patternFiles.cleanup());

function gatewayProjectFiles(filters: string[], env: Record<string, string | undefined> = {}) {
  const originalArgv = process.argv;
  process.argv = ["node", "vitest", "run", ...filters];
  try {
    return Object.fromEntries<string[]>(
      [
        createGatewayCoreVitestConfig,
        createGatewayDatabaseWorkersVitestConfig,
        createGatewayClientVitestConfig,
        createGatewayMethodsVitestConfig,
        createGatewayMethodsIsolatedVitestConfig,
        createGatewayServerVitestConfig,
        createGatewayServerIsolatedVitestConfig,
      ].map((createConfig) => {
        const config = createConfig(env);
        const test = config.test!;
        assert(typeof test.name === "string");
        const dir = test.dir ?? config.root!;
        const files = fs
          .globSync(test.include ?? [], { cwd: dir, exclude: test.exclude })
          .map((file) => path.relative(config.root!, path.join(dir, file)).replaceAll("\\", "/"))
          .filter((file) => file.startsWith("src/gateway/"))
          .filter((file) => selectedByFilters(file, filters))
          .toSorted();
        return [test.name, files];
      }),
    );
  } finally {
    process.argv = originalArgv;
  }
}

function selectedByFilters(file: string, filters: string[]): boolean {
  return (
    filters.length === 0 ||
    filters.some((filter) => file === filter || file.startsWith(`${filter}/`))
  );
}

it.each([
  {
    target: "src/gateway/config-reload.telegram-policy.test.ts",
    ownership: { config: "test/vitest/vitest.gateway.config.ts" },
  },
  {
    target: "src/gateway",
    ownership: {
      config: "test/vitest/vitest.database-worker-watch.config.ts",
      databaseWorkerWatchOwner: "test/vitest/vitest.gateway.config.ts",
      databaseWorkerWatchTests: ["src/gateway/server-methods/memory-search.test.ts"],
    },
  },
])("preserves mixed Gateway worker watch selection with $target", ({ target, ownership }) => {
  const [workerFile] = gatewayDatabaseWorkerTestFiles;
  assert(workerFile);
  const filters = [workerFile, target];
  const forwardedArgs = ["--reporter=dot", "--coverage"];
  const plans = buildVitestRunPlans(["--watch", ...filters, ...forwardedArgs]);
  expect(plans).toEqual([
    {
      ...ownership,
      forwardedArgs,
      includePatterns: [
        filters[0],
        target.endsWith(".test.ts") ? target : `${target}/**/*.test.ts`,
      ],
      watchMode: true,
    },
  ]);
  const includeFile = patternFiles.writePatternFile("include.json", plans[0]!.includePatterns);
  const canonical = gatewayProjectFiles([]);
  const expected = Object.fromEntries(
    Object.entries(canonical).map(([name, files]) => [
      name,
      files.filter((file) => selectedByFilters(file, filters)),
    ]),
  );
  const selected = gatewayProjectFiles([], { OPENCLAW_VITEST_INCLUDE_FILE: includeFile });
  expect(selected).toEqual(expected);
  expect(selected["gateway-database-workers"]).toEqual(
    gatewayDatabaseWorkerTestFiles.filter((file) => selectedByFilters(file, filters)),
  );
  expect(selected["gateway-core"]).toContain("src/gateway/config-reload.telegram-policy.test.ts");
  const files = Object.values(selected).flat();
  expect(new Set(files).size).toBe(files.length);
  if (target.endsWith(".test.ts")) {
    expect(files.toSorted()).toEqual(filters.toSorted());
  }
});

it.each(
  [
    ["src/gateway"],
    ["src/gateway/server"],
    ["src/gateway/server-methods"],
    ["src/gateway/worker-environments"],
    ["src/gateway/server.sessions.compaction-read-errors.test.ts"],
    ...gatewayDatabaseWorkerTestFiles.map((file) => [file]),
    ["src/gateway/server", "src/gateway/worker-environments"],
  ].map((filters) => ({ filters })),
)("preserves canonical project ownership for $filters", ({ filters }) => {
  const canonical = gatewayProjectFiles([]);
  expect(canonical["gateway-database-workers"]).toEqual(gatewayDatabaseWorkerTestFiles);
  const expected = Object.fromEntries(
    Object.entries(canonical).map(([name, files]) => [
      name,
      files.filter((file) => selectedByFilters(file, filters)),
    ]),
  );

  expect(gatewayProjectFiles(filters)).toEqual(expected);
  const selected = Object.values(expected).flat();
  expect(selected.length).toBeGreaterThan(0);
  expect(new Set(selected).size).toBe(selected.length);
});
