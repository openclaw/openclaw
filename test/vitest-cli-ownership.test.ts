import fs from "node:fs";
import path from "node:path";
import { afterEach, assert, beforeAll, expect, it } from "vitest";
import { resolveConfig } from "vitest/node";
import { buildVitestRunPlans } from "../scripts/test-projects.test-support.mts";
import { createPatternFileHelper } from "./helpers/pattern-file.js";
import { createCliVitestConfig } from "./vitest/vitest.cli.config.ts";
import { databaseWorkerCoreTestFiles } from "./vitest/vitest.database-worker-core-paths.mjs";
import { createDatabaseWorkerWatchVitestConfig } from "./vitest/vitest.database-worker-watch.config.ts";
import { diagnosticForksPool } from "./vitest/vitest.forks-pool.ts";
import { createGatewayClientVitestConfig } from "./vitest/vitest.gateway-client.config.ts";
import { createGatewayCoreVitestConfig } from "./vitest/vitest.gateway-core.config.ts";
import { createGatewayDatabaseWorkersVitestConfig } from "./vitest/vitest.gateway-database-workers.config.ts";
import { createGatewayMethodsIsolatedVitestConfig } from "./vitest/vitest.gateway-methods-isolated.config.ts";
import { createGatewayMethodsVitestConfig } from "./vitest/vitest.gateway-methods.config.ts";
import { createGatewayServerIsolatedVitestConfig } from "./vitest/vitest.gateway-server-isolated.config.ts";
import { gatewayDatabaseWorkerTestFiles } from "./vitest/vitest.gateway-server-paths.mjs";
import { createGatewayServerVitestConfig } from "./vitest/vitest.gateway-server.config.ts";
import { createGatewayVitestConfig } from "./vitest/vitest.gateway.config.ts";
import { createInfraVitestConfig } from "./vitest/vitest.infra.config.ts";

const patternFiles = createPatternFileHelper("gateway-watch-ownership-");
afterEach(() => patternFiles.cleanup());
const includeEnv = (files: string[]) => ({
  OPENCLAW_VITEST_INCLUDE_FILE: patternFiles.writePatternFile("include.json", files),
});

function discover(config: {
  root?: string;
  test?: { dir?: string; include?: string[]; exclude?: string[] };
}) {
  assert(config.test);
  assert(config.root);
  const dir = config.test.dir ?? config.root;
  return fs
    .globSync(config.test.include ?? [], { cwd: dir, exclude: config.test.exclude })
    .map((file) => path.relative(config.root!, path.join(dir, file)).replaceAll("\\", "/"));
}

function selectProjects(projects: Record<string, string[]>, filters: string[]) {
  return Object.fromEntries(
    Object.entries(projects).map(([name, files]) => [name, select(files, filters)]),
  );
}

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
        const files = select(discover(config), filters).toSorted();
        return [test.name, files];
      }),
    );
  } finally {
    process.argv = originalArgv;
  }
}

function select(files: readonly string[], filters: string[]) {
  return files.filter(
    (file) =>
      filters.length === 0 ||
      filters.some((filter) => file === filter || file.startsWith(`${filter}/`)),
  );
}

let canonicalGatewayFiles: ReturnType<typeof gatewayProjectFiles>;
beforeAll(() => {
  canonicalGatewayFiles = gatewayProjectFiles([]);
});

it("routes resume local-node handshakes only through the core broker fork", () => {
  const file = "src/cli/resume-cli.test.ts";
  expect(buildVitestRunPlans([file])).toEqual([
    {
      config: "test/vitest/vitest.infra.config.ts",
      forwardedArgs: [],
      includePatterns: [file],
      watchMode: false,
    },
  ]);
  const env = includeEnv([file]);
  const worker = createInfraVitestConfig(env);
  const previous = createCliVitestConfig(env);
  assert(worker.test);
  expect(worker.test.pool).toBe(diagnosticForksPool);
  expect([discover(worker), discover(previous)]).toEqual([[file], []]);
});

it.each(["src/gateway/config-reload.telegram-policy.test.ts", "src/gateway"])(
  "preserves mixed Gateway worker watch selection with %s",
  async (target) => {
    const isFile = target.endsWith(".test.ts");
    const [workerFile] = gatewayDatabaseWorkerTestFiles;
    assert(workerFile);
    const filters = [workerFile, target];
    const forwardedArgs = ["--reporter=dot", "--coverage"];
    const plans = buildVitestRunPlans(["--watch", ...filters, ...forwardedArgs]);
    const plan = {
      config: "test/vitest/vitest.gateway.config.ts",
      forwardedArgs,
      includePatterns: [workerFile, isFile ? target : `${target}/**/*.test.ts`],
      watchMode: true,
    };
    expect(plans).toEqual([
      isFile
        ? plan
        : {
            ...plan,
            config: "test/vitest/vitest.database-worker-watch.config.ts",
            databaseWorkerWatchOwner: plan.config,
            databaseWorkerWatchTests: databaseWorkerCoreTestFiles.filter((file) =>
              file.startsWith("src/gateway/"),
            ),
          },
    ]);
    const includePatterns = plans[0]!.includePatterns;
    assert(includePatterns);
    const env = includeEnv(includePatterns);
    const selected = gatewayProjectFiles([], env);
    expect(selected).toEqual(selectProjects(canonicalGatewayFiles, filters));
    expect(selected["gateway-database-workers"]).toEqual(
      select(gatewayDatabaseWorkerTestFiles, filters),
    );
    expect(selected["gateway-core"]).toContain("src/gateway/config-reload.telegram-policy.test.ts");
    const workerFiles: string[] = [];
    if (plans[0]?.databaseWorkerWatchTests) {
      const config = createDatabaseWorkerWatchVitestConfig(
        createGatewayVitestConfig(env),
        plans[0].databaseWorkerWatchTests,
        env,
      );
      const resolved = await resolveConfig({ config: false }, config);
      const worker = resolved.test.resolvedProjects.find(
        ({ projectConfig }) => projectConfig.name === "infra",
      )?.projectConfig;
      assert(worker);
      expect(worker.pool).toBe(diagnosticForksPool.name);
      workerFiles.push(...discover({ root: worker.root, test: worker }));
    }
    expect(workerFiles.toSorted()).toEqual(select(databaseWorkerCoreTestFiles, filters).toSorted());
    const files = [...Object.values(selected).flat(), ...workerFiles];
    expect(new Set(files).size).toBe(files.length);
    if (isFile) {
      expect(files.toSorted()).toEqual(filters.toSorted());
    }
  },
);

it.each(
  [
    ["src/gateway"],
    ["src/gateway/server"],
    ["src/gateway/server-methods"],
    ["src/gateway/worker-environments"],
    ["src/gateway/server.sessions.compaction-read-errors.test.ts"],
    ["src/gateway/link-understanding.product.test.ts"],
    ["src/gateway/server", "src/gateway/worker-environments"],
  ].map((filters) => ({ filters })),
)("preserves canonical project ownership for $filters", ({ filters }) => {
  const canonical = canonicalGatewayFiles;
  expect(canonical["gateway-database-workers"]).toEqual(gatewayDatabaseWorkerTestFiles);
  const expected = selectProjects(canonical, filters);

  expect(gatewayProjectFiles(filters)).toEqual(expected);
  const selected = Object.values(expected).flat();
  expect(selected.length).toBeGreaterThan(0);
  expect(new Set(selected).size).toBe(selected.length);
});
