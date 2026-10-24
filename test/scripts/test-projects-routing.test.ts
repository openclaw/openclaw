import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { globSync } from "tinyglobby";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCanonicalNodeTestConfig } from "../../scripts/lib/ci-node-test-plan.mts";
import {
  listVitestRuntimeConsumerFiles,
  resolveVitestCliEntry,
  resolveVitestPretestBuildMode,
} from "../../scripts/lib/vitest-build-prerequisites.mts";
import { resolveVitestNodeArgs } from "../../scripts/lib/vitest-process-env.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createGatewayDatabaseWorkersVitestConfig } from "../vitest/vitest.gateway-database-workers.config.ts";
import { createGatewayServerIsolatedVitestConfig } from "../vitest/vitest.gateway-server-isolated.config.ts";
import { collectVitestExcludePatterns, matchesVitestGlob } from "../vitest/vitest.pattern-file.ts";

const {
  buildVitestRunPlans: planRuns,
  createVitestRunSpecs: runSpecs,
  findUnmatchedExplicitTestTargets: unmatchedTargets,
  hasImportGraphImpactOnTargets,
  parseTestProjectsArgs: parseArgs,
  resolveChangedTargetArgs: changedArgs,
  resolveChangedTestTargetPlan: changedPlan,
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
const packageTest = "packages/sdk/src/app-sdk-external-boundary.e2e.test.ts";
const dockerPackageTest = "test/e2e/qa-lab/runtime/package-openclaw-for-docker.e2e.test.ts";
const ordinaryE2eTest = "src/commands/models.set.e2e.test.ts";
const packageConfig = "test/vitest/vitest.package-contract.config.ts";
const e2eConfig = "test/vitest/vitest.e2e.config.ts";
const coreTest = "src/config/config-misc.test.ts";
const extensionTest = "extensions/discord/src/monitor/message-handler.preflight.test.ts";

function expectedPlan(
  config: string,
  includePatterns: string[] | null,
  forwardedArgs: string[] = [],
) {
  return {
    config: config.endsWith(".ts") ? config : `test/vitest/vitest.${config}.config.ts`,
    forwardedArgs,
    includePatterns,
    watchMode: false,
  };
}

function changedPlans(paths: string[]) {
  return planRuns(["--changed=origin/main"], process.cwd(), () => paths);
}

function expectPlan(
  args: string[],
  config: string,
  include: string[] | null = args,
  forwarded: string[] = [],
) {
  expect(planRuns(args)).toEqual([expectedPlan(config, include, forwarded)]);
}

function fixtureFiles(files: Record<string, string>) {
  const root = tempDirs.make("openclaw-routing-");
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return root;
}
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("test-projects args", () => {
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
    const plan = expectDefined(planRuns([file])[0], "first sign-in plan");
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
    expect(parseArgs(["--", "src/foo.test.ts", "-t", "target"])).toEqual({
      forwardedArgs: ["src/foo.test.ts", "-t", "target"],
      nonTargetArgs: ["-t", "target"],
      targetArgs: ["src/foo.test.ts"],
      watchMode: false,
    });
  });

  it.each([false, true])(
    "sets native run/watch mode without leaking the sentinel (watch=%s)",
    (watch) => {
      const spec = expectDefined(
        runSpecs(watch ? ["--watch", "--", "src/foo.test.ts"] : ["src/foo.test.ts"])[0],
        "run spec",
      );
      expect(spec.pnpmArgs).toEqual([
        ...VITEST_NODE_PREFIX,
        ...(watch ? [] : ["run"]),
        "--config",
        "test/vitest/vitest.unit.config.ts",
        "src/foo.test.ts",
      ]);
    },
  );

  it.each([["--watch", "false"], ["--no-watch"]])(
    "preserves native watch controls after the wrapper separator: %j",
    (...flags) => {
      const file = "test/scripts/run-vitest.test.ts";
      expect(parseArgs([file, "--", ...flags])).toEqual({
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
    expect(parseArgs([file, "--reporter", reporter])).toEqual({
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
      expect(planRuns(args)).toEqual([
        expectedPlan("tooling", [target], ["--exclude", target, "--reporter=dot"]),
      ]);
    },
  );

  it.each([
    ["src/infra/openclaw-root.test.ts", "boundary"],
    ["src/plugins/loader.test.ts", "bundled"],
    ["test/plugins/codex-model-catalog.gateway.test.ts", "gateway-database-workers"],
    ["test/scripts/mac-elevation-artifact.test.ts", "tooling"],
    ["src/utils.test.ts", "unit-fast-fake-timers"],
    ["extensions/google/embedding-provider.test.ts", "extension-database-workers"],
    ["src/process/exec.test.ts", "process"],
    ["src/infra/sqlite-readonly-worker.compile-cache.process.test.ts", "cli-process"],
    ["src/acp/runtime/session-meta.test.ts", "infra"],
    ["src/acp/runtime/session-meta-store.test.ts", "acp"],
    ["extensions/workboard/browser/catalog.test.ts", "ui"],
    ["extensions/example/browser/page.e2e.test.ts", "ui-e2e"],
    ["extensions/example/index.test.ts", "extensions"],
    ["src/plugins/contracts/memory-embedding-provider.contract.test.ts", "contracts-plugin"],
    ["src/plugins/discovery.test.ts", "plugins"],
    ["src/agents/openai-transport-stream.base.test.ts", "agents-core"],
    ["src/auto-reply/reply/dispatch-from-config.test.ts", "auto-reply"],
    ["src/auto-reply/reply/dispatch-from-config.tts-stream.test.ts", "infra"],
  ])("routes %s to %s", (target, config) => {
    expectPlan([target], config);
  });

  it.each(["OPENCLAW_VITEST_MAX_WORKERS", "OPENCLAW_TEST_WORKERS"])(
    "caps project-level parallelism for conservative %s",
    (key) => expect(resolveParallelFullSuiteConcurrency(58, { [key]: "1" })).toBe(1),
  );

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

  it("routes non-test helper file targets to importing tests inside the routed suites", () => {
    const helper = "src/gateway/gateway-connection.test-mocks.ts";
    const tempDir = fixtureFiles({
      [helper]: "export const fixture = 1;",
      "src/gateway/call.test.ts": 'import "./gateway-connection.test-mocks.js";',
      "src/tui/gateway-chat.connection.test.ts":
        'import "../gateway/gateway-connection.test-mocks.js";',
    });

    expect(planRuns([helper], tempDir)).toEqual([
      expectedPlan("gateway", ["src/gateway/call.test.ts"]),
      expectedPlan("tui", ["src/tui/gateway-chat.connection.test.ts"]),
    ]);
  });

  it("routes top-level test helpers to importing repo tests", () => {
    const helper = "test/helpers/fixture.ts";
    const consumers = ["test/scripts/a.test.ts", "test/scripts/b.test.ts", "src/tui/c.test.ts"];
    const root = fixtureFiles({
      [helper]: "export const fixture = 1;",
      [consumers[0]!]: 'import "../helpers/fixture.js";',
      [consumers[1]!]: 'export * from "../helpers/fixture.js";',
      [consumers[2]!]: 'import "../../test/helpers/fixture.js";',
      "test/scripts/decoy.test.ts": "const source = 'import \"../helpers/fixture.js\";';",
    });
    expect(planRuns([helper], root)).toEqual([
      expectedPlan("tooling", consumers.slice(0, 2)),
      expectedPlan("tui", consumers.slice(2)),
    ]);
  });

  it.each([[ordinaryE2eTest], [packageTest, ordinaryE2eTest], [ordinaryE2eTest, packageTest]])(
    "keeps mixed E2E targets in one owner in input order: %j",
    (...targets) => {
      expectPlan(targets, "e2e", null, targets);
    },
  );

  it.each([dockerPackageTest, packageTest])("routes %s without private-QA E2E setup", (target) => {
    expectPlan([target], "package-contract", null, [target]);
  });

  it.each([
    [packageConfig, e2eConfig],
    [e2eConfig, packageConfig],
  ])("coalesces package config into the whole E2E owner: %j", (...configs) => {
    expectPlan(configs, "e2e", null);
  });

  it.each([packageTest, ordinaryE2eTest])(
    "keeps whole E2E config scope when also selecting %s",
    (target) => {
      expectPlan([e2eConfig, target], "e2e", null);
    },
  );

  it.each([true, false])(
    "expands a package config within mixed E2E files in input order (packageFirst=%s)",
    (packageFirst) => {
      const packages = [packageTest, dockerPackageTest];
      expectPlan(
        packageFirst ? [packageConfig, ordinaryE2eTest] : [ordinaryE2eTest, packageConfig],
        "e2e",
        null,
        packageFirst ? [...packages, ordinaryE2eTest] : [ordinaryE2eTest, ...packages],
      );
    },
  );

  it.each([
    { name: "ordinary E2E path", tail: [ordinaryE2eTest], runtime: true },
    { name: "substring", tail: ["models.set"], runtime: true },
    {
      name: "exclude operand",
      tail: ["--exclude", ordinaryE2eTest],
      runtime: false,
    },
    {
      name: "name-pattern operand",
      tail: ["-t", ordinaryE2eTest],
      runtime: false,
    },
  ])("preserves package file selection with native $name", ({ tail, runtime }) => {
    expectPlan([packageTest, "--", ...tail], runtime ? "e2e" : "package-contract", null, [
      ...tail,
      packageTest,
    ]);
  });

  it.each([[], [packageTest]])(
    "keeps an explicit package config bounded under a native substring filter: %j",
    (...files) => {
      expectPlan([packageConfig, ...files, "--", "models.set"], "package-contract", null, [
        "models.set",
      ]);
    },
  );

  it("keeps a plugin browser directory scoped within its UI project", () => {
    const target = "extensions/workboard/browser";
    expectPlan([target], "ui", [`${target}/**/*.test.ts`]);
  });

  it("keeps docs-only changed runs empty instead of widening to the full suite", () => {
    const changedPaths = ["docs/help/testing.md", "AGENTS.md"];

    expect(changedPlan(changedPaths)).toEqual({
      mode: "targets",
      targets: [],
    });
    expect(changedArgs(["--changed=origin/main"], process.cwd(), () => changedPaths)).toStrictEqual(
      [],
    );
    expect(changedPlans(changedPaths)).toStrictEqual([]);
  });

  it("routes bundled plugin manifest changes through the docs config audit", () => {
    expect(changedPlan(["extensions/voice-call/openclaw.plugin.json"])).toEqual({
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

    expect(changedPlan(changedPaths)).toEqual({
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
    const targetArgs = changedArgs(["--changed=origin/main"], process.cwd(), () => changedPaths);

    expect(targetArgs).toEqual(["src/plugin-sdk/core.test.ts"]);
    expect(
      changedArgs(["--changed=origin/main"], process.cwd(), () => changedPaths, {
        env: { OPENCLAW_TEST_CHANGED_BROAD: "1" },
      }),
    ).toEqual(["src/plugin-sdk/core.test.ts", "extensions"]);
    expect(plans[0]).toEqual(expectedPlan("plugin-sdk", ["src/plugin-sdk/core.test.ts"]));
    expect(plans).toHaveLength(1);
  });

  it("keeps extension production changes on the owning extension lane", () => {
    const changedPaths = ["extensions/discord/src/monitor/message-handler.ts"];
    const plans = changedPlans(changedPaths);
    expect(plans.map((plan) => plan.config)).toEqual([
      "test/vitest/vitest.extension-discord.config.ts",
      "test/vitest/vitest.extension-database-workers.config.ts",
    ]);
    for (const plan of plans) {
      expect(plan.includePatterns?.length).toBeGreaterThan(0);
      expect(
        plan.includePatterns?.every(
          (file) => file.startsWith("extensions/discord/") && file.endsWith(".test.ts"),
        ),
      ).toBe(true);
    }
  });

  it("splits mixed core and extension targets into separate vitest runs", () => {
    expect(planRuns([coreTest, extensionTest, "-t", "mention"])).toEqual([
      expectedPlan("runtime-config", [coreTest], ["-t", "mention"]),
      expectedPlan("extension-discord", [extensionTest], ["-t", "mention"]),
    ]);
  });

  it("writes scoped include files for routed extension runs", () => {
    const [spec] = runSpecs([extensionTest]);

    expect(spec?.pnpmArgs).toEqual([
      ...VITEST_NODE_PREFIX,
      "run",
      "--config",
      "test/vitest/vitest.extension-discord.config.ts",
    ]);
    expect(spec?.includePatterns).toEqual([extensionTest]);
    expect(spec?.includeFilePath).toContain("openclaw-vitest-include-");
    expect(spec?.env.OPENCLAW_VITEST_INCLUDE_FILE).toBe(spec?.includeFilePath);
  });

  it.each([
    ["src/not-a-real-openclaw-test.test.ts", "path-does-not-exist"],
    ["src/**/not-a-real-openclaw-test.test.ts", "glob-matched-no-files"],
  ])("rejects unmatched target %s", (target, reason) => {
    expect(unmatchedTargets([target])).toEqual([{ target, reason }]);
  });

  it("rejects explicit non-test file targets with no sibling tests", () => {
    const tempDir = fixtureFiles({ "src/lonely/runtime.ts": "export {};" });

    expect(unmatchedTargets(["src/lonely/runtime.ts"], tempDir)).toEqual([
      {
        target: "src/lonely/runtime.ts",
        reason: "target-matched-no-test-files",
        includePattern: "src/lonely/**/*.test.ts",
      },
    ]);
  });

  it("accepts explicit untracked test files that exist on disk", () => {
    const tempDir = fixtureFiles({ "src/new.test.ts": "test('new', () => {});" });

    expect(unmatchedTargets(["src/new.test.ts"], tempDir)).toEqual([]);
  });

  it("accepts explicit Vitest config targets routed as whole config runs", () => {
    expect(unmatchedTargets(["test/vitest/vitest.contracts-channel-surface.config.ts"])).toEqual(
      [],
    );
  });

  it("accepts sentinel targets routed as whole config runs", () => {
    expect(unmatchedTargets(["ui/src/test-helpers/control-ui-e2e.ts"])).toEqual([]);
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

    const specs = runSpecs(
      [
        "test/vitest/vitest.contracts-channel-surface.config.ts",
        "test/vitest/vitest.contracts-channel-config.config.ts",
        "test/vitest/vitest.contracts-channel-registry.config.ts",
        "test/vitest/vitest.contracts-channel-session.config.ts",
      ],
      {
        baseEnv: { OPENCLAW_VITEST_INCLUDE_FILE: includeFile },
      },
    );

    expect(specs.map((spec) => spec.config)).toEqual([
      "test/vitest/vitest.contracts-channel-config.config.ts",
    ]);
  });

  it("rejects watch mode when a command spans multiple suites", () => {
    expect(() => planRuns(["--watch", coreTest, extensionTest])).toThrow(
      "watch mode with mixed test suites is not supported",
    );
  });
});
