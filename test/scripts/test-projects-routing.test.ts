import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { globSync } from "tinyglobby";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { resolveCanonicalNodeTestConfig } from "../../scripts/lib/ci-node-test-plan.mts";
import { collectModuleReferencesFromSource } from "../../scripts/lib/guard-inventory-utils.mjs";
import { createNativeTypeScriptParser } from "../../scripts/lib/native-typescript.mts";
import {
  listVitestRuntimeConsumerFiles,
  resolveVitestCliEntry,
  resolveVitestPretestBuildMode,
} from "../../scripts/lib/vitest-build-prerequisites.mts";
import { resolveVitestNodeArgs } from "../../scripts/lib/vitest-process-env.mts";
import { withEnv } from "../../src/test-utils/env.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createGatewayDatabaseWorkersVitestConfig } from "../vitest/vitest.gateway-database-workers.config.ts";
import { createGatewayServerIsolatedVitestConfig } from "../vitest/vitest.gateway-server-isolated.config.ts";
import {
  gatewayDatabaseWorkerTestFiles,
  isGatewayServerTestFile,
} from "../vitest/vitest.gateway-server-paths.mjs";
import { packageContractTestFiles } from "../vitest/vitest.package-contract-paths.mjs";
import { collectVitestExcludePatterns, matchesVitestGlob } from "../vitest/vitest.pattern-file.ts";

const {
  applyParallelVitestCachePaths,
  buildFullSuiteVitestRunPlans,
  buildVitestRunPlans,
  createVitestRunSpecs,
  findUnmatchedExplicitTestTargets,
  hasImportGraphImpactOnTargets,
  parseTestProjectsArgs,
  resolveChangedTargetArgs,
  resolveChangedTestTargetPlan,
  resolveParallelFullSuiteConcurrency,
} = await import("../../scripts/test-projects.test-support.mts");

it("tracks compile-cache dependencies through generated SQLite lifecycle fixtures", () => {
  expect(
    hasImportGraphImpactOnTargets(
      ["node-compile-cache.mjs"],
      ["test/non-isolated-runner.sqlite.test.ts"],
      process.cwd(),
      { tooling: true, runtimeOnly: true },
    ),
  ).toBe(true);
});

const VITEST_NODE_PREFIX = [
  "exec",
  "node",
  ...resolveVitestNodeArgs(process.env),
  resolveVitestCliEntry(),
];

function expectedPlan(
  config: string,
  includePatterns: string[] | null,
  forwardedArgs: string[] = [],
) {
  return {
    config: `test/vitest/vitest.${config}.config.ts`,
    forwardedArgs,
    includePatterns,
    watchMode: false,
  };
}

function changedPlans(paths: string[]) {
  return buildVitestRunPlans(["--changed=origin/main"], process.cwd(), () => paths);
}

describe("test-projects args", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  beforeAll(() => {
    for (const target of [
      "extensions/memory-core/src/memory/test-runtime-mocks.ts",
      "test/helpers/temp-dir.ts",
      "src/commands/onboard-non-interactive.test-helpers.ts",
    ]) {
      buildVitestRunPlans([target]);
    }
  });

  const gatewayWorkerFile = "src/gateway/server-methods/cron.runs.test.ts";
  const catalogFile = "test/plugins/codex-model-catalog.gateway.test.ts";
  it.each<[string, string, string | undefined, boolean]>([
    [gatewayWorkerFile, gatewayWorkerFile, undefined, true],
    [catalogFile, catalogFile, undefined, true],
    [gatewayWorkerFile, gatewayWorkerFile, gatewayWorkerFile, false],
    [gatewayWorkerFile, gatewayWorkerFile, "src/gateway/server-methods/*.test.ts", false],
    [catalogFile, catalogFile, catalogFile, false],
    [catalogFile, catalogFile, "test/plugins/**/*.test.ts", false],
    [catalogFile, catalogFile, "unrelated.test.ts", true],
  ])(
    "discovers Gateway owner selector %s for %s (exclude %s)",
    (selector, expected, exclude, visible) => {
      const previousArgv = process.argv;
      try {
        process.argv = [
          "node",
          "vitest",
          "run",
          "--config",
          "test/vitest/vitest.gateway-database-workers.config.ts",
          selector,
          ...(exclude ? ["--exclude", exclude] : []),
        ];
        const config = createGatewayDatabaseWorkersVitestConfig({});
        const testConfig = expectDefined(config.test, "Gateway owner test config");
        const dir = path.resolve(config.root ?? process.cwd(), testConfig.dir ?? ".");
        const relative = path.relative(dir, path.resolve(expected)).replaceAll("\\", "/");
        const excludes = [
          ...(testConfig.exclude ?? []),
          ...collectVitestExcludePatterns(process.argv.slice(2)),
        ];
        // Vitest's uncached watch matcher uses paths relative to the project directory.
        expect(
          testConfig.include?.some((pattern) => matchesVitestGlob(relative, pattern)) &&
            !excludes.some((pattern) => matchesVitestGlob(relative, pattern)),
        ).toBe(visible);
        const files = globSync(testConfig.include ?? [], {
          cwd: dir,
          ignore: excludes,
          expandDirectories: false,
          dot: true,
        }).map((file) => path.resolve(dir, file));
        expect(files).toEqual(visible ? [path.resolve(expected)] : []);
      } finally {
        process.argv = previousArgv;
      }
    },
  );

  it("keeps memory CLI runtime preparation with its infra test owner", () => {
    const file = "src/entry.memory-json.test.ts";
    const infra = "test/vitest/vitest.infra.config.ts";
    const unit = ["test/vitest/vitest.unit.config.ts", "test/vitest/vitest.unit-src.config.ts"];
    expect(listVitestRuntimeConsumerFiles([infra])).toContain(file);
    expect(listVitestRuntimeConsumerFiles(unit)).not.toContain(file);
    expect(listVitestRuntimeConsumerFiles(unit)).toContain(
      "src/node-host/linux-node-plugin.integration.test.ts",
    );
    expect(resolveVitestPretestBuildMode([{ configs: [infra], includePatterns: [file] }])).toBe(
      "runtime",
    );
  });

  it("keeps first sign-in's native provider graph isolated with its runtime prerequisite", () => {
    const file = "src/gateway/setup-inference.first-signin.integration.test.ts";
    const config = "test/vitest/vitest.gateway-server-isolated.config.ts";
    const plan = expectDefined(buildVitestRunPlans([file])[0], "first sign-in plan");
    expect(resolveCanonicalNodeTestConfig(file, plan.config)).toBe(config);
    const project = createGatewayServerIsolatedVitestConfig(
      {},
      { argv: ["node", "vitest", "run", file] },
    );
    expect(project.test).toMatchObject({
      include: [file],
      isolate: true,
      pool: "forks",
    });
    expect(
      resolveVitestPretestBuildMode([{ configs: [config], includePatterns: plan.includePatterns }]),
    ).toBe("runtime");
  });

  it("drops a pnpm passthrough separator while preserving targeted filters", () => {
    expect(parseTestProjectsArgs(["--", "src/foo.test.ts", "-t", "target"])).toEqual({
      forwardedArgs: ["src/foo.test.ts", "-t", "target"],
      nonTargetArgs: ["-t", "target"],
      targetArgs: ["src/foo.test.ts"],
      watchMode: false,
    });
  });

  it("keeps watch mode explicit without leaking the sentinel to Vitest", () => {
    const spec = expectDefined(
      createVitestRunSpecs(["--watch", "--", "src/foo.test.ts"])[0],
      "watch run spec",
    );
    expect(spec.pnpmArgs).toEqual([
      ...VITEST_NODE_PREFIX,
      "--config",
      "test/vitest/vitest.unit.config.ts",
      "src/foo.test.ts",
    ]);
  });

  it.each([["--watch", "false"], ["--no-watch"]])(
    "preserves native watch controls after the wrapper separator: %j",
    (...flags) => {
      const file = "test/scripts/run-vitest.test.ts";
      expect(parseTestProjectsArgs([file, "--", ...flags])).toEqual({
        targetArgs: [file],
        forwardedArgs: [file, ...flags],
        nonTargetArgs: flags,
        watchMode: false,
      });
    },
  );

  it("keeps option values out of project targets", () => {
    const file = "test/scripts/run-vitest.test.ts";
    const reporter = "test/scripts/reporter.test.ts";
    expect(parseTestProjectsArgs([file, "--reporter", reporter])).toEqual({
      targetArgs: [file],
      forwardedArgs: [file, "--reporter", reporter],
      nonTargetArgs: ["--reporter", reporter],
      watchMode: false,
    });
  });

  it.each([true, false])(
    "partitions targets by occurrence when an exclusion repeats the target (targetFirst=%s)",
    (targetFirst) => {
      const target = "test/scripts/run-vitest.test.ts";
      const args = targetFirst
        ? [target, "--exclude", target, "--reporter=dot"]
        : ["--exclude", target, target, "--reporter=dot"];
      expect(buildVitestRunPlans(args)).toEqual([
        expectedPlan("tooling", [target], ["--exclude", target, "--reporter=dot"]),
      ]);
    },
  );

  it("uses run mode by default", () => {
    const spec = expectDefined(createVitestRunSpecs(["src/foo.test.ts"])[0], "run spec");
    expect(spec.pnpmArgs).toEqual([
      ...VITEST_NODE_PREFIX,
      "run",
      "--config",
      "test/vitest/vitest.unit.config.ts",
      "src/foo.test.ts",
    ]);
  });

  it.each([
    ["src/infra/openclaw-root.test.ts", "boundary"],
    ["src/plugins/loader.test.ts", "bundled"],
    ["test/plugins/codex-model-catalog.gateway.test.ts", "gateway-database-workers"],
    ["test/e2e/qa-lab/runtime/gateway-loopback-lan-access.test.ts", "infra"],
    ["test/e2e/qa-lab/runtime/gateway-tls-pinning.test.ts", "infra"],
    ["test/scripts/mac-elevation-artifact.test.ts", "tooling"],
    ["src/utils.test.ts", "unit-fast-fake-timers"],
    ["extensions/google/embedding-provider.test.ts", "extension-database-workers"],
    ["src/acp/translator.stop-reason.test.ts", "infra"],
    ["src/acp/control-plane/manager.test.ts", "infra"],
    ["src/acp/control-plane/manager.cancel-session.producer-custody.worker.test.ts", "infra"],
    ["src/process/exec.test.ts", "process"],
    ["src/infra/sqlite-readonly-worker.compile-cache.process.test.ts", "cli-process"],
    ["src/daemon/schtasks-process.windows.test.ts", "cli-process"],
    ["src/snapshot/git-backup.test.ts", "infra"],
    ["src/config/sessions/disk-budget.physical-usage.test.ts", "infra"],
    ["src/entry.memory-json.test.ts", "infra"],
    ["src/plugins/setup-registry.lifecycle.test.ts", "infra"],
    ["src/wizard/setup.inference-recovery.integration.test.ts", "infra"],
    ["src/acp/runtime/session-meta.test.ts", "infra"],
    ["src/acp/runtime/session-meta-store.test.ts", "acp"],
    ["extensions/workboard/browser/catalog.test.ts", "ui"],
    ["extensions/example/browser/page.e2e.test.ts", "ui-e2e"],
    ["extensions/example/index.test.ts", "extensions"],
    ["src/plugins/contracts/memory-embedding-provider.contract.test.ts", "contracts-plugin"],
    ["src/infra/migrations.test.ts", "infra"],
    ["src/plugins/discovery.test.ts", "plugins"],
  ])("routes %s to %s", (target, config) => {
    expect(buildVitestRunPlans([target])).toEqual([expectedPlan(config, [target])]);
  });

  it("routes managed handoff scenarios through one infra project", () => {
    const files = [
      "lifecycle",
      "native-lifecycle",
      "recovery-systemd",
      "recovery-launchd",
      "terminal-result",
      "triage",
      "repair-validating",
      "repair-verifying",
    ].map((scenario) => `src/infra/update-managed-service-handoff-${scenario}.test.ts`);
    expect(buildVitestRunPlans(files)).toEqual([expectedPlan("infra", files)]);
  });

  it("keeps split test entries in their owner configs", () => {
    expect(buildVitestRunPlans(["src/agents/openai-transport-stream.base.test.ts"])).toEqual([
      expectedPlan("agents-core", ["src/agents/openai-transport-stream.base.test.ts"]),
    ]);
    for (const [target, config] of [
      ["src/auto-reply/reply/dispatch-from-config.test.ts", "auto-reply"],
      ["src/auto-reply/reply/dispatch-from-config.tts-stream.test.ts", "infra"],
    ] as const) {
      expect(buildVitestRunPlans([target])).toEqual([expectedPlan(config, [target])]);
    }
  });

  it("expands a test filename prefix into standalone sibling suites", () => {
    expect(buildVitestRunPlans(["src/agents/openai-transport-stream"])).toEqual([
      expectedPlan("agents-core", [
        "src/agents/openai-transport-stream.base.test.ts",
        "src/agents/openai-transport-stream.deepseek-and-shaping.test.ts",
        "src/agents/openai-transport-stream.failed-sse.test.ts",
        "src/agents/openai-transport-stream.replay-and-tools.test.ts",
      ]),
      expectedPlan("agents-core-isolated", [
        "src/agents/openai-transport-stream.streaming.test.ts",
      ]),
    ]);
  });

  it("caps project-level parallelism when the Vitest worker budget is conservative", () => {
    expect(
      resolveParallelFullSuiteConcurrency(58, {
        OPENCLAW_VITEST_MAX_WORKERS: "1",
      }),
    ).toBe(1);

    expect(
      resolveParallelFullSuiteConcurrency(58, {
        OPENCLAW_TEST_WORKERS: "1",
      }),
    ).toBe(1);
  });

  it("keeps conservative local full-suite runs on leaf project configs", () => {
    withEnv(
      {
        OPENCLAW_VITEST_MAX_WORKERS: "1",
        OPENCLAW_TEST_WORKERS: undefined,
        OPENCLAW_TEST_PROJECTS_PARALLEL: undefined,
        OPENCLAW_TEST_PROJECTS_LEAF_SHARDS: undefined,
        CI: undefined,
        GITHUB_ACTIONS: undefined,
      },
      () => {
        const configs = buildFullSuiteVitestRunPlans([]).map((plan) => plan.config);

        expect(configs).toContain("test/vitest/vitest.unit-fast.config.ts");
        expect(configs).toContain("test/vitest/vitest.boundary.config.ts");
        expect(configs).toContain("test/vitest/vitest.agents-core.config.ts");
        expect(configs).toContain("test/vitest/vitest.plugins.config.ts");
        expect(configs).not.toContain("test/vitest/vitest.full-core-unit-fast.config.ts");
        expect(configs).not.toContain("test/vitest/vitest.full-agentic.config.ts");
      },
    );
  });

  it("keeps explicit project-level parallelism authoritative", () => {
    expect(
      resolveParallelFullSuiteConcurrency(58, {
        GITHUB_ACTIONS: "true",
        OPENCLAW_TEST_PROJECTS_PARALLEL: "3",
        OPENCLAW_VITEST_MAX_WORKERS: "1",
      }),
    ).toBe(3);
  });

  it("uses the global host worker budget for full-suite project parallelism", () => {
    expect(
      resolveParallelFullSuiteConcurrency(
        58,
        {
          OPENCLAW_TEST_PROJECTS_LEAF_SHARDS: "1",
        },
        {
          cpuCount: 8,
          loadAverage1m: 0,
          totalMemoryBytes: 16 * 1024 ** 3,
        },
      ),
    ).toBe(2);
  });

  it("gives parallel Vitest shards separate filesystem module caches", () => {
    const specs = applyParallelVitestCachePaths(
      [
        {
          config: "test/vitest/vitest.gateway.config.ts",
          env: { KEEP_ME: "1" },
        },
        {
          config: "test/vitest/vitest.gateway-server.config.ts",
          env: {},
        },
      ],
      {
        cwd: "/repo",
        env: {},
      },
    );

    const firstEnv = specs[0]?.env;
    expect(firstEnv?.KEEP_ME).toBe("1");
    const paths = specs.map((spec) => spec.env.OPENCLAW_VITEST_FS_MODULE_CACHE_PATH);
    expect(new Set(paths).size).toBe(2);
    for (const cachePath of paths) {
      expect(cachePath?.replaceAll("\\", "/")).toMatch(
        /^\/repo\/\.cache\/vitest\/slots\/[a-f\d]+\/0$/u,
      );
    }
  });

  it("routes non-test helper file targets to importing tests inside the routed suites", () => {
    const tempDir = tempDirs.make("openclaw-helper-routing-");
    const helper = "src/gateway/gateway-connection.test-mocks.ts";
    fs.mkdirSync(path.join(tempDir, "src/gateway"), { recursive: true });
    fs.mkdirSync(path.join(tempDir, "src/tui"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, helper), "export const fixture = 1;\n");
    fs.writeFileSync(
      path.join(tempDir, "src/gateway/call.test.ts"),
      'import { fixture } from "./gateway-connection.test-mocks.js";\nvoid fixture;\n',
    );
    fs.writeFileSync(
      path.join(tempDir, "src/tui/gateway-chat.connection.test.ts"),
      'import { fixture } from "../gateway/gateway-connection.test-mocks.js";\nvoid fixture;\n',
    );

    expect(buildVitestRunPlans([helper], tempDir)).toEqual([
      expectedPlan("gateway", ["src/gateway/call.test.ts"]),
      expectedPlan("tui", ["src/tui/gateway-chat.connection.test.ts"]),
    ]);
  });

  it("routes direct and transitive extension helper importers to the owning config", () => {
    const helper = "extensions/memory-core/src/memory/test-runtime-mocks.ts";
    const plans = buildVitestRunPlans([helper]);

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.extension-database-workers.config.ts",
        forwardedArgs: [],
        includePatterns: expect.arrayContaining([
          "extensions/memory-core/src/memory/manager.fts-only-reindex.test.ts",
          "extensions/memory-core/src/memory/manager-session-update-race.test.ts",
        ]),
        watchMode: false,
      },
    ]);
    expect(plans[0]?.includePatterns).not.toContain(helper);
  });

  it("routes top-level test helpers to importing repo tests", () => {
    // Derive the importer inventory: frozen lists broke on unrelated test additions.
    const plans = buildVitestRunPlans(["test/helpers/temp-dir.ts"]);
    const planFiles = plans.map((plan) => plan.includePatterns ?? plan.forwardedArgs);
    const expandedFiles = planFiles.flat();

    expect(expandedFiles).toContain("test/helpers/temp-dir.test.ts");
    expect(expandedFiles).not.toContain("test/helpers/temp-dir.ts");
    expect(expandedFiles.filter((file) => !file.endsWith(".test.ts"))).toEqual([]);

    // Independent AST parsing excludes import text inside source fixtures.
    const scanRoots = ["src", "test", "ui", "extensions", "packages"];
    const grep = spawnSync(
      "git",
      ["grep", "-l", "--fixed-strings", "helpers/temp-dir", "--", ...scanRoots],
      { encoding: "utf8" },
    );
    expect(grep.status).toBe(0);
    using parser = createNativeTypeScriptParser();
    const candidates = grep.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((file) => file.endsWith(".test.ts") && !file.endsWith(".live.test.ts"));
    const directImporterTests = parser
      .parseSourceFiles(
        candidates.map((fileName) => ({ fileName, text: fs.readFileSync(fileName, "utf8") })),
      )
      .flatMap((sourceFile) => {
        const file = path.relative(process.cwd(), sourceFile.fileName).replaceAll("\\", "/");
        const references = collectModuleReferencesFromSource(sourceFile, {
          acceptSpecifier: (specifier) => {
            if (!specifier.startsWith(".")) {
              return false;
            }
            const resolved = path.posix.normalize(
              path.posix.join(path.posix.dirname(file), specifier),
            );
            return resolved.replace(/\.(?:js|ts)$/u, "") === "test/helpers/temp-dir";
          },
        });
        return references.some(({ kind }) => kind === "import" || kind === "export") ? [file] : [];
      });
    expect(directImporterTests.length).toBeGreaterThan(0);
    expect(directImporterTests.filter((file) => !expandedFiles.includes(file))).toEqual([]);

    expect(plans.length).toBeGreaterThan(1);
    expect(new Set(expandedFiles).size).toBe(expandedFiles.length);
    for (const files of planFiles) {
      expect(files).toEqual([...files].toSorted((left, right) => left.localeCompare(right)));
    }

    // Mixed selections coalesce owners; singleton selections retain leaf owners.
    for (const plan of plans) {
      expect(plan.watchMode).toBe(false);
      for (const file of plan.includePatterns ?? plan.forwardedArgs) {
        const config =
          plan.config === "test/vitest/vitest.e2e.config.ts" &&
          packageContractTestFiles.includes(file)
            ? "test/vitest/vitest.package-contract.config.ts"
            : plan.config === "test/vitest/vitest.gateway.config.ts" &&
                gatewayDatabaseWorkerTestFiles.includes(file)
              ? "test/vitest/vitest.gateway-database-workers.config.ts"
              : plan.config === "test/vitest/vitest.gateway.config.ts" &&
                  isGatewayServerTestFile(file)
                ? "test/vitest/vitest.gateway-server.config.ts"
                : plan.config;
        expect(buildVitestRunPlans([file])).toEqual([
          {
            config,
            forwardedArgs: plan.forwardedArgs.includes(file) ? [file] : [],
            includePatterns: plan.includePatterns ? [file] : null,
            watchMode: false,
          },
        ]);
      }
    }
  });

  it.each([
    ["src/commands/models.set.e2e.test.ts"],
    [
      "packages/sdk/src/app-sdk-external-boundary.e2e.test.ts",
      "src/commands/models.set.e2e.test.ts",
    ],
    [
      "src/commands/models.set.e2e.test.ts",
      "packages/sdk/src/app-sdk-external-boundary.e2e.test.ts",
    ],
  ])("keeps mixed E2E targets in one owner in input order: %j", (...targets) => {
    expect(buildVitestRunPlans(targets)).toEqual([expectedPlan("e2e", null, targets)]);
  });

  it.each([
    "test/e2e/qa-lab/runtime/package-openclaw-for-docker.e2e.test.ts",
    "packages/sdk/src/app-sdk-external-boundary.e2e.test.ts",
  ])("routes %s without private-QA E2E setup", (target) => {
    expect(buildVitestRunPlans([target])).toEqual([
      expectedPlan("package-contract", null, [target]),
    ]);
  });

  it.each([
    ["test/vitest/vitest.package-contract.config.ts", "test/vitest/vitest.e2e.config.ts"],
    ["test/vitest/vitest.e2e.config.ts", "test/vitest/vitest.package-contract.config.ts"],
  ])("coalesces package config into the whole E2E owner: %j", (...configs) => {
    expect(buildVitestRunPlans(configs)).toEqual([expectedPlan("e2e", null)]);
  });

  it.each([
    "packages/sdk/src/app-sdk-external-boundary.e2e.test.ts",
    "src/commands/models.set.e2e.test.ts",
  ])("keeps whole E2E config scope when also selecting %s", (target) => {
    expect(buildVitestRunPlans(["test/vitest/vitest.e2e.config.ts", target])).toEqual([
      expectedPlan("e2e", null),
    ]);
  });

  it.each([true, false])(
    "expands a package config within mixed E2E files in input order (packageFirst=%s)",
    (packageFirst) => {
      const config = "test/vitest/vitest.package-contract.config.ts";
      const packages = [
        "packages/sdk/src/app-sdk-external-boundary.e2e.test.ts",
        "test/e2e/qa-lab/runtime/package-openclaw-for-docker.e2e.test.ts",
      ];
      const ordinary = "src/commands/models.set.e2e.test.ts";
      expect(buildVitestRunPlans(packageFirst ? [config, ordinary] : [ordinary, config])).toEqual([
        {
          config: "test/vitest/vitest.e2e.config.ts",
          forwardedArgs: packageFirst ? [...packages, ordinary] : [ordinary, ...packages],
          includePatterns: null,
          watchMode: false,
        },
      ]);
    },
  );

  it.each([
    { name: "ordinary E2E path", tail: ["src/commands/models.set.e2e.test.ts"], runtime: true },
    {
      name: "Docker package with ordinary E2E path",
      target: "test/e2e/qa-lab/runtime/package-openclaw-for-docker.e2e.test.ts",
      tail: ["src/commands/models.set.e2e.test.ts"],
      runtime: true,
    },
    { name: "substring", tail: ["models.set"], runtime: true },
    { name: "command-shaped substring", tail: ["run"], runtime: true },
    {
      name: "exclude operand",
      tail: ["--exclude", "src/commands/models.set.e2e.test.ts"],
      runtime: false,
    },
    {
      name: "name-pattern operand",
      tail: ["-t", "src/commands/models.set.e2e.test.ts"],
      runtime: false,
    },
  ])(
    "preserves package file selection with native $name",
    ({ tail, runtime, target = "packages/sdk/src/app-sdk-external-boundary.e2e.test.ts" }) => {
      expect(buildVitestRunPlans([target, "--", ...tail])).toEqual([
        {
          config: runtime
            ? "test/vitest/vitest.e2e.config.ts"
            : "test/vitest/vitest.package-contract.config.ts",
          forwardedArgs: [...tail, target],
          includePatterns: null,
          watchMode: false,
        },
      ]);
    },
  );

  it.each([
    [],
    ["packages/sdk/src/app-sdk-external-boundary.e2e.test.ts"],
    ["test/e2e/qa-lab/runtime/package-openclaw-for-docker.e2e.test.ts"],
  ])("keeps an explicit package config bounded under a native substring filter: %j", (...files) => {
    const config = "test/vitest/vitest.package-contract.config.ts";
    expect(buildVitestRunPlans([config, ...files, "--", "models.set"])).toEqual([
      expectedPlan("package-contract", null, ["models.set"]),
    ]);
  });

  it("keeps a plugin browser directory scoped within its UI project", () => {
    const target = "extensions/workboard/browser";
    expect(buildVitestRunPlans([target])).toEqual([expectedPlan("ui", [`${target}/**/*.test.ts`])]);
  });

  it("keeps docs-only changed runs empty instead of widening to the full suite", () => {
    const changedPaths = ["docs/help/testing.md", "AGENTS.md"];

    expect(resolveChangedTestTargetPlan(changedPaths)).toEqual({
      mode: "targets",
      targets: [],
    });
    expect(
      resolveChangedTargetArgs(["--changed=origin/main"], process.cwd(), () => changedPaths),
    ).toStrictEqual([]);
    expect(changedPlans(changedPaths)).toStrictEqual([]);
  });

  it("routes bundled plugin manifest changes through the docs config audit", () => {
    expect(resolveChangedTestTargetPlan(["extensions/voice-call/openclaw.plugin.json"])).toEqual({
      mode: "targets",
      targets: [
        "extensions/voice-call/openclaw.plugin.json",
        "src/config/docs-config-examples.test.ts",
      ],
    });
  });

  it.each([
    {
      changedPath: "scripts/setup-auth-system.sh",
      targets: ["test/scripts/auth-monitor.test.ts"],
    },
    {
      changedPath: ".github/actions/setup-node-env/dependency-fingerprint.mjs",
      targets: [
        "test/scripts/ci-workflow-guards.test.ts",
        "test/scripts/setup-node-env-dependency-fingerprint.test.ts",
      ],
    },
  ])("routes $changedPath changes to focused tooling tests", ({ changedPath, targets }) => {
    const changedPaths = [changedPath];

    expect(resolveChangedTestTargetPlan(changedPaths)).toEqual({
      mode: "targets",
      targets,
    });
    expect(changedPlans(changedPaths)).toEqual([expectedPlan("tooling", targets)]);
  });

  it("keeps core test-only changes on their owning test lane", () => {
    const changedPaths = ["src/auto-reply/reply/commands-approve.test.ts"];

    expect(changedPlans(changedPaths)).toEqual([
      expectedPlan("auto-reply", ["src/auto-reply/reply/commands-approve.test.ts"]),
    ]);
  });

  it("routes extension-facing core contract changes and supports broad extension opt-in", () => {
    const changedPaths = ["src/plugin-sdk/core.ts"];
    const plans = changedPlans(changedPaths);
    const targetArgs = resolveChangedTargetArgs(
      ["--changed=origin/main"],
      process.cwd(),
      () => changedPaths,
    );

    expect(targetArgs).toEqual(["src/plugin-sdk/core.test.ts"]);
    expect(
      resolveChangedTargetArgs(["--changed=origin/main"], process.cwd(), () => changedPaths, {
        env: { OPENCLAW_TEST_CHANGED_BROAD: "1" },
      }),
    ).toEqual(["src/plugin-sdk/core.test.ts", "extensions"]);
    expect(plans[0]).toEqual(expectedPlan("plugin-sdk", ["src/plugin-sdk/core.test.ts"]));
    expect(plans).toHaveLength(1);
  });

  it("keeps extension production changes on the owning extension lane", () => {
    const changedPaths = ["extensions/discord/src/monitor/message-handler.ts"];

    expect(changedPlans(changedPaths)).toEqual([
      expectedPlan("extension-discord", [
        "extensions/discord/src/channel-actions.contract.test.ts",
        "extensions/discord/src/channel.message-adapter.test.ts",
        "extensions/discord/src/channel.test.ts",
        "extensions/discord/src/monitor/message-handler.bot-self-filter.test.ts",
        "extensions/discord/src/monitor/message-handler.queue.test.ts",
        "extensions/discord/src/monitor/provider.skill-dedupe.test.ts",
        "extensions/discord/src/monitor/provider.test.ts",
      ]),
      expectedPlan("extension-database-workers", [
        "extensions/discord/src/durable-delivery.test.ts",
      ]),
    ]);
  });

  it("splits mixed core and extension targets into separate vitest runs", () => {
    expect(
      buildVitestRunPlans([
        "src/config/config-misc.test.ts",
        "extensions/discord/src/monitor/message-handler.preflight.test.ts",
        "-t",
        "mention",
      ]),
    ).toEqual([
      expectedPlan("runtime-config", ["src/config/config-misc.test.ts"], ["-t", "mention"]),
      expectedPlan(
        "extension-discord",
        ["extensions/discord/src/monitor/message-handler.preflight.test.ts"],
        ["-t", "mention"],
      ),
    ]);
  });

  it("writes scoped include files for routed extension runs", () => {
    const [spec] = createVitestRunSpecs([
      "extensions/discord/src/monitor/message-handler.preflight.test.ts",
    ]);

    expect(spec?.pnpmArgs).toEqual([
      ...VITEST_NODE_PREFIX,
      "run",
      "--config",
      "test/vitest/vitest.extension-discord.config.ts",
    ]);
    expect(spec?.includePatterns).toEqual([
      "extensions/discord/src/monitor/message-handler.preflight.test.ts",
    ]);
    expect(spec?.includeFilePath).toContain("openclaw-vitest-include-");
    expect(spec?.env.OPENCLAW_VITEST_INCLUDE_FILE).toBe(spec?.includeFilePath);
  });

  it.each([
    ["src/not-a-real-openclaw-test.test.ts", "path-does-not-exist"],
    ["src/**/not-a-real-openclaw-test.test.ts", "glob-matched-no-files"],
  ])("rejects unmatched target %s", (target, reason) => {
    expect(findUnmatchedExplicitTestTargets([target])).toEqual([{ target, reason }]);
  });

  it("rejects explicit non-test file targets with no sibling tests", () => {
    const tempDir = tempDirs.make("openclaw-test-targets-");
    fs.mkdirSync(path.join(tempDir, "src", "lonely"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "src", "lonely", "runtime.ts"), "export {};\n");

    expect(findUnmatchedExplicitTestTargets(["src/lonely/runtime.ts"], tempDir)).toEqual([
      {
        target: "src/lonely/runtime.ts",
        reason: "target-matched-no-test-files",
        includePattern: "src/lonely/**/*.test.ts",
      },
    ]);
  });

  it("accepts explicit untracked test files that exist on disk", () => {
    const tempDir = tempDirs.make("openclaw-test-targets-");
    fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "src", "new.test.ts"), "test('new', () => {});\n");

    expect(findUnmatchedExplicitTestTargets(["src/new.test.ts"], tempDir)).toEqual([]);
  });

  it("accepts explicit Vitest config targets routed as whole config runs", () => {
    expect(
      findUnmatchedExplicitTestTargets(["test/vitest/vitest.contracts-channel-surface.config.ts"]),
    ).toEqual([]);
  });

  it("accepts sentinel targets routed as whole config runs", () => {
    expect(findUnmatchedExplicitTestTargets(["ui/src/test-helpers/control-ui-e2e.ts"])).toEqual([]);
  });

  it("skips channel contract configs with no matching external include patterns", () => {
    const tempDir = tempDirs.make("openclaw-contract-include-");
    const includeFile = path.join(tempDir, "include.json");
    fs.writeFileSync(
      includeFile,
      JSON.stringify([
        "src/channels/plugins/contracts/surfaces-only.registry-backed-shard-b.contract.test.ts",
      ]),
      "utf8",
    );

    const specs = createVitestRunSpecs(
      [
        "test/vitest/vitest.contracts-channel-surface.config.ts",
        "test/vitest/vitest.contracts-channel-config.config.ts",
        "test/vitest/vitest.contracts-channel-registry.config.ts",
        "test/vitest/vitest.contracts-channel-session.config.ts",
      ],
      {
        baseEnv: {
          OPENCLAW_VITEST_INCLUDE_FILE: includeFile,
        } as NodeJS.ProcessEnv,
      },
    );

    expect(specs.map((spec) => spec.config)).toEqual([
      "test/vitest/vitest.contracts-channel-config.config.ts",
    ]);
  });

  it("rejects watch mode when a command spans multiple suites", () => {
    expect(() =>
      buildVitestRunPlans([
        "--watch",
        "src/config/config-misc.test.ts",
        "extensions/discord/src/monitor/message-handler.preflight.test.ts",
      ]),
    ).toThrow("watch mode with mixed test suites is not supported");
  });
});
