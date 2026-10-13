// Test project script tests cover fixture project discovery and validation.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { collectModuleReferencesFromSource } from "../../scripts/lib/guard-inventory-utils.mjs";
import { createNativeTypeScriptParser } from "../../scripts/lib/native-typescript.mts";
import {
  listVitestRuntimeConsumerFiles,
  resolveVitestCliEntry,
  resolveVitestPretestBuildMode,
} from "../../scripts/lib/vitest-build-prerequisites.mts";
import { resolveVitestNodeArgs } from "../../scripts/lib/vitest-process-env.mts";
import { withEnv } from "../../src/test-utils/env.js";
import {
  gatewayDatabaseWorkerTestFiles,
  isGatewayServerTestFile,
} from "../vitest/vitest.gateway-server-paths.mjs";
import { packageContractTestFiles } from "../vitest/vitest.package-contract-paths.mjs";

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

describe("test-projects args", () => {
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

  it.each([["--no-watch"]])(
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

  it("routes top-level test helpers to importing repo tests", () => {
    // The importer inventory of test/helpers/temp-dir.ts churns with every new
    // test using the helper; frozen full lists broke main on unrelated test
    // additions. Assert the routing structure instead of the inventory.
    const plans = buildVitestRunPlans(["test/helpers/temp-dir.ts"]);
    const planFiles = plans.map((plan) => plan.includePatterns ?? plan.forwardedArgs);
    const expandedFiles = planFiles.flat();

    // Helper targets expand to importing test files; the helper itself never
    // reaches Vitest as a raw target.
    expect(expandedFiles).toContain("test/helpers/temp-dir.test.ts");
    expect(expandedFiles).not.toContain("test/helpers/temp-dir.ts");
    expect(expandedFiles.filter((file) => !file.endsWith(".test.ts"))).toEqual([]);

    // Lower bound derived from the repo itself: every tracked test file that
    // directly imports the helper must be picked up by the expansion scan, so
    // dropped importers still fail without freezing the full inventory. The
    // independent AST reader excludes import text inside source fixtures.
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

    // Importers partition across configs: each file lands in exactly one plan,
    // in deterministic sorted order.
    expect(plans.length).toBeGreaterThan(1);
    expect(new Set(expandedFiles).size).toBe(expandedFiles.length);
    for (const files of planFiles) {
      expect(files).toEqual([...files].toSorted((left, right) => left.localeCompare(right)));
    }

    // Mixed selections coalesce package contracts and Gateway child tests
    // into their aggregate owners. Singleton selection retains each leaf owner.
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
    {
      name: "name-pattern operand",
      tail: ["-t", "src/commands/models.set.e2e.test.ts"],
      runtime: false,
    },
  ])("preserves package file selection with native $name", ({ tail, runtime }) => {
    const target = "packages/sdk/src/app-sdk-external-boundary.e2e.test.ts";
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
    expect(
      buildVitestRunPlans(["--changed=origin/main"], process.cwd(), () => changedPaths),
    ).toStrictEqual([]);
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

  it("keeps core test-only changes on their owning test lane", () => {
    const changedPaths = ["src/auto-reply/reply/commands-approve.test.ts"];

    expect(
      buildVitestRunPlans(["--changed=origin/main"], process.cwd(), () => changedPaths),
    ).toEqual([
      {
        config: "test/vitest/vitest.auto-reply.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/auto-reply/reply/commands-approve.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes extension-facing core contract changes and supports broad extension opt-in", () => {
    const changedPaths = ["src/plugin-sdk/core.ts"];
    const plans = buildVitestRunPlans(["--changed=origin/main"], process.cwd(), () => changedPaths);
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
    expect(plans[0]).toEqual({
      config: "test/vitest/vitest.plugin-sdk.config.ts",
      forwardedArgs: [],
      includePatterns: ["src/plugin-sdk/core.test.ts"],
      watchMode: false,
    });
    expect(plans).toHaveLength(1);
  });

  it("rejects explicit non-test file targets with no sibling tests", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-test-targets-"));
    try {
      fs.mkdirSync(path.join(tempDir, "src", "lonely"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, "src", "lonely", "runtime.ts"), "export {};\n");

      expect(findUnmatchedExplicitTestTargets(["src/lonely/runtime.ts"], tempDir)).toEqual([
        {
          target: "src/lonely/runtime.ts",
          reason: "target-matched-no-test-files",
          includePattern: "src/lonely/**/*.test.ts",
        },
      ]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
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
