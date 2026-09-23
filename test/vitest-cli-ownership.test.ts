import fs from "node:fs";
import path from "node:path";
import { afterEach, assert, beforeAll, expect, it } from "vitest";
import { buildVitestRunPlans } from "../scripts/test-projects.test-support.mts";
import { createPatternFileHelper } from "./helpers/pattern-file.js";
import { createCliVitestConfig } from "./vitest/vitest.cli.config.ts";
import { diagnosticForksPool } from "./vitest/vitest.forks-pool.ts";
import { createGatewayClientVitestConfig } from "./vitest/vitest.gateway-client.config.ts";
import { createGatewayCoreVitestConfig } from "./vitest/vitest.gateway-core.config.ts";
import { createGatewayDatabaseWorkersVitestConfig } from "./vitest/vitest.gateway-database-workers.config.ts";
import { createGatewayMethodsIsolatedVitestConfig } from "./vitest/vitest.gateway-methods-isolated.config.ts";
import { createGatewayMethodsVitestConfig } from "./vitest/vitest.gateway-methods.config.ts";
import { createGatewayServerIsolatedVitestConfig } from "./vitest/vitest.gateway-server-isolated.config.ts";
import { gatewayDatabaseWorkerTestFiles } from "./vitest/vitest.gateway-server-paths.mjs";
import { createGatewayServerVitestConfig } from "./vitest/vitest.gateway-server.config.ts";
import { createInfraVitestConfig } from "./vitest/vitest.infra.config.ts";
import { createToolingVitestConfig } from "./vitest/vitest.tooling.config.ts";

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

let canonicalGatewayFiles: ReturnType<typeof gatewayProjectFiles>;
beforeAll(() => {
  canonicalGatewayFiles = gatewayProjectFiles([]);
});

it.each([
  ...[
    "src/gateway/link-understanding.product.test.ts",
    "src/gateway/server-methods/chat.abort-live-proof.test.ts",
    "src/gateway/server-methods/models-auth-api-key.integration.test.ts",
    "src/gateway/server-methods/models-auth-login.catalog.integration.test.ts",
    "src/gateway/server-methods/models-auth-refresh.catalog.integration.test.ts",
    "src/gateway/server-methods/models-auth-refresh.integration.test.ts",
    "src/gateway/server-methods/models-connect-publication.integration.test.ts",
    "src/gateway/server-methods/models-list.discovery-lifecycle.integration.test.ts",
    "src/gateway/server-methods/models-manual-policy.integration.test.ts",
    "src/gateway/server/ws-connection.startup.test.ts",
    "src/gateway/session-message-events.test.ts",
    "src/gateway/worker-environments/worker-session-tool-executor.test.ts",
    "test/plugins/codex-model-catalog.gateway.test.ts",
    "src/gateway/server-methods/models-list.freshness.integration.test.ts",
    "src/gateway/setup-inference.first-signin.integration.test.ts",
  ].map((file) => ({ file, owner: "gateway-database-workers" })),
  ...[
    "src/gateway/server.chat-cli-auth.test.ts",
    "src/gateway/server.cli-watchdog.test.ts",
    "src/gateway/server.codex-failure-recovery.test.ts",
  ].map((file) => ({ file, owner: "gateway-server-isolated" })),
])("keeps Gateway callers on their declared fork owner: $file", ({ file, owner }) => {
  const owners = Object.entries(gatewayProjectFiles([file]))
    .filter(([, files]) => files.includes(file))
    .map(([name]) => name);
  expect(owners).toEqual([owner]);
});

it("excludes the full Gateway TLS producer from threaded tooling", () => {
  const file = "test/e2e/qa-lab/runtime/gateway-tls-pinning.test.ts";
  const config = createToolingVitestConfig({
    OPENCLAW_VITEST_INCLUDE_FILE: patternFiles.writePatternFile("tls-tooling.json", [file]),
  });
  assert(config.test);
  assert(config.root);
  const test = config.test;
  const files = fs.globSync(test.include ?? [], {
    cwd: test.dir ?? config.root,
    exclude: test.exclude,
  });
  expect(files).toEqual([]);
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
  const env = {
    OPENCLAW_VITEST_INCLUDE_FILE: patternFiles.writePatternFile("resume-owner.json", [file]),
  };
  const worker = createInfraVitestConfig(env);
  const previous = createCliVitestConfig(env);
  assert(worker.test);
  expect(worker.test.pool).toBe(diagnosticForksPool);
  for (const [config, expected] of [
    [worker, [file]],
    [previous, []],
  ] as const) {
    assert(config.test);
    assert(config.root);
    const root = config.root;
    const dir = config.test.dir ?? root;
    const selected = fs
      .globSync(config.test.include ?? [], {
        cwd: dir,
        exclude: config.test.exclude,
      })
      .map((entry) => path.relative(root, path.join(dir, entry)).replaceAll("\\", "/"));
    expect(selected).toEqual(expected);
  }
});

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
  const canonical = canonicalGatewayFiles;
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
  const canonical = canonicalGatewayFiles;
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
