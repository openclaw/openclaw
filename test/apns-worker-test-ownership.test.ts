import { globSync } from "node:fs";
import path from "node:path";
import { assert, beforeAll, expect, it } from "vitest";
import { buildVitestRunPlans } from "../scripts/test-projects.test-support.mts";
import { diagnosticForksPool } from "./vitest/vitest.forks-pool.ts";
import { createGatewayCoreVitestConfig } from "./vitest/vitest.gateway-core.config.ts";
import { createGatewayDatabaseWorkersVitestConfig } from "./vitest/vitest.gateway-database-workers.config.ts";
import { createGatewayMethodsVitestConfig } from "./vitest/vitest.gateway-methods.config.ts";
import { createInfraVitestConfig } from "./vitest/vitest.infra.config.ts";
import { createUnitFastFakeTimersVitestConfig } from "./vitest/vitest.unit-fast-fake-timers.config.ts";
import { createUnitFastIsolatedVitestConfig } from "./vitest/vitest.unit-fast-isolated.config.ts";
import { createUnitFastVitestConfig } from "./vitest/vitest.unit-fast.config.ts";

const consumers = [
  { file: "src/gateway/device-pairing-prune.test.ts", owner: "gateway-database-workers" },
  { file: "src/gateway/server-methods/nodes.test.ts", owner: "gateway-database-workers" },
  { file: "src/infra/device-pairing.test.ts", owner: "infra" },
  { file: "src/infra/push-apns.store.test.ts", owner: "infra" },
  { file: "src/infra/state-migrations.apns.test.ts", owner: "infra" },
  { file: "src/infra/state-migrations.test.ts", owner: "infra" },
];

function inspectProject(config: ReturnType<typeof createInfraVitestConfig>) {
  const test = config.test;
  assert(test);
  const cwd = path.resolve(test.dir ?? config.root ?? process.cwd());
  const exclude = (test.exclude ?? []).map((pattern) =>
    path.isAbsolute(pattern) ? path.relative(cwd, pattern).replaceAll("\\", "/") : pattern,
  );
  return {
    name: test.name,
    pool: test.pool,
    files: new Set(
      globSync(test.include ?? [], { cwd, exclude }).map((file) =>
        path.relative(process.cwd(), path.resolve(cwd, file)).replaceAll("\\", "/"),
      ),
    ),
  };
}

let projects: ReturnType<typeof inspectProject>[];
beforeAll(() => {
  const argv = process.argv;
  process.argv = argv.slice(0, 2);
  try {
    projects = [
      createInfraVitestConfig({}),
      createGatewayDatabaseWorkersVitestConfig({}),
      createGatewayCoreVitestConfig({}),
      createGatewayMethodsVitestConfig({}),
      createUnitFastVitestConfig({}, { argv: [] }),
      createUnitFastIsolatedVitestConfig({}, { argv: [] }),
      createUnitFastFakeTimersVitestConfig({}, { argv: [] }),
    ].map(inspectProject);
  } finally {
    process.argv = argv;
  }
});

it.each(consumers)("runs the real APNs reader $file in one fork owner", ({ file, owner }) => {
  expect(buildVitestRunPlans([file])).toEqual([
    {
      config: `test/vitest/vitest.${owner}.config.ts`,
      forwardedArgs: [],
      includePatterns: [file],
      watchMode: false,
    },
  ]);
  const selected = projects.filter((project) => project.files.has(file));
  expect(selected.map((project) => ({ name: project.name, pool: project.pool }))).toEqual([
    { name: owner, pool: owner === "infra" ? diagnosticForksPool : "forks" },
  ]);
});

it("preserves mixed watch selection when device pairing leaves the fast thread pool", () => {
  const pairing = "src/infra/device-pairing.test.ts";
  const ordinary = "src/plugin-sdk/text-chunking.test.ts";
  expect(buildVitestRunPlans(["--watch", pairing, ordinary])).toEqual([
    {
      config: "test/vitest/vitest.database-worker-watch.config.ts",
      databaseWorkerWatchOwner: "test/vitest/vitest.unit-fast.config.ts",
      databaseWorkerWatchTests: [pairing],
      forwardedArgs: [],
      includePatterns: [pairing, ordinary],
      watchMode: true,
    },
  ]);
});
