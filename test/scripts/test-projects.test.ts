import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assert, beforeAll, describe, expect, it, vi } from "vitest";
import { listExtensionTestFilesForRoots } from "../../scripts/lib/extension-test-plan.mts";
import {
  readRuntimeWorkerDescriptorReads as readDescriptorUses,
  readTestSelectorSourceFacts as readSourceFacts,
} from "../../scripts/lib/test-selector-source-facts.mts";
import {
  resolveVitestPretestBuildMode as pretestBuildMode,
  resolveVitestRuntimeConfigScopes as runtimeScopes,
} from "../../scripts/lib/vitest-build-prerequisites.mts";
import { resolveDefaultVitestNoOutputTimeoutMs } from "../../scripts/lib/vitest-process-env.mts";
import { resolveVitestRuntimeCliSelections as runtimeSelections } from "../../scripts/lib/vitest-runtime-selection.mts";
import { resolveShardTimingKey } from "../../scripts/lib/vitest-shard-metadata.mts";
import { scriptModuleEntrypoints } from "../../scripts/script-module-runtime.test-support.mjs";
import {
  applyDefaultVitestNoOutputTimeout,
  applyFullExtensionsHeapBudget,
  buildFullSuiteVitestRunPlans as planFullSuite,
  buildVitestRunPlans as planRuns,
  createVitestRunSpecs as runSpecs,
  findUnmatchedExplicitTestTargets as unmatchedTargets,
  hasImportGraphImpactOnTargets as impactsTargets,
  isTestFileTarget,
  orderFullSuiteSpecsForParallelRun,
  parseTestProjectsArgs,
  resolveChangedTestTargetPlanForArgs as changedPlanForArgs,
  resolveChangedTestTargetPlan as changedPlan,
  resolveChangedTargetArgs as changedArgs,
  resolveAffectedTestsFromImportGraph as affectedTests,
  resolveControlUiTestConsumers as uiConsumers,
  resolveDependencyTestConsumers as dependencyConsumers,
  writeVitestIncludeFile,
} from "../../scripts/test-projects.test-support.mts";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../src/infra/runtime-worker-url.js";
import { withEnv } from "../../src/test-utils/env.js";
import { listGitTrackedFiles, toRepoPath } from "../../src/test-utils/repo-files.js";
import { requireNodeTool } from "../helpers/node-toolchain.js";
import { listVitestConfigTestFiles } from "../vitest-projects-config.test-support.js";
import { databaseWorkerCoreTestFiles } from "../vitest/vitest.database-worker-core-paths.mjs";
import { databaseWorkerExtensionTestFiles } from "../vitest/vitest.extension-database-workers-paths.mjs";
import {
  gatewayDatabaseWorkerTestFiles,
  isGatewayServerTestFile,
} from "../vitest/vitest.gateway-server-paths.mjs";
import {
  isSharedVitestExcludedPath,
  matchesVitestCliSelection,
} from "../vitest/vitest.pattern-file.ts";
import { testRunnerFixtureEnv } from "./prepared-script-wrapper.test-support.js";

const repoPath = toRepoPath;
const MATRIX_TEST_PROCESS_FILE_LIMIT = 40;
const TELEGRAM_TEST_PROCESS_FILE_LIMIT = 10;

describe("Windows CI partitions", () => {
  it("keeps explicit coverage disjoint without repeating small project setup", () => {
    const { scripts } = JSON.parse(fs.readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    const [first, second] = [1, 2].map((part) => {
      const command = scripts[`test:windows:ci:${part}`];
      assert(command);
      const entrypoint = "scripts/test-projects.mts ";
      expect(command).toContain(entrypoint);
      const targets = command.slice(command.indexOf(entrypoint) + entrypoint.length).split(/\s+/u);
      expect(targets.every((target) => isTestFileTarget(target))).toBe(true);
      expect(unmatchedTargets(targets)).toEqual([]);
      return {
        targets,
        configs: new Set(runSpecs(targets, { baseEnv: {} }).map((spec) => spec.config)),
      };
    });
    assert(first && second);
    const targets = [...first.targets, ...second.targets];
    expect(new Set(targets).size).toBe(targets.length);
    // Tooling and infra own shared fixtures. Other projects share setup within one part.
    expect([...first.configs].filter((config) => second.configs.has(config))).toEqual([
      configFile("tooling"),
      configFile("infra"),
    ]);
  });
});

describe("test runtime prerequisites", () => {
  const catalogFile = "test/plugins/codex-model-catalog.gateway.test.ts";
  const freshnessFile = "src/gateway/server-methods/models-list.freshness.integration.test.ts";
  const scopedFreshnessFile = "**/models-list.freshness.integration.test.ts";
  it.each([
    ["full-agentic", ["src/gateway/server-sidecar-retention.test.ts"], "runtime"],
    ["full-agentic", ["src/gateway/server-request-context.test.ts"], undefined],
    ["gateway-database-workers", [], "runtime"],
    ["gateway-database-workers", [freshnessFile], "runtime"],
    ["gateway-database-workers", ["models-list.freshness.integration"], "runtime"],
    ["gateway-database-workers", [freshnessFile, "--exclude", scopedFreshnessFile], undefined],
    ["gateway-methods", [catalogFile], undefined],
    ["gateway", [catalogFile, "--exclude", catalogFile], undefined],
    ["bundled", ["--exclude", "src/plugins/loader.test.ts"], undefined],
    ["extensions", ["--exclude", "deepinfra/**"], "runtime"],
    [
      "extensions",
      ["--exclude", "deepinfra/**", "--exclude", "google-meet/**", "--exclude", "file-transfer/**"],
      undefined,
    ],
    ["tui-pty", ["--exclude", "tui/tui-session-identity-pty.e2e.test.ts"], undefined],
    ["tui-pty", ["--exclude", "tui/tui-text-wrap-pty.e2e.test.ts"], "runtime"],
    ["gateway-core", ["--exclude", "gateway-*.test.ts"], "runtime"],
    ["gateway-core", ["--exclude", "gateway*.test.ts"], undefined],
    ["gateway", ["--exclude", "gateway-*.test.ts"], "runtime"],
    ["infra", ["--exclude", "**/gateway-codex-delivery-cache.test.ts"], "runtime"],
    [
      "agents-core",
      runtimeScopes(configFile("agents-core")).flatMap(({ file, dir }) => [
        "--exclude",
        path.posix.relative(dir, file),
      ]),
      undefined,
    ],
  ] as const)("binds %s prerequisites to CLI selection %j", (project, args, expected) => {
    expect(
      pretestBuildMode(
        runtimeSelections(`test/vitest/vitest.${project}.config.ts`, ["run", ...args], {}),
      ),
    ).toBe(expected);
  });

  it.each([
    [
      "gateway-server",
      "src/gateway/server-request-context.test.ts",
      "src/gateway/server-sidecar-retention.test.ts",
    ],
    ["gateway-database-workers", "src/gateway/server-methods/cron.runs.test.ts", freshnessFile],
  ])("projects invocation-owned include files under %s", (project, ordinaryFile, runtimeFile) => {
    const selections = runtimeSelections(`test/vitest/vitest.${project}.config.ts`, ["run"], {});
    for (const selection of selections) {
      selection.includePatterns = [ordinaryFile];
    }
    expect(pretestBuildMode(selections)).toBeUndefined();
    for (const selection of selections) {
      selection.includePatterns = [runtimeFile];
    }
    expect(pretestBuildMode(selections)).toBe("runtime");
  });

  it("combines private QA and runtime readers into one private build", () => {
    expect(
      pretestBuildMode([
        { includePatterns: ["test/e2e/qa-lab/runtime/**/*.test.ts"] },
        { includePatterns: ["extensions/qa-lab/**/*.test.ts"] },
      ]),
    ).toBe("private-qa");
    expect(pretestBuildMode([])).toBeUndefined();
    expect(pretestBuildMode([{ configs: ["test/vitest/vitest.config.ts"] }])).toBe("private-qa");
  });
});

function configFile(project: string) {
  return `test/vitest/vitest.${project}.config.ts`;
}

function testFiles(root: string, names: string) {
  return names.split(" ").map((name) => `${root}/${name}.test.ts`);
}

function selectedTestFiles(plans: readonly { includePatterns: readonly string[] | null }[]) {
  return plans.flatMap((plan) => plan.includePatterns ?? []);
}

function withIncludeFile(patterns: string[], run: (file: string) => void, name = "include.json") {
  withTinyFileTree({ [name]: JSON.stringify(patterns) }, (cwd) => run(path.join(cwd, name)));
}

function gitTree(cwd: string) {
  const tree = spawnSync("git", ["write-tree"], { cwd, encoding: "utf8" });
  expect(tree.status).toBe(0);
  return tree.stdout.trim();
}

function listOrdinaryExtensionFiles(root: string) {
  return listExtensionTestFilesForRoots([root]).filter(
    (file) => !databaseWorkerExtensionTestFiles.includes(file) && !isSharedVitestExcludedPath(file),
  );
}

function expectedTelegramTestProcessCount() {
  const testFileCount = listOrdinaryExtensionFiles("extensions/telegram").length;
  return Math.max(1, Math.ceil(testFileCount / TELEGRAM_TEST_PROCESS_FILE_LIMIT));
}

function withTinyGitRepo(files: Record<string, string>, test: (cwd: string) => void): void {
  withTinyFileTree(files, (cwd) => {
    const init = spawnSync("git", ["init"], { cwd, stdio: "ignore" });
    expect(init.status).toBe(0);
    const add = spawnSync("git", ["add", "."], { cwd, stdio: "ignore" });
    expect(add.status).toBe(0);
    test(cwd);
  });
}

function withTinyFileTree(files: Record<string, string>, test: (cwd: string) => void): void {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-test-projects-"));
  try {
    for (const [file, source] of Object.entries(files)) {
      const absolute = path.join(cwd, file);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, source);
    }
    test(cwd);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function expectChangedTargets(
  changedPaths: string[],
  targets: string[],
  options?: Parameters<typeof changedPlan>[1],
): void {
  expect(changedPlan(changedPaths, options), changedPaths.join(", ")).toEqual({
    mode: "targets",
    targets,
  });
}

function runPlan(
  config: string,
  includePatterns: string[] | null = null,
  forwardedArgs: string[] = [],
) {
  return {
    config: `test/vitest/vitest.${config}.config.ts`,
    includePatterns,
    forwardedArgs,
    watchMode: false,
  };
}

function expectRun(
  actual: ReturnType<typeof planRuns>,
  project: string,
  expected: {
    forwardedArgs?: string[];
    includePatterns?: string[] | null;
    watchMode?: boolean;
  } = {},
): void {
  expect(actual).toEqual([
    {
      config: configFile(project),
      forwardedArgs: expected.forwardedArgs ?? [],
      includePatterns: expected.includePatterns ?? null,
      watchMode: expected.watchMode ?? false,
    },
  ]);
}

describe("scripts/test-projects changed-target routing", () => {
  beforeAll(() => {
    planRuns(["src/commands/onboard-non-interactive.test-helpers.ts"]);
    unmatchedTargets([configFile("shared")], process.cwd());
  });

  it("bounds extensionless prefix probes while excluding deleted cached matches", () => {
    const target = "src/selector/topic";
    const rejectedFiles = [
      "src/other/topic.test.ts",
      "src/selector/topic-other.test.ts",
      "src/selector/topic.helper.ts",
      "src/selector/topic.child/nested.test.ts",
    ];
    const files = Object.fromEntries(
      [`${target}.test.ts`, `${target}.extra.spec.mts`, ...rejectedFiles].map((file) => [file, ""]),
    );
    withTinyGitRepo(files, (tempDir) => {
      const cwd = fs.realpathSync(tempDir);
      const candidatePaths = new Set(Object.keys(files).map((file) => path.join(cwd, file)));
      const rejectedPaths = new Set(rejectedFiles.map((file) => path.join(cwd, file)));
      const candidateProbes: string[] = [];
      const originalExistsSync = fs.existsSync;
      fs.existsSync = (file) => {
        if (typeof file === "string" && candidatePaths.has(file)) {
          candidateProbes.push(file);
        }
        return originalExistsSync(file);
      };
      try {
        const parsed = [
          parseTestProjectsArgs(["--changed", "origin/main"], cwd),
          parseTestProjectsArgs(["--changed", "origin/main"], cwd),
        ];
        for (const result of parsed) {
          expect(result).toStrictEqual({
            forwardedArgs: ["--changed", "origin/main"],
            nonTargetArgs: ["--changed", "origin/main"],
            targetArgs: [],
            watchMode: false,
          });
        }
        expect(candidateProbes).toHaveLength(0);

        expectRun(planRuns([target], cwd), "unit", {
          forwardedArgs: [`${target}.extra.spec.mts`, `${target}.test.ts`],
        });
        expect(unmatchedTargets([target], cwd)).toEqual([]);

        fs.unlinkSync(path.join(cwd, `${target}.extra.spec.mts`));
        expectRun(planRuns([target], cwd), "unit", {
          forwardedArgs: [`${target}.test.ts`],
          includePatterns: [`${target}.test.ts`],
        });
        expect(unmatchedTargets([target], cwd)).toEqual([]);

        fs.unlinkSync(path.join(cwd, `${target}.test.ts`));
        expect(unmatchedTargets([target], cwd)).toEqual([
          {
            target,
            reason: "path-does-not-exist",
            includePattern: `${target}{,.*}.{test,spec}.{js,jsx,ts,tsx,mjs,cjs,mts,cts}`,
          },
        ]);
        expect(candidateProbes.filter((file) => rejectedPaths.has(file))).toHaveLength(0);
      } finally {
        fs.existsSync = originalExistsSync;
      }
    });
  });

  it("skips deleted direct test files in changed mode", () => {
    expect(
      changedArgs(["--changed", "origin/main"], process.cwd(), () => [
        "test/deleted-changed-target.test.ts",
      ]),
    ).toStrictEqual([]);
  });

  it.each<[string[], string[]]>([
    [["src/plugin-sdk/provider-entry.ts"], ["src/plugin-sdk/provider-entry.test.ts"]],
    [["src/plugin-sdk/lazy-value.ts"], testFiles("src/plugin-sdk", "core channel-entry-contract")],
    [
      ["extensions/qa-lab/src/scenario-catalog.test.ts"],
      ["extensions/qa-lab/src/scenario-catalog.test.ts"],
    ],
    [["ui/src/components/markdown.test.ts"], ["ui/src/components/markdown.test.ts"]],
    [["scripts/crabbox-wrapper.mts"], ["test/scripts/crabbox-wrapper.test.ts"]],
    [
      ["scripts/check-composite-action-input-interpolation.py"],
      ["test/scripts/check-composite-action-input-interpolation.test.ts"],
    ],
    [["scripts/check-no-conflict-markers.mjs"], ["test/scripts/check-no-conflict-markers.test.ts"]],
    [
      ["scripts/lib/restart-mac-gateway.sh"],
      testFiles("test/scripts", "build-and-run-mac restart-mac"),
    ],
    [["src/gateway/gateway-codex-harness.live.test.ts"], []],
  ])("retains precise changed owners for %j", (paths, targets) => {
    expectChangedTargets(paths, targets);
  });

  it("discovers conventional nested, dashed and basename script owners for .mts", () => {
    const extension = "mts";
    withTinyFileTree(
      {
        [`scripts/nested/fixture.${extension}`]: "",
        "test/scripts/nested/fixture.test.ts": "",
        "test/scripts/nested-fixture.test.ts": "",
        "test/scripts/fixture.test.ts": "",
        "src/scripts/nested/fixture.test.ts": "",
        "src/scripts/nested-fixture.test.ts": "",
        "src/scripts/fixture.test.ts": "",
        "test/scripts/fixture.live.test.ts": "",
      },
      (cwd) => {
        expectChangedTargets(
          [`scripts/nested/fixture.${extension}`],
          [
            "test/scripts/nested/fixture.test.ts",
            "test/scripts/nested-fixture.test.ts",
            "test/scripts/fixture.test.ts",
            "src/scripts/nested/fixture.test.ts",
            "src/scripts/nested-fixture.test.ts",
            "src/scripts/fixture.test.ts",
          ],
          { cwd },
        );
        expect(changedPlan([`scripts/fixture.${extension}`], { cwd }).targets).toEqual([
          "test/scripts/fixture.test.ts",
          "src/scripts/fixture.test.ts",
        ]);
        expect(changedPlan([`scripts/unowned.${extension}`], { cwd }).targets).toEqual([
          configFile("tooling"),
        ]);
      },
    );
  });

  it("unions semantic workflow owners with bounded direct references", () => {
    withTinyGitRepo(
      {
        ".github/workflows/full-release-validation.yml": "name: FRV\n",
        "test/scripts/full-release-validation-state.test.ts":
          'const workflow = ".github/workflows/full-release-validation.yml";\n',
        "test/scripts/unknown-frv-contract.test.ts":
          'const workflow = ".github/workflows/full-release-validation.yml";\n',
        "test/scripts/unknown-frv-contract.live.test.ts":
          'const workflow = ".github/workflows/full-release-validation.yml";\n',
        "test/scripts/test-projects.test.ts":
          'const workflow = ".github/workflows/full-release-validation.yml";\n',
        "test/scripts/workflow-substring.test.ts":
          'const workflow = ".github/workflows/full-release-validation.yml.bak";\n',
      },
      (cwd) => {
        const targets = changedPlan([".github/workflows/full-release-validation.yml"], {
          cwd,
        }).targets;

        expect(targets).toContain("test/scripts/unknown-frv-contract.test.ts");
        expect(
          targets.filter(
            (target) => target === "test/scripts/full-release-validation-state.test.ts",
          ),
        ).toHaveLength(1);
        expect(targets).not.toContain("test/scripts/unknown-frv-contract.live.test.ts");
        expect(targets).not.toContain("test/scripts/test-projects.test.ts");
        expect(targets).not.toContain("test/scripts/workflow-substring.test.ts");
      },
    );
  });

  it.each([
    {
      changedPath: ".github/workflows/plugin-npm-release.yml",
      exactTargets: testFiles(
        "test/scripts",
        "plugin-npm-extended-stable-workflow plugin-release-git-lifecycle",
      ),
    },
    {
      changedPath: ".github/actions/setup-node-env/action.yml",
      exactTargets: testFiles("test/scripts", "setup-node-env-bun setup-node-env-semantic-memory"),
    },
  ])("unions exact owners and references for $changedPath", ({ changedPath, exactTargets }) => {
    withTinyGitRepo(
      {
        [changedPath]: "name: fixture\n",
        "test/scripts/direct-workflow-reference.test.ts": `const target = "${changedPath}";\n`,
      },
      (cwd) => {
        const targets = changedPlan([changedPath], { cwd }).targets;

        for (const exactTarget of exactTargets) {
          expect(targets).toContain(exactTarget);
        }
        expect(targets).toContain("test/scripts/direct-workflow-reference.test.ts");
        expect(targets).toContain("test/scripts/ci-workflow-guards.test.ts");
      },
    );
  });

  it("does not scan direct references for semantic non-YAML tooling", () => {
    withTinyGitRepo(
      {
        "scripts/pr": "#!/bin/sh\n",
        "test/scripts/direct-tooling-reference.test.ts": 'const target = "scripts/pr";\n',
      },
      (cwd) => {
        const targets = changedPlan(["scripts/pr"], { cwd }).targets;

        expect(targets).not.toContain("test/scripts/direct-tooling-reference.test.ts");
      },
    );
  });

  it("leaves actionlint validation external while retaining config consumers", () => {
    for (const withConsumers of [false, true]) {
      withTinyGitRepo(
        {
          ".github/actionlint.yaml": "self-hosted-runner: {}\n",
          ".github/unknown-lint.yaml": "{}\n",
          ...(withConsumers
            ? {
                "src/lint-config.ts":
                  'export const config = new URL("../.github/actionlint.yaml", import.meta.url);\n',
                "test/scripts/lint-import.test.ts": 'import "../../src/lint-config.js";\n',
                "test/scripts/lint-reader.test.ts": 'const config = ".github/actionlint.yaml";\n',
              }
            : {}),
        },
        (cwd) => {
          expectChangedTargets(
            [".github/actionlint.yaml"],
            withConsumers ? testFiles("test/scripts", "lint-import lint-reader") : [],
            {
              cwd,
              forceFullImportGraph: true,
              resolveAliases: true,
              runtimeOnly: true,
            },
          );
          expect(changedPlan([".github/unknown-lint.yaml"], { cwd }).targets).toEqual([
            configFile("tooling"),
          ]);
        },
      );
    }
  });

  it.each`
    file                                                                       | owner                                 | source                                         | inventory
    ${"src/gateway/server-startup-early.test.ts"}                              | ${"gateway-server"}                   | ${"src/gateway/server-startup-early.ts"}       | ${undefined}
    ${"src/commands/onboarding-plugin-install.test.ts"}                        | ${"commands"}                         | ${"src/commands/onboarding-plugin-install.ts"} | ${undefined}
    ${"src/agents/cli-runner/bundle-mcp.user-config.test.ts"}                  | ${"agents-core-isolated"}             | ${undefined}                                   | ${undefined}
    ${"src/agents/subagents/spawn/subagent-spawn.production-boundary.test.ts"} | ${"agents-spawn-production-boundary"} | ${undefined}                                   | ${undefined}
    ${"src/agents/agent-command-local.test.ts"}                                | ${"cli-process"}                      | ${undefined}                                   | ${undefined}
    ${"src/agents/command/session-store.test.ts"}                              | ${"infra"}                            | ${undefined}                                   | ${databaseWorkerCoreTestFiles}
    ${"src/auto-reply/reply/agent-runner-execution-auth-failures.test.ts"}     | ${"infra"}                            | ${undefined}                                   | ${undefined}
    ${"src/auto-reply/reply/agent-runner-execution-cli-admission.test.ts"}     | ${"infra"}                            | ${undefined}                                   | ${undefined}
  `(
    "routes $file to $owner",
    ({
      file,
      owner,
      source,
      inventory,
    }: {
      file: string;
      owner: string;
      source?: string;
      inventory?: readonly string[];
    }) => {
      expectRun(planRuns([source ?? file]), owner, { includePatterns: [file] });
      if (inventory) {
        expect(inventory.filter((entry) => entry === file)).toEqual([file]);
      }
    },
  );

  it.each<[string[], string[] | null]>([
    [["src/selector/one.test.ts"], ["src/selector/one.test.ts"]],
    [["./src/selector/one.test.ts"], ["src/selector/one.test.ts"]],
    [["src/selector/missing.test.ts"], null],
    [["src/selector/one.spec.ts"], null],
    [["src/selector/*.test.ts"], null],
    [["src/selector/one.test.ts", "src/selector/one.spec.ts"], null],
    [testFiles("src/selector", "one missing"), null],
    [["src/selector/one.live.test.ts"], null],
    [["outside/one.test.ts"], null],
  ])("selects default-unit includes without losing CLI targets: %j", (targets, includePatterns) => {
    withTinyFileTree(
      {
        "src/selector/one.test.ts": "",
        "src/selector/one.spec.ts": "",
        "src/selector/one.live.test.ts": "",
        "outside/one.test.ts": "",
      },
      (cwd) => {
        const filters = includePatterns ? ["-t", "case"] : [];
        expectRun(planRuns([...targets, "--", ...filters], cwd), "unit", {
          forwardedArgs: [...filters, ...targets],
          includePatterns,
        });
      },
    );
  });

  it("preserves absolute and watch default-unit target semantics", () => {
    const target = "src/selector/one.test.ts";
    withTinyFileTree({ [target]: "" }, (cwd) => {
      const absolute = path.join(cwd, target);
      expectRun(planRuns([absolute], cwd), "unit", { forwardedArgs: [absolute] });
      expectRun(planRuns(["--watch", target], cwd), "unit", {
        forwardedArgs: [target],
        watchMode: true,
      });
    });
  });

  it("keeps inherited default-unit include files intersected with the CLI target", () => {
    const target = "src/selector/one.test.ts";
    withTinyFileTree({ [target]: "", "include.json": JSON.stringify([]) }, (cwd) => {
      const includeFile = path.join(cwd, "include.json");
      const [spec] = runSpecs([target], {
        cwd,
        baseEnv: { OPENCLAW_VITEST_INCLUDE_FILE: includeFile },
      });
      expect(spec).toMatchObject({
        config: configFile("unit"),
        includePatterns: null,
        includeFilePath: null,
        env: { OPENCLAW_VITEST_INCLUDE_FILE: includeFile },
      });
      expect(spec?.pnpmArgs.at(-1)).toBe(target);
      expect(fs.readFileSync(includeFile, "utf8")).toBe("[]");
    });
  });

  it.each(["test/scripts/run-node.test.ts", "extensions/matrix/src/matrix/client/storage.test.ts"])(
    "keeps owned include selection independent of missing borrowed metadata: %s",
    (target) => {
      withTinyFileTree({}, (tempDir) => {
        const borrowed = path.join(tempDir, "missing.json");
        const files = Array.from({ length: 2 }, () => {
          const [spec] = runSpecs([target], {
            baseEnv: { OPENCLAW_VITEST_INCLUDE_FILE: borrowed },
          });
          expect(spec?.includePatterns).toEqual([target]);
          assert(spec?.includeFilePath);
          expect(path.dirname(spec.includeFilePath)).toBe(os.tmpdir());
          expect(spec.env.OPENCLAW_VITEST_INCLUDE_FILE).toBe(spec.includeFilePath);
          expect(spec.includeFilePath).not.toBe(borrowed);
          return spec.includeFilePath;
        });
        expect(files[0]).not.toBe(files[1]);
        expect(fs.existsSync(borrowed)).toBe(false);
      });
    },
  );

  it.each([
    { name: "Git inventory", withRepo: withTinyGitRepo },
    { name: "filesystem inventory", withRepo: withTinyFileTree },
  ])(
    "attributes runtime-worker fixtures to their executing descriptor readers ($name)",
    ({ withRepo }) => {
      const aggregator = "src/workers/entrypoints.test-support.ts";
      const dep = "src/workers/fixtures/dep-a.ts";
      const readerA = "src/workers/read-a.test.ts";
      const readerAll = "src/workers/read-all.test.ts";
      const readerB = "src/workers/read-b.test.ts";
      const readerSingle = "src/workers/read-single.test.ts";
      const readerSingleChild = "src/workers/read-single-child.test.ts";
      const readerInline = "src/workers/read-inline.test.ts";
      const readerManifest = "test/scripts/manifest.test.ts";
      const expected = [readerA, readerAll];
      withRepo(
        {
          [aggregator]: `export const group = {
  a: { currentModuleUrl: import.meta.url, sourceWorkerName: "fixtures/a.test-support" },
  b: { sourceWorkerName: "fixtures/b.test-support", currentModuleUrl: import.meta.url },
} as const;
export const single = {
  currentModuleUrl: import.meta.url, sourceWorkerName: "fixtures/single.test-support",
  child: { currentModuleUrl: import.meta.url, sourceWorkerName: "fixtures/b.test-support" },
} as const;`,
          "src/workers/fixtures/a.test-support.ts": 'import "./dep-a.js";',
          "src/workers/fixtures/b.test-support.ts": 'import "./dep-b.js";',
          "src/workers/fixtures/single.test-support.ts": 'import "./dep-single.js";',
          "src/workers/fixtures/inline.test-support.ts": 'import "./dep-inline.js";',
          [dep]: "export {};",
          "src/workers/fixtures/dep-b.ts": "export {};",
          "src/workers/fixtures/dep-single.ts": "export {};",
          "src/workers/fixtures/dep-inline.ts": "export {};",
          [readerA]:
            'import { group as workers } from "./entrypoints.test-support.js"; void workers.a;',
          [readerB]: 'import { group } from "./entrypoints.test-support.js"; void group.b;',
          [readerAll]:
            'import { group } from "./entrypoints.test-support.js"; Object.values(group);',
          [readerSingle]:
            'import { single } from "./entrypoints.test-support.js"; void single.distWorkerPath;',
          [readerSingleChild]:
            'import { single } from "./entrypoints.test-support.js"; void single.child;',
          [readerInline]: `const worker = {
  currentModuleUrl: import.meta.url, sourceWorkerName: "fixtures/inline.test-support",
}; void worker;`,
          "scripts/lib/manifest.mts":
            'import { group } from "../../src/workers/entrypoints.test-support.js"; Object.values(group);',
          [readerManifest]: 'import "../../scripts/lib/manifest.mjs";',
        },
        (cwd) => {
          const options = { tooling: true, resolveAliases: true, runtimeOnly: true };
          // The aggregator may already be visited when its executing consumer is reached.
          expect(impactsTargets([dep], [aggregator, readerA], cwd, options)).toBe(true);
          expect(impactsTargets([dep], [readerAll], cwd, options)).toBe(true);
          for (const unrelated of [
            readerB,
            readerSingle,
            readerSingleChild,
            readerInline,
            readerManifest,
          ]) {
            expect(impactsTargets([dep], [unrelated], cwd, options), unrelated).toBe(false);
          }
          expectChangedTargets([dep], expected, { cwd, broad: true });
          expect(affectedTests([dep], cwd, { ...options, forceFull: true })).toEqual(expected);
          for (const [dependency, reader] of [
            ["dep-b", readerB],
            ["dep-single", readerSingle],
            ["dep-inline", readerInline],
          ] satisfies [string, string][]) {
            expect(
              affectedTests([`src/workers/fixtures/${dependency}.ts`], cwd, {
                ...options,
                forceFull: true,
              }),
            ).toEqual(
              dependency === "dep-b"
                ? [readerAll, reader, readerSingleChild].toSorted((left, right) =>
                    left.localeCompare(right),
                  )
                : [reader],
            );
          }
        },
      );
    },
  );

  it.each<[string, boolean]>([
    ["tooling", false],
    ["tooling", true],
    ["extension-database-workers", false],
  ])(
    "preserves owned files and inherited directory selection for %s (directory first: %s)",
    (config, directoryFirst) => {
      const worker = config === "extension-database-workers";
      const owned = worker
        ? "extensions/matrix/src/matrix/client/storage.test.ts"
        : "test/scripts/run-node.test.ts";
      const selected = worker
        ? "extensions/matrix/src/matrix/sdk/idb-persistence.test.ts"
        : "test/helpers/temp-dir.test.ts";
      const directory = worker ? "extensions/matrix/src/matrix/sdk" : "test/helpers";
      withIncludeFile([selected], (borrowed) => {
        const args = directoryFirst ? [directory, owned] : [owned, directory];
        const specs = runSpecs(args, {
          baseEnv: { OPENCLAW_VITEST_INCLUDE_FILE: borrowed },
        });
        const spec = specs.find(
          (entry) => entry.config === `test/vitest/vitest.${config}.config.ts`,
        );
        const expected = directoryFirst ? [selected, owned] : [owned, selected];
        expect(worker ? spec?.includePatterns?.toSorted() : spec?.includePatterns).toEqual(
          worker ? expected.toSorted() : expected,
        );
        expect(fs.readFileSync(borrowed, "utf8")).toBe(JSON.stringify([selected]));
      });
    },
  );

  it("preserves Git membership for large changed and explicit test inventories", () => {
    withTinyGitRepo(
      {
        ".gitignore": "src/runtime.ignored.test.ts\n",
        "src/runtime.ts": "export const value = 1;\n",
        "src/runtime.consumer.test.ts": 'import "./runtime.js";\n',
      },
      (cwd) => {
        // Index-only padding reproduces a large checkout without thousands of fixture files.
        const blob = spawnSync("git", ["hash-object", "-w", "--stdin"], {
          cwd,
          encoding: "utf8",
          input: "",
        });
        expect(blob.status).toBe(0);
        const padding = Array.from(
          { length: 6_000 },
          (_, index) =>
            `100644 ${blob.stdout.trim()}\tsrc/padding/${index}-${"x".repeat(190)}.ts\n`,
        ).join("");
        const indexed = spawnSync("git", ["update-index", "--index-info"], {
          cwd,
          input: padding,
        });
        expect(indexed.status).toBe(0);
        for (const root of ["extensions", "packages", "ui/src", "ui/config", "test"]) {
          fs.mkdirSync(path.join(cwd, root), { recursive: true });
        }
        fs.writeFileSync(
          path.join(cwd, "src/runtime.untracked.test.ts"),
          'import "./runtime.js";\n',
        );
        fs.writeFileSync(path.join(cwd, "src/runtime.ignored.test.ts"), 'import "./runtime.js";\n');

        expect(changedPlan(["src/runtime.ts"], { cwd }).targets).toEqual([
          "src/runtime.consumer.test.ts",
        ]);
        const includeFile = path.join(cwd, "include.json");
        writeVitestIncludeFile(includeFile, ["src/**/*.test.ts"], { cwd });
        expect(JSON.parse(fs.readFileSync(includeFile, "utf8")).toSorted()).toEqual(
          testFiles("src", "runtime.consumer runtime.untracked"),
        );
      },
    );
  });

  it("follows converging import frontiers without crossing test boundaries", () => {
    withTinyGitRepo(
      {
        "src/value.ts": 'export * from "./left/bridge.js";\n',
        "src/left/bridge.ts": 'export\n * from\n "../value.js";\n',
        "src/right/bridge.ts": 'export * from "../value.js";\n',
        "src/other/bridge.ts": "export const unrelated = 1;\n",
        "src/combined.consumer.test.ts":
          'import\u00a0"./left/bridge.js";\nimport(\n"./right/bridge.js"\n);\n',
        "src/right.consumer.test.ts": 'import "./right/bridge.js";\n',
        "src/other.consumer.test.ts": 'import "./other/bridge.js";\n',
        "src/after-test.consumer.test.ts": 'import "./combined.consumer.test.js";\n',
        "src/value.consumer.live.test.ts": 'import "./value.js";\n',
      },
      (cwd) => {
        expect(changedPlan(["src/value.ts"], { cwd }).targets).toEqual(
          testFiles("src", "combined.consumer right.consumer"),
        );
      },
    );
  });

  it("bounds direct importer queries to one edge and retains edited tests", () => {
    withTinyGitRepo(
      {
        "src/value.ts": "export const value = 1;\n",
        "src/direct.test.ts": 'import "./value.js";\n',
        "src/bridge.ts": 'export * from "./value.js";\n',
        "src/indirect.test.ts": 'import "./bridge.js";\n',
        "src/shared.test.ts": "export const fixture = 1;\n",
        "src/shared-consumer.test.ts": 'import "./shared.test.js";\n',
      },
      (cwd) => {
        for (const changed of ["src/value.ts", ["src/value.ts"]]) {
          expect(affectedTests(changed, cwd, { direct: true })).toEqual(["src/direct.test.ts"]);
        }
        expect(affectedTests(["src/shared.test.ts"], cwd, { direct: true })).toEqual(
          testFiles("src", "shared-consumer shared"),
        );
        expect(
          impactsTargets(["src/value.ts"], ["src/direct.test.ts"], cwd, {
            direct: true,
          }),
        ).toBe(true);
        expect(
          impactsTargets(["src/value.ts"], ["src/indirect.test.ts"], cwd, {
            direct: true,
          }),
        ).toBe(false);
        expect(impactsTargets(["src/value.ts"], ["src/indirect.test.ts"], cwd)).toBe(true);
      },
    );
  });

  it("retains configured Vitest setup, runner, and environment consumers", () => {
    withTinyGitRepo(
      {
        [configFile("shared")]: `
          import "./vitest.extension-config.ts";
          const runnerPath = path.join(repoRoot, "test", "runner.ts",);
          export const config = {
            setupFiles: [resolveRepoRootPath("test/setup.ts")],
            globalSetup: [resolveRepoRootPath("test/global-setup.ts")],
            runner: runnerPath,
            include: ["src/unrelated.test.ts"],
          };`,
        "test/vitest/vitest.extension-config.ts": `
          export const createConfig = () => ({ setupFiles: ["test/extension-setup.ts"] });`,
        [configFile("ui")]: `
          import type { DOMWindow } from "jsdom";
          import "./vitest.shared.config.ts";
          export default { environment: "jsdom", setupFiles: ["ui/src/setup.ts"] };`,
        "ui/vitest.config.ts": `
          const nodeSetupFiles = ["./src/setup.ts"];
          export default { environment: "jsdom", setupFiles: nodeSetupFiles };`,
        "test/setup.ts": 'import "./helper.ts";',
        "test/helper.ts": "export const helper = true;",
        "test/runner.ts": 'import "./runner-helper.ts";',
        "test/runner-helper.ts": "export const runnerHelper = true;",
        "test/global-setup.ts": 'import "./global-helper.ts";',
        "test/global-helper.ts": "export const globalHelper = true;",
        "test/extension-setup.ts": 'import "./extension-helper.ts";',
        "test/extension-helper.ts": "export const extensionHelper = true;",
        "ui/src/setup.ts": 'import "./setup-helper.ts";',
        "ui/src/setup-helper.ts": "export const uiSetup = true;",
        "ui/src/component.test.ts": 'import "jsdom";',
        "src/unrelated.test.ts": "export const unrelated = true;",
      },
      (cwd) => {
        const options = { tooling: true, resolveAliases: true, runtimeOnly: true };
        for (const helper of [
          "test/helper.ts",
          "test/runner-helper.ts",
          "test/global-helper.ts",
          "test/extension-helper.ts",
        ]) {
          expect(impactsTargets([helper], [configFile("ui")], cwd, options), helper).toBe(true);
        }
        expect(
          impactsTargets(["ui/src/setup-helper.ts"], ["ui/vitest.config.ts"], cwd, options),
        ).toBe(true);
        expect(impactsTargets(["src/unrelated.test.ts"], [configFile("ui")], cwd, options)).toBe(
          false,
        );
        const consumers = dependencyConsumers([{ root: ".", dependencies: ["jsdom"] }], cwd, {
          runtimeOnly: true,
        });
        expect(consumers.unresolved).toEqual([]);
        expect(consumers.sources.toSorted()).toEqual([
          configFile("ui"),
          "ui/src/component.test.ts",
          "ui/vitest.config.ts",
        ]);
      },
    );
  });

  it("follows source aliases and package exports through shared test consumers for CI", () => {
    withTinyGitRepo(
      {
        "tsconfig.json": JSON.stringify({
          compilerOptions: {
            paths: {
              "openclaw/plugin-sdk/*": ["./src/plugin-sdk/*.ts"],
              "@openclaw/library/*": ["./packages/library/src/*.ts"],
              "@test-fixture/*": ["./test/fixtures/*/index.test.ts"],
            },
          },
        }),
        "packages/library/package.json": JSON.stringify({
          name: "@openclaw/library",
          exports: {
            ".": { default: "./src/index.ts" },
            "./test-entry": { import: "./src/import.test.ts", require: "./src/require.test.ts" },
          },
        }),
        "src/value.ts": "export const value = 1;\n",
        "src/native-helper.js": 'export * from "./value.js";\n',
        "src/script-consumer.test.ts": 'import "./native-helper.js";\n',
        "src/plugin-sdk/public.ts": 'export * from "../value.js";\n',
        "packages/library/src/index.ts": 'export * from "openclaw/plugin-sdk/public";\n',
        "packages/library/src/other.ts": "export const unrelated = 1;\n",
        "packages/library/src/import.test.ts": "export const importValue = 1;\n",
        "packages/library/src/require.test.ts": "export const requireValue = 1;\n",
        "test/fixtures/owner/index.test.ts": "export const value = 1;\n",
        "extensions/consumer/conditional.test.ts": 'import "@openclaw/library/test-entry";\n',
        "extensions/consumer/fixture.test.ts": 'import "@test-fixture/owner";\n',
        "extensions/consumer/shared.test.ts": 'import "@openclaw/library";\n',
        "extensions/consumer/downstream.test.ts": 'import "./shared.test.js";\n',
        "extensions/consumer/direct.test.ts": 'require("openclaw/plugin-sdk/public");\n',
        "extensions/consumer/type-only.test.ts":
          'import type { value } from "openclaw/plugin-sdk/public";\n',
        "extensions/consumer/other.test.ts": 'import "@openclaw/library/other";\n',
      },
      (cwd) => {
        const expected = testFiles("extensions/consumer", "direct downstream shared");
        expect(affectedTests(["src/value.ts"], cwd)).toEqual([]);
        expect(affectedTests(["src/value.ts"], cwd, { resolveAliases: true })).toEqual([
          ...expected,
          "extensions/consumer/type-only.test.ts",
        ]);
        expect(
          affectedTests(["src/value.ts"], cwd, {
            resolveAliases: true,
            runtimeOnly: true,
          }),
        ).toEqual(expected);
        expect(
          affectedTests(["extensions/consumer/shared.test.ts"], cwd, {
            resolveAliases: true,
            forceFull: true,
          }),
        ).toEqual(["extensions/consumer/downstream.test.ts"]);
        expect(
          affectedTests(["packages/library/src/other.ts"], cwd, {
            resolveAliases: true,
          }),
        ).toEqual(["extensions/consumer/other.test.ts"]);
        for (const target of testFiles("packages/library/src", "import require")) {
          expect(
            affectedTests([target], cwd, {
              resolveAliases: true,
              forceFull: true,
            }),
          ).toEqual(["extensions/consumer/conditional.test.ts"]);
        }
        expect(
          affectedTests(["test/fixtures/owner/index.test.ts"], cwd, {
            resolveAliases: true,
            forceFull: true,
          }),
        ).toEqual(["extensions/consumer/fixture.test.ts"]);
        expect(affectedTests("src/value.ts", cwd, { tooling: true })).toEqual([
          "src/script-consumer.test.ts",
        ]);
        expect(
          affectedTests(["src/value.ts"], cwd, {
            tooling: true,
            resolveAliases: true,
            runtimeOnly: true,
          }),
        ).toEqual([...expected, "src/script-consumer.test.ts"]);
        fs.unlinkSync(path.join(cwd, "extensions/consumer/shared.test.ts"));
        expect(
          affectedTests(["extensions/consumer/shared.test.ts"], cwd, {
            resolveAliases: true,
            forceFull: true,
          }),
        ).toEqual(["extensions/consumer/downstream.test.ts"]);
      },
    );
  });

  it("retains import consumers after a changed source is removed from the index", () => {
    withTinyGitRepo({ "src/consumer.test.ts": 'export * from "./removed.js";\n' }, (cwd) => {
      expect(
        affectedTests(["src/removed.ts"], cwd, {
          resolveAliases: true,
        }),
      ).toEqual(["src/consumer.test.ts"]);
    });
  });

  it("routes changed resolved dependencies through scoped bare and subpath consumers", () => {
    withTinyGitRepo(
      {
        "src/root.ts": 'import "dependency/runtime"; import "second-dependency";\n',
        "src/type-owner.ts":
          'import type { Shape } from "types-only"; export type Callback = <T>(value: T) => T;\n',
        "src/root.test.ts": 'import "./root.js";\n',
        "extensions/consumer/source.ts": 'require("dependency");\n',
        "extensions/consumer/source.test.ts": 'import "./source.js";\n',
        "extensions/consumer/direct.test.ts": 'import("dependency/entry");\n',
        "extensions/consumer/other.test.ts": 'import "dependency-other";\n',
        "test/scripts/tool.test.ts":
          'require.resolve("dependency"); import.meta.resolve("dependency/runtime");\n',
        "test/scripts/generated-cli.test.ts": 'spawnSync("node_modules/.bin/opaque-cli", []);\n',
        "ui/src/element-view.tsx":
          'export const view = <><span></span><Lazy load={() => import("dependency")} /></>;\n',
        "ui/src/element-view.test.ts": 'import "./element-view.js";\n',
        "ui/src/text-view.tsx":
          'export const view = <div> // inline text {import("dependency")} </div>;\n',
        "ui/src/text-view.test.ts": 'import "./text-view.js";\n',
      },
      (cwd) => {
        expect(
          dependencyConsumers([{ root: "extensions/consumer", dependencies: ["dependency"] }], cwd)
            .tests,
        ).toEqual(testFiles("extensions/consumer", "direct source"));
        const root = dependencyConsumers([{ root: ".", dependencies: ["dependency"] }], cwd);
        expect(root.sources.toSorted()).toEqual([
          "extensions/consumer/direct.test.ts",
          "extensions/consumer/source.ts",
          "src/root.ts",
          "test/scripts/tool.test.ts",
          "ui/src/element-view.tsx",
          "ui/src/text-view.tsx",
        ]);
        expect(root.tests).toEqual([
          "extensions/consumer/direct.test.ts",
          "extensions/consumer/source.test.ts",
          "src/root.test.ts",
          "test/scripts/tool.test.ts",
          "ui/src/element-view.test.ts",
          "ui/src/text-view.test.ts",
        ]);
        expect(root.unresolved).toEqual([]);
        const mixed = dependencyConsumers(
          [
            {
              root: ".",
              dependencies: ["dependency", "second-dependency", "opaque-cli", "types-only"],
            },
          ],
          cwd,
          { runtimeOnly: true },
        );
        expect(mixed.tests).toEqual(root.tests);
        expect(mixed.unresolved).toEqual([{ root: ".", dependency: "opaque-cli" }]);
        expect(
          dependencyConsumers([{ root: ".", dependencies: ["types-only"] }], cwd, {
            runtimeOnly: true,
          }),
        ).toEqual({
          sources: [],
          tests: [],
          unresolved: [],
        });
      },
    );
  });

  it("keeps root dependency changes behind nearer unchanged workspace bindings", () => {
    withTinyGitRepo(
      {
        "src/root.test.ts": 'import "dependency";\n',
        "ui/src/own.test.ts": 'import "dependency/subpath";\n',
        "ui/src/shadowed.test.ts": 'import "workspace-only";\n',
        "packages/own/src/value.ts": 'require("dependency");\n',
        "packages/own/src/value.test.ts": 'import "./value.js";\n',
        "src/package-consumer.test.ts": 'import "../packages/own/src/value.js";\n',
        "extensions/own/value.test.ts": 'import "dependency";\n',
        "extensions/undeclared/value.test.ts": 'import "dependency";\n',
      },
      (cwd) => {
        const importerBindings = [".", "ui", "packages/own", "extensions/own"].map((root) => ({
          root,
          dependencies: root === "ui" ? ["dependency", "workspace-only"] : ["dependency"],
        }));
        expect(
          dependencyConsumers([{ root: ".", dependencies: ["dependency"] }], cwd, {
            importerBindings,
          }).tests,
        ).toEqual(["extensions/undeclared/value.test.ts", "src/root.test.ts"]);
        expect(
          dependencyConsumers([{ root: "packages/own", dependencies: ["dependency"] }], cwd, {
            importerBindings,
          }).tests,
        ).toEqual(["packages/own/src/value.test.ts", "src/package-consumer.test.ts"]);
        expect(
          dependencyConsumers([{ root: "ui", dependencies: ["dependency"] }], cwd, {
            importerBindings: importerBindings.filter(({ root }) => root !== "ui"),
          }).tests,
        ).toEqual(["ui/src/own.test.ts"]);
        expect(
          dependencyConsumers([{ root: ".", dependencies: ["workspace-only"] }], cwd, {
            importerBindings,
          }).unresolved,
        ).toEqual([{ root: ".", dependency: "workspace-only" }]);
        expect(
          dependencyConsumers([{ root: "ui", dependencies: ["workspace-only"] }], cwd, {
            importerBindings,
          }).unresolved,
        ).toEqual([]);
      },
    );
  });

  it.each([false, true])(
    "keeps broad-name consumers complete without synchronous source opens (narrow importer: %s)",
    (includeNarrowImporter) => {
      const files: Record<string, string> = {
        "src/owner/value.ts": "export const value = 1;\n",
        "src/owner/barrel.ts": 'export\n { value } from\n "./value.js";\n',
        "src/owner/directory/index.ts": 'export * from "../barrel.js";\n',
        "src/owner/consumer.test.ts": 'import(\n "./directory"\n);\n',
        "src/owner/type.consumer.test.ts": 'import type {\n Value\n } from "./value.js";\n',
        "src/owner/deleted.test.ts": 'import "./value.js";\n',
        "src/owner/value.live.test.ts": 'import "./value.js";\n',
      };
      if (includeNarrowImporter) {
        files["src/outside.consumer.test.ts"] = 'import "./owner/value.js";\n';
      }
      // A narrow path match must not hide consumers of a widely occurring basename.
      for (let index = 0; index < 801; index += 1) {
        files[`src/padding/${index}.ts`] = "// value\n";
      }
      withTinyGitRepo(files, (cwd) => {
        fs.unlinkSync(path.join(cwd, "src/owner/deleted.test.ts"));
        fs.writeFileSync(path.join(cwd, "src/owner/untracked.test.ts"), 'import "./value.js";\n');
        const reads = vi.spyOn(fs, "readFileSync");
        try {
          const expectedTargets = [
            ...(includeNarrowImporter ? ["src/outside.consumer.test.ts"] : []),
            "src/owner/consumer.test.ts",
            "src/owner/type.consumer.test.ts",
          ];
          expect(
            changedPlan(["src/owner/value.ts"], { cwd }).targets,
            "initial owner selection",
          ).toEqual(expectedTargets);
          expect(
            changedPlan(["src/owner/value.ts"], { cwd }).targets,
            "cached owner selection",
          ).toEqual(expectedTargets);
          expect(
            reads.mock.calls.filter(([file]) => typeof file === "string" && file.startsWith(cwd)),
          ).toEqual([]);
        } finally {
          reads.mockRestore();
        }
      });
    },
  );

  it.each([
    { name: "Git inventory", withRepo: withTinyGitRepo },
    { name: "filesystem inventory", withRepo: withTinyFileTree },
  ])(
    "keeps tooling imports direct while preserving literal file references ($name)",
    ({ withRepo }) => {
      const files: Record<string, string> = {
        "tsconfig.json": JSON.stringify({
          compilerOptions: { paths: { "@fixture/tool": ["./scripts/fixture-bridge.mts"] } },
        }),
        "scripts/fixture-source.mts": "export const value = 1;\n",
        "scripts/fixture-data.json": '{"value":1}\n',
        "scripts/no-direct-owner.mts": "export const other = 1;\n",
        "scripts/fixture-bridge.mts":
          'import data from "./fixture-data.json" with { type: "json" }; export { data }; export * from "./fixture-source.mjs"; export * from "./no-direct-owner.mjs";\n',
        "test/scripts/alias.consumer.test.ts": 'import "@fixture/tool";\n',
        "test/scripts/direct.consumer.test.ts": 'import "../../scripts/fixture-source.mjs";\n',
        "test/scripts/type.consumer.test.ts":
          'import type { Value } from "../../scripts/fixture-source.mjs";\n',
        "test/scripts/transitive.consumer.test.ts": 'import "../../scripts/fixture-bridge.mjs";\n',
        "test/scripts/literal.consumer.test.ts": 'const fixture = "scripts/fixture-source.mts";\n',
        "test/scripts/substring.consumer.test.ts":
          'const fixture = "scripts/fixture-source.mts.bak";\n',
      };
      for (let index = 0; index < 801; index += 1) {
        files[`src/padding/${index}.ts`] = "// scripts/fixture-source\n";
      }
      withRepo(files, (cwd) => {
        expect(changedPlan(["scripts/fixture-source.mts"], { cwd }).targets).toEqual(
          testFiles("test/scripts", "direct.consumer type.consumer literal.consumer"),
        );
        const ciOptions = {
          cwd,
          forceFullImportGraph: true,
          resolveAliases: true,
          runtimeOnly: true,
        };
        expect(changedPlan(["scripts/fixture-source.mts"], ciOptions).targets).toEqual(
          testFiles(
            "test/scripts",
            "alias.consumer direct.consumer transitive.consumer literal.consumer",
          ),
        );
        expect(changedPlan(["scripts/no-direct-owner.mts"], { cwd }).targets).toEqual([
          configFile("tooling"),
        ]);
        expect(changedPlan(["scripts/no-direct-owner.mts"], ciOptions).targets).toEqual(
          testFiles("test/scripts", "alias.consumer transitive.consumer"),
        );
        expect(changedPlan(["scripts/fixture-data.json"], { cwd }).targets).toEqual([
          configFile("tooling"),
        ]);
        expect(changedPlan(["scripts/fixture-data.json"], ciOptions).targets).toEqual(
          testFiles("test/scripts", "alias.consumer transitive.consumer"),
        );
      });
    },
  );

  it.each([
    { name: "Git inventory", withRepo: withTinyGitRepo },
    { name: "filesystem inventory", withRepo: withTinyFileTree },
  ])("routes test helper and file-URL fixture consumers completely ($name)", ({ withRepo }) => {
    const fixture = "test/scripts/fixtures/worker.mjs";
    const helper = "test/scripts/runtime.test-support.ts";
    const direct = "test/scripts/direct.consumer.test.ts";
    const indirect = "test/scripts/indirect.consumer.test.ts";
    const opaque = "test/scripts/opaque/index.mjs";
    const explicitHelper = "test/scripts/source/input.test-support.ts";
    const explicitConsumer = "test/scripts/outer/consumer.test.ts";
    withRepo(
      {
        [fixture]: "export {};\n",
        [helper]:
          'export const worker = new URL("./fixtures/worker.mjs?generation=1#child", import.meta.url);\n',
        "test/scripts/bridge.test-support.ts": 'export * from "./runtime.test-support.js";\n',
        [direct]: 'import "./runtime.test-support.js";\n',
        [indirect]: 'import "./bridge.test-support.js";\n',
        "test/scripts/after-test.consumer.test.ts": 'import "./direct.consumer.test.js";\n',
        "test/scripts/unrelated.consumer.test.ts": "export {};\n",
        "test/scripts/live.consumer.live.test.ts": 'import "./runtime.test-support.js";\n',
        [opaque]: "export {};\n",
        "test/scripts/literal.opaque.consumer.test.ts": `const fixture = "${opaque}";\n`,
        "test/scripts/relative.opaque.consumer.test.ts": 'import "./opaque/index.mjs";\n',
        [explicitHelper]: "export const value = 1;\n",
        "test/scripts/bridge/index.ts": 'export * from "../source/input.test-support.js";\n',
        [explicitConsumer]: 'import "../bridge/index.js";\n',
      },
      (cwd) => {
        const options = { cwd, broad: true, forceFullImportGraph: true };
        for (const changed of [fixture, helper]) {
          expectChangedTargets([changed], [direct, indirect], { cwd, broad: true });
          expectChangedTargets(
            [changed],
            ["test/scripts/after-test.consumer.test.ts", direct, indirect],
            options,
          );
        }
        // A literal reference alone cannot prove an opaque helper's complete frontier.
        expectChangedTargets([opaque, direct], [opaque, direct], { cwd, broad: true });
        expectChangedTargets(
          [opaque, direct],
          [
            "test/scripts/relative.opaque.consumer.test.ts",
            "test/scripts/literal.opaque.consumer.test.ts",
            direct,
          ],
          options,
        );
        expect(planRuns([explicitHelper], cwd)).toEqual([runPlan("tooling", [explicitConsumer])]);
      },
    );
  });

  it.each([false, true])(
    "retains an unowned changed tooling test alongside its consumers (mixed input: %s)",
    (mixedInput) => {
      const changedTest = "test/e2e/qa-lab/runtime/changed-tooling.test.ts";
      const reader = "test/scripts/tooling-reader.test.ts";
      const otherTest = "src/independent.test.ts";
      withTinyGitRepo(
        {
          [changedTest]: "export const value = 1;\n",
          [reader]:
            'import "../e2e/qa-lab/runtime/changed-tooling.test.js";\n' +
            `const fixture = "${changedTest}";\n`,
          [otherTest]: "export const independent = true;\n",
        },
        (cwd) => {
          const inputs = mixedInput ? [changedTest, otherTest, changedTest] : [changedTest];
          expectChangedTargets(inputs, [changedTest, reader, ...(mixedInput ? [otherTest] : [])], {
            cwd,
          });
        },
      );
    },
  );

  it.each([
    {
      changedPath: "scripts/unowned-source.mts",
      expectedTargets: ["test/scripts/tooling-reader.test.ts"],
    },
    {
      changedPath: "test/scripts/owned.test.ts",
      expectedTargets: ["test/scripts/owned.test.ts"],
    },
    {
      changedPath: "test/e2e/qa-lab/runtime/changed-tooling.live.test.ts",
      expectedTargets: ["test/scripts/tooling-reader.test.ts"],
    },
  ])(
    "preserves non-test, explicit-owner, and live selection for $changedPath",
    ({ changedPath, expectedTargets }) => {
      withTinyGitRepo(
        {
          [changedPath]: "export const value = 1;\n",
          "test/scripts/tooling-reader.test.ts": `const fixture = "${changedPath}";\n`,
        },
        (cwd) => {
          expectChangedTargets([changedPath], expectedTargets, { cwd });
        },
      );
    },
  );

  it.each([
    { count: 2, withRepo: withTinyGitRepo },
    { count: 13, withRepo: withTinyFileTree },
  ])("deduplicates import-graph owners of $count explicit source files", ({ count, withRepo }) => {
    const files: Record<string, string> = {};
    const imports: string[] = [];
    const refs: string[] = [];
    for (let index = 0; index < count; index += 1) {
      files[`src/runtime-${index}.ts`] = `export const value${index} = ${index};\n`;
      imports.push(`import { value${index} } from './runtime-${index}.js';`);
      refs.push(`value${index}`);
    }
    files["src/runtime.consumer.test.ts"] = `${imports.join("\n")}\nvoid [${refs.join(", ")}];\n`;

    withRepo(files, (cwd) => {
      expectRun(
        planRuns(
          Array.from({ length: count }, (_, index) => `src/runtime-${index}.ts`),
          cwd,
        ),
        "unit",
        {
          forwardedArgs: ["src/runtime.consumer.test.ts"],
          includePatterns: ["src/runtime.consumer.test.ts"],
        },
      );
    });
  });

  it.each`
    args                                                                            | owner               | watchMode | env                                         | inheritedProjectShards
    ${["src/gateway/server.health.test.ts"]}                                        | ${"gateway-server"} | ${false}  | ${undefined}                                | ${undefined}
    ${["--watch", "src/gateway/server.health.test.ts"]}                             | ${"gateway"}        | ${true}   | ${undefined}                                | ${undefined}
    ${testFiles("src/gateway", "server.health call")}                               | ${"gateway"}        | ${false}  | ${undefined}                                | ${undefined}
    ${["--watch", "src/gateway/server.health.test.ts", "src/gateway/call.test.ts"]} | ${"gateway"}        | ${true}   | ${undefined}                                | ${undefined}
    ${["src/gateway/server.health.test.ts"]}                                        | ${"gateway"}        | ${false}  | ${{ OPENCLAW_GATEWAY_PROJECT_SHARDS: "0" }} | ${undefined}
    ${["src/gateway/server.health.test.ts"]}                                        | ${"gateway"}        | ${false}  | ${undefined}                                | ${"0"}
    ${["src/gateway/server.health.test.ts"]}                                        | ${"gateway-server"} | ${false}  | ${{ OPENCLAW_GATEWAY_PROJECT_SHARDS: "1" }} | ${"0"}
    ${[configFile("gateway-server")]}                                               | ${"gateway-server"} | ${false}  | ${{ OPENCLAW_GATEWAY_PROJECT_SHARDS: "0" }} | ${undefined}
  `(
    "keeps exact Gateway server files on their $owner owner for $args",
    ({
      args,
      owner,
      watchMode,
      env,
      inheritedProjectShards,
    }: {
      args: string[];
      owner: string;
      watchMode: boolean;
      env?: NodeJS.ProcessEnv;
      inheritedProjectShards?: string;
    }) => {
      withEnv({ OPENCLAW_GATEWAY_PROJECT_SHARDS: inheritedProjectShards }, () => {
        expectRun(
          planRuns(args, process.cwd(), () => [], { env }),
          owner,
          {
            includePatterns: args.some((arg) => arg.endsWith(".config.ts"))
              ? null
              : args.filter((arg) => arg !== "--watch"),
            watchMode,
          },
        );
      });
    },
  );

  it.each(
    ["src/gateway", "src/gateway/**/*.test.ts"].flatMap((target) =>
      ["alone", "worker-first", "aggregate-first"].map((order) => ({ target, order })),
    ),
  )(
    "keeps Gateway database consumers in the aggregate for $target ($order)",
    ({ target, order }) => {
      const [workerFile] = gatewayDatabaseWorkerTestFiles;
      assert(workerFile);
      const targets =
        order === "alone"
          ? [target]
          : order === "worker-first"
            ? [workerFile, target]
            : [target, workerFile];
      const forwardedArgs = ["--reporter=dot", "--coverage"];
      expect(planRuns([...targets, ...forwardedArgs])).toEqual([
        {
          config: configFile("gateway"),
          forwardedArgs,
          includePatterns: targets.map((file) =>
            file === "src/gateway" ? "src/gateway/**/*.test.ts" : file,
          ),
          watchMode: false,
        },
        {
          config: configFile("infra"),
          forwardedArgs,
          includePatterns: databaseWorkerCoreTestFiles.filter((file) =>
            file.startsWith("src/gateway/"),
          ),
          watchMode: false,
        },
      ]);
    },
  );

  it.each(
    [configFile("gateway"), "src/gateway/config-reload.telegram-policy.test.ts"].flatMap((target) =>
      [true, false].map((workerFirst) => ({ target, workerFirst })),
    ),
  )(
    "coalesces Gateway worker config with $target (worker first: $workerFirst)",
    ({ target, workerFirst }) => {
      const workerConfig = configFile("gateway-database-workers");
      const targets = workerFirst ? [workerConfig, target] : [target, workerConfig];
      expectRun(planRuns(targets), "gateway", {
        includePatterns: target.endsWith(".config.ts")
          ? null
          : workerFirst
            ? [...gatewayDatabaseWorkerTestFiles, target]
            : [target, ...gatewayDatabaseWorkerTestFiles],
      });
    },
  );

  it.each([
    ["src/agents/**/*.test.ts", configFile("agents")],
    ["test/plugins", configFile("tooling")],
    ["test/scripts", configFile("tooling")],
    ["src/plugin-state", configFile("unit")],
  ])("preserves watch selection across database ownership for %s", (target, owner) => {
    expect(planRuns(["--watch", target])).toEqual([
      {
        config: configFile("database-worker-watch"),
        databaseWorkerWatchOwner: owner,
        databaseWorkerWatchTests: databaseWorkerCoreTestFiles.filter((file) =>
          file.startsWith(`${target.split("/**")[0]}/`),
        ),
        forwardedArgs: [],
        includePatterns: [target.endsWith(".test.ts") ? target : `${target}/**/*.test.ts`],
        watchMode: true,
      },
    ]);
  });

  it.each([
    testFiles("src/agents/**", "* memory-* memory-*"),
    [
      "extensions/matrix",
      "extensions/matrix/**/storage.test.ts",
      "extensions/matrix/**/storage.test.ts",
    ],
    testFiles("extensions/matrix/**", "storage * storage"),
    testFiles("extensions/matrix/**", "storage storage storage"),
  ])("retains watch intersection for %s and %s", (directory, pattern, expected) => {
    withIncludeFile([pattern], (includeFile) => {
      const specs = runSpecs(["--watch", directory], {
        baseEnv: { OPENCLAW_VITEST_INCLUDE_FILE: includeFile },
      });
      expect(specs).toHaveLength(1);
      expect(specs[0]?.includePatterns).toContain(expected);
      expect(
        specs[0]?.includePatterns?.every(
          (value) => value === expected || path.matchesGlob(value, expected),
        ),
      ).toBe(true);
      expect(specs[0]?.watchMode).toBe(true);
    });
  });

  it.each([
    [configFile("plugins"), "src/plugins/doctor-contract-registry.load-paths.test.ts"],
    [configFile("plugin-sdk"), "src/plugin-sdk/provider-auth.test.ts"],
    [
      configFile("unit-fast"),
      "src/agents/embedded-agent-runner/run/model-setup.selected-model.test.ts",
    ],
    [configFile("unit-fast"), "test/e2e/qa-lab/runtime/gateway-loopback-lan-access.test.ts"],
    [configFile("unit-fast-isolated"), "src/state/openclaw-agent-execution-cleanup.test.ts"],
    [
      configFile("unit-fast-isolated"),
      "src/auto-reply/reply/agent-runner-execution-auth-failures.test.ts",
    ],
  ])("preserves whole-owner watch coverage for %s with %s", (config, file) => {
    const [plan] = planRuns(["--watch", config, file]);
    expect(plan).toMatchObject({
      config: configFile("database-worker-watch"),
      databaseWorkerWatchOwner: config,
      includePatterns: null,
      watchMode: true,
    });
    expect(plan?.databaseWorkerWatchTests).toContain(file);
    if (config.endsWith("vitest.plugin-sdk.config.ts")) {
      expect(plan?.databaseWorkerWatchTests).toContain("src/plugin-sdk/memory-host-core.test.ts");
      expect(plan?.databaseWorkerWatchTests).not.toContain(
        "src/plugin-sdk/memory-host-events.test.ts",
      );
      expect(plan?.databaseWorkerWatchTests).not.toContain(
        "src/plugin-sdk/session-store-runtime.maintenance.test.ts",
      );
    }
    const [spec] = runSpecs(["--watch", config, file], { baseEnv: {} });
    expect(spec?.includeFilePath).toBeNull();
    expect(spec?.env.OPENCLAW_VITEST_DATABASE_WORKER_WATCH_OWNER).toBe(config);
    expect(JSON.parse(spec?.env.OPENCLAW_VITEST_DATABASE_WORKER_WATCH_TESTS ?? "null")).toEqual(
      plan?.databaseWorkerWatchTests,
    );
  });

  describe("agent directory and glob inventory", () => {
    const inventories = new Map<string, string[]>();
    const toolRoot = "src/agents/tools";
    const failoverRoot = "src/agents/failover";
    const embeddedRoot = "src/agents/embedded-agent-runner";
    const ownerExamples = [
      ["src/agents/agent-command-local.test.ts", "cli-process"],
      [`${toolRoot}/chat-history-text.test.ts`, "unit-fast"],
      [`${toolRoot}/computer-tool.schema.test.ts`, "unit-fast-isolated"],
      [`${toolRoot}/gateway.hosted-routing.test.ts`, "infra"],
      [`${failoverRoot}/classify.legacy-provider-predicates.test.ts`, "agents-core-isolated"],
      [`${failoverRoot}/failover-classification.corpus.test.ts`, "agents-core-isolated"],
      [`${failoverRoot}/provider-structured-signals.test.ts`, "agents-core-isolated"],
      ["src/agents/runtime-plan/materialize-model.test.ts", "agents-support"],
      [
        `${embeddedRoot}/run.incomplete-turn.classification.test.ts`,
        "agents-embedded-agent-incomplete-turn",
      ],
      [
        `${embeddedRoot}/run.overflow-compaction.test.ts`,
        "agents-embedded-agent-overflow-compaction",
      ],
      [`${embeddedRoot}/run/attempt.abort-race.test.ts`, "infra"],
      [
        `${embeddedRoot}/run/attempt-transcript-helpers.presence.test.ts`,
        "agents-embedded-agent-run",
      ],
      [`${embeddedRoot}/run/attempt-system-prompt.test.ts`, "infra"],
    ] as const;

    it.each`
      label                                        | targets                                                                                                          | patterns
      ${"agent root directory"}                    | ${["src/agents"]}                                                                                                | ${["src/agents/**/*.test.ts"]}
      ${"agent root glob"}                         | ${["src/agents/**/*.test.ts"]}                                                                                   | ${["src/agents/**/*.test.ts"]}
      ${"failover trailing slash"}                 | ${[`./${failoverRoot}/`]}                                                                                        | ${[`${failoverRoot}/**/*.test.ts`]}
      ${"embedded directory"}                      | ${[embeddedRoot]}                                                                                                | ${[`${embeddedRoot}/**/*.test.ts`]}
      ${"embedded run glob"}                       | ${[`${embeddedRoot}/run/*.test.ts`]}                                                                             | ${[`${embeddedRoot}/run/*.test.ts`]}
      ${"mixed overlapping directories and globs"} | ${[path.resolve(toolRoot), `src/agents/{tools,failover}/**/*.test.ts`, `${toolRoot}/chat-history-text.test.ts`]} | ${[`${toolRoot}/**/*.test.ts`, `${failoverRoot}/**/*.test.ts`]}
    `(
      "selects every ordinary test exactly once for $label",
      async ({ targets, patterns }: { targets: string[]; patterns: string[] }) => {
        const expected = [...new Set(fs.globSync(patterns).map(repoPath))]
          .filter((file) => !isSharedVitestExcludedPath(file))
          .toSorted();
        expect(expected.length).toBeGreaterThan(0);
        const controls = ["--sequence.shuffle", "--sequence.seed", "3"];
        const plans = planRuns([...targets, "--", ...controls]);
        const selected: Array<{ file: string; config: string }> = [];
        for (const plan of plans) {
          // Config loading temporarily owns process.argv and the include-file environment.
          const ownerFiles =
            inventories.get(plan.config) ?? (await listVitestConfigTestFiles(plan.config));
          inventories.set(plan.config, ownerFiles);
          // Repeating include expansion for every file makes broad inventory checks quadratic.
          const includedFiles =
            plan.includePatterns === null
              ? null
              : new Set(
                  fs
                    .globSync(plan.includePatterns)
                    .map((file) => repoPath(path.relative(process.cwd(), path.resolve(file)))),
                );
          selected.push(
            ...ownerFiles
              .filter(
                (file) =>
                  (!includedFiles || includedFiles.has(file)) &&
                  matchesVitestCliSelection(
                    file,
                    [file],
                    ["run", ...plan.forwardedArgs],
                    "",
                    {},
                    includedFiles ? [file] : null,
                  ),
              )
              .map((file) => ({ file, config: plan.config })),
          );
          expect(plan.watchMode).toBe(false);
          expect(plan.forwardedArgs.slice(0, controls.length)).toEqual(controls);
        }
        expect(selected.map(({ file }) => file).toSorted()).toEqual(expected);
        for (const [file, owner] of ownerExamples) {
          if (expected.includes(file)) {
            expect(
              selected.filter((entry) => entry.file === file).map(({ config }) => config),
            ).toEqual([`test/vitest/vitest.${owner}.config.ts`]);
          }
        }
      },
    );

    it.each([toolRoot, `${toolRoot}/**/*.test.ts`])(
      "intersects inherited includes for %s without dropping an explicit file",
      (target) => {
        const selected = `${toolRoot}/computer-tool.schema.test.ts`;
        const explicit = `${failoverRoot}/classify.legacy-provider-predicates.test.ts`;
        withIncludeFile([selected], (includeFile) => {
          const specs = runSpecs([target, explicit], {
            baseEnv: { OPENCLAW_VITEST_INCLUDE_FILE: includeFile },
          });
          expect(selectedTestFiles(specs).toSorted()).toEqual([selected, explicit].toSorted());
        });
      },
    );

    it.each([toolRoot, `${toolRoot}/**/*.test.ts`])(
      "keeps live and E2E opt-in outside ordinary selection for %s",
      (target) => {
        const ordinary = `${toolRoot}/example.test.ts`;
        const live = `${toolRoot}/example.live.test.ts`;
        const e2e = `${toolRoot}/example.e2e.test.ts`;
        withTinyFileTree(
          Object.fromEntries([ordinary, live, e2e].map((file) => [file, ""])),
          (cwd) => {
            const plans = planRuns([target], cwd);
            expect(selectedTestFiles(plans)).toEqual([ordinary]);
            const explicitPlans = planRuns([target, live, e2e], cwd);
            expect(
              explicitPlans.find((plan) => plan.config === configFile("e2e"))?.forwardedArgs,
            ).toEqual([e2e]);
            expect(selectedTestFiles(explicitPlans)).toContain(live);
            expectRun(planRuns([`${toolRoot}/*.e2e.test.ts`], cwd), "e2e", {
              forwardedArgs: [`${toolRoot}/*.e2e.test.ts`],
            });
          },
        );
      },
    );
  });

  it("routes changed Parallels process helpers to their owner tooling tests", () => {
    expectRun(
      planRuns(["--changed", "origin/main"], process.cwd(), () => [
        "scripts/e2e/parallels/host-command.ts",
      ]),
      "tooling",
      {
        includePatterns: testFiles(
          "test/scripts",
          "parallels-smoke-model parallels-npm-update-smoke",
        ),
      },
    );
  });

  it.each<[string[], string[]]>([
    [
      [
        "scripts/e2e/mcp-channels-docker.sh",
        "test/e2e/qa-lab/runtime/mcp-channels-docker-client.ts",
        "test/e2e/qa-lab/runtime/mcp-channels.fixture.ts",
        "test/e2e/qa-lab/runtime/mcp-client-temp-state.fixture.ts",
        "scripts/e2e/mcp-code-mode-gateway-docker.sh",
        "scripts/e2e/mcp-code-mode-gateway-live-docker.sh",
        "scripts/e2e/agent-bundle-mcp-tools-docker.sh",
        "test/e2e/qa-lab/runtime/agent-bundle-mcp-tools-docker-client.ts",
        "scripts/mcp-code-mode-gateway-e2e.ts",
        "scripts/e2e/cron-cli-docker.sh",
        "scripts/e2e/cron-mcp-cleanup-docker.sh",
        "scripts/e2e/cron-mcp-cleanup-docker-client.ts",
      ],
      [
        "test/scripts/docker-build-helper.test.ts",
        "test/scripts/docker-e2e-observability.test.ts",
        "test/scripts/docker-e2e-plan.test.ts",
        "test/scripts/plugin-prerelease-test-plan.test.ts",
        "test/e2e/qa-lab/runtime/mcp-gateway-transport.e2e.test.ts",
        "test/scripts/cron-mcp-cleanup-docker-client.test.ts",
        "test/scripts/mcp-code-mode-gateway-client.test.ts",
        "src/agents/agent-bundle-mcp-runtime.test.ts",
        "src/agents/agent-bundle-mcp-tools.materialize.test.ts",
        "src/gateway/server.cron.test.ts",
        "src/gateway/server-methods/agent.test.ts",
        "src/cron/isolated-agent/run.fast-mode.test.ts",
        "src/cron/active-jobs-manual-run.test.ts",
      ],
    ],
    [
      [
        "scripts/e2e/openai-image-auth-docker.sh",
        "test/e2e/qa-lab/runtime/openai-image-auth-docker-client.ts",
      ],
      [
        "test/scripts/docker-build-helper.test.ts",
        "test/scripts/docker-e2e-plan.test.ts",
        "test/scripts/openai-image-auth-docker-client.test.ts",
        "extensions/openai/image-generation-provider.test.ts",
        "src/image-generation/openai-compatible-image-provider.test.ts",
      ],
    ],
    [
      [
        "scripts/e2e/codex-media-path-docker.sh",
        "scripts/e2e/codex-npm-plugin-live-docker.sh",
        "scripts/e2e/codex-on-demand-docker.sh",
        "scripts/e2e/live-plugin-tool-docker.sh",
        "scripts/e2e/plugin-binding-command-escape-docker.sh",
        "scripts/e2e/qr-import-docker.sh",
      ],
      testFiles(
        "test/scripts",
        "docker-build-helper docker-e2e-plan codex-media-path-client package-acceptance-workflow live-plugin-tool-assertions plugin-binding-command-escape-docker",
      ),
    ],
  ])("routes Docker E2E targets %j to their semantic owners", (targets, owners) => {
    expect(unmatchedTargets(targets)).toEqual([]);
    expectChangedTargets(targets, owners);
  });

  it.each([
    ["chunks the broad shell helper tooling shard after isolated targets", "test/scripts"],
    ["chunks broad shell helper globs after isolated targets", "test/scripts/*.test.ts"],
  ])("%s", (_title, target) => {
    const plans = planRuns([target, "--reporter=dot"], process.cwd());
    const pattern = target === "test/scripts" ? "test/scripts/**/*.test.ts" : target;
    const expected = fs.globSync(pattern).map(repoPath).toSorted();
    const selected = plans.flatMap(
      (plan) =>
        plan.includePatterns ?? plan.forwardedArgs.filter((arg) => arg.endsWith(".test.ts")),
    );
    expect(selected.toSorted()).toEqual(expected);
    expect(new Set(selected).size).toBe(selected.length);

    const requiredOwners: Record<string, string> = {
      "test/scripts/ci-git-prerequisites.test.ts": configFile("unit-fast-isolated"),
      "test/scripts/pr-ci-sweeper.reopen-timer.test.ts": configFile("unit-fast-fake-timers"),
      "test/scripts/docker-build-helper.test.ts": configFile("tooling-docker"),
      "test/scripts/openclaw-e2e-instance.test.ts": configFile("tooling-isolated"),
    };
    for (const plan of plans) {
      const files =
        plan.includePatterns ?? plan.forwardedArgs.filter((arg) => arg.endsWith(".test.ts"));
      expect(plan.watchMode).toBe(false);
      expect(plan.forwardedArgs).toContain("--reporter=dot");
      if (plan.config === configFile("tooling")) {
        expect(files.length).toBeLessThanOrEqual(60);
      }
      for (const file of files) {
        const owner = file.endsWith(".e2e.test.ts") ? configFile("e2e") : requiredOwners[file];
        if (owner) {
          expect(plan.config, file).toBe(owner);
        }
      }
    }
  });

  it("adds the CLI process project for broad CLI targets", () => {
    const plans = planRuns(["src/cli"]);

    expect(plans.map((plan) => plan.config)).toEqual(
      expect.arrayContaining([
        configFile("unit-fast"),
        configFile("cli-process"),
        configFile("cli"),
        configFile("tooling-isolated"),
      ]),
    );
    const processPlan = plans.find((plan) => plan.config === configFile("cli-process"));
    expect(processPlan?.includePatterns).toContain("src/cli/help-exit.process.test.ts");
    expect(processPlan?.includePatterns).toContain("src/cli/update-dry-run-state.process.test.ts");
    expect(
      plans.find((plan) => plan.config === configFile("tooling-isolated"))?.includePatterns,
    ).toEqual(["src/cli/update-cli/update-command-legacy-finalize.test.ts"]);
  });

  it("preserves post-separator Vitest args without parsing them as targets", () => {
    for (const [arg, watchMode] of [
      ["--reporter=verbose", false],
      ["--watch", true],
    ] as const) {
      expectRun(planRuns(["test/scripts/run-vitest.test.ts", "--", arg]), "tooling", {
        forwardedArgs: [arg],
        includePatterns: ["test/scripts/run-vitest.test.ts"],
        watchMode,
      });
    }
  });

  it("prints wrapper help for --help without starting a broad local suite", () => {
    const helpFlag = "--help";
    const nodeExecPath = requireNodeTool("node");
    withTinyFileTree({}, (tempDir) => {
      const result = spawnSync(
        nodeExecPath,
        [
          ...resolveRuntimeWorkerArgv(
            resolveRuntimeWorkerUrl(scriptModuleEntrypoints.testProjects),
            nodeExecPath,
          ),
          helpFlag,
        ],
        {
          encoding: "utf8",
          // Keep the native help probe inside its invocation-owned temporary directory.
          env: testRunnerFixtureEnv({ TMPDIR: tempDir, TMP: tempDir, TEMP: tempDir }),
          timeout: 5_000,
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Usage: node scripts/test-projects.mts");
      expect(result.stderr).not.toContain("[test] starting");
    });
  });

  it.each([
    {
      target: "src/channels/plugins/contracts",
      plans: ["surface", "config", "registry", "session"].map((owner) =>
        runPlan(`contracts-channel-${owner}`),
      ),
    },
    {
      target: "src/plugins/contracts",
      plans: [
        runPlan("contracts-plugin"),
        runPlan(
          "infra",
          testFiles("src/plugins/contracts", "host-hook-state.identity host-hooks.contract"),
        ),
      ],
    },
  ])("fans $target out to its contract and database owners", ({ target, plans }) => {
    // Generic channels/plugins projects exclude contracts/** and would run zero tests.
    expect(planRuns([target])).toEqual(plans);
  });

  it.each([
    ["extensions/imessage/message-tool-api.ts", "extensions/imessage/src/message-tool-api.test.ts"],
    ["extensions/slack/message-tool-api.ts", "extensions/slack/message-tool-api.ts"],
    [
      "extensions/slack/src/channel-actions.ts",
      "extensions/slack/src/channel-actions-setup-status.contract.test.ts",
    ],
    ["extensions/telegram/src/channel.ts", "test/telegram-question-gateway.test.ts"],
    ["extensions/matrix/src/channel.ts", "extensions/matrix/src/channel.threading.test.ts"],
  ] as const)(
    "routes %s through its owner and the plugin-shape parity contract",
    (changedPath, ownerTarget) => {
      const plan = changedPlan([changedPath]);

      expect(plan.mode).toBe("targets");
      expect(plan.targets).toContain(ownerTarget);
      expect(plan.targets).toContain(
        "src/channels/plugins/contracts/plugin-shape.contract.test.ts",
      );
    },
  );

  it("fails safe for raw Git paths that explicit-path normalization would rewrite", () => {
    for (const changedPath of [
      " scripts/changed-lanes.mts",
      String.raw`scripts\changed-lanes.mts`,
    ]) {
      expect(
        changedPlanForArgs(["--changed", "origin/main"], process.cwd(), () => [changedPath], {
          broad: true,
        }),
        changedPath,
      ).toEqual({ mode: "broad", targets: [] });
    }
  });

  it("keeps the broad changed run available for unknown root surfaces", async () => {
    expect(
      changedArgs(["--changed", "origin/main"], process.cwd(), () => ["unknown/file.txt"], {
        env: { OPENCLAW_TEST_CHANGED_BROAD: "1" },
      }),
    ).toBeNull();
    const lanes = await import("../../scripts/changed-lanes.mts");
    const changedPaths = vi
      .spyOn(lanes, "listChangedPathsFromGit")
      .mockReturnValue(["unknown/file.txt"]);
    try {
      const specs = runSpecs(["--changed", "origin/main"], {
        baseEnv: { OPENCLAW_TEST_CHANGED_BROAD: "1" },
      });
      expect(specs.map(({ config, includePatterns }) => ({ config, includePatterns }))).toEqual([
        { config: configFile("unit"), includePatterns: null },
      ]);
    } finally {
      changedPaths.mockRestore();
    }
  });

  it.each([false, true])("resolves standalone changed specs (watch=%s)", async (watch) => {
    const lanes = await import("../../scripts/changed-lanes.mts");
    const target = "test/scripts/run-node-lifecycle.test.ts";
    const changedPaths = vi.spyOn(lanes, "listChangedPathsFromGit").mockReturnValue([target]);
    try {
      const specs = runSpecs([...(watch ? ["--watch"] : []), "--changed", "origin/main"], {
        baseEnv: {},
      });
      expect(
        specs.map(({ config, includePatterns, watchMode }) => ({
          config,
          includePatterns,
          watchMode,
        })),
      ).toEqual([
        {
          config: configFile("tooling"),
          includePatterns: [target],
          watchMode: watch,
        },
      ]);
      expect(changedPaths).toHaveBeenCalledTimes(1);
    } finally {
      changedPaths.mockRestore();
    }
  });

  it("skips app-only changes because app tests are separate from Vitest lanes", () => {
    expect(
      planRuns(["--changed", "origin/main"], process.cwd(), () => [
        "apps/macos/OpenClaw/AppDelegate.swift",
      ]),
    ).toStrictEqual([]);
  });

  it("keeps the top-level extensions watch target on its aggregate owner", () => {
    expectRun(planRuns(["--watch", "extensions"]), "full-extensions", { watchMode: true });
  });

  it("bounds an explicit Telegram config target across process lifetimes", () => {
    const config = configFile("extension-telegram");
    const plans = planRuns([config], process.cwd());

    expect(plans).toHaveLength(expectedTelegramTestProcessCount());
    expect(plans.every((plan) => plan.config === config)).toBe(true);
    expect(
      plans.every(
        (plan) => (plan.includePatterns?.length ?? 0) <= TELEGRAM_TEST_PROCESS_FILE_LIMIT,
      ),
    ).toBe(true);
    expect(selectedTestFiles(plans)).toEqual(listOrdinaryExtensionFiles("extensions/telegram"));
  });

  it.each(["extension-telegram", "extension-matrix"])(
    "preserves an externally scoped %s config target",
    (project) => {
      expectRun(
        planRuns([configFile(project)], process.cwd(), () => [], {
          env: { OPENCLAW_VITEST_INCLUDE_FILE: "ci-shard.json" },
        }),
        project,
      );
    },
  );

  it.each([
    {
      channel: "Telegram",
      config: configFile("extension-telegram"),
      directory: "extensions/telegram",
    },
    {
      channel: "Matrix",
      config: configFile("extension-matrix"),
      directory: "extensions/matrix",
    },
  ])("preserves an externally scoped $channel directory run spec", ({ config, directory }) => {
    withIncludeFile(
      [`${directory}/src/example.test.ts`],
      (includeFile) => {
        const [spec] = runSpecs([directory], {
          baseEnv: { OPENCLAW_VITEST_INCLUDE_FILE: includeFile },
        });
        expect(spec).toMatchObject({
          config,
          env: { OPENCLAW_VITEST_INCLUDE_FILE: includeFile },
          includeFilePath: null,
          includePatterns: null,
        });
      },
      "ci-shard.json",
    );
  });

  it.each([
    {
      directory: "extensions/matrix/src/matrix/client",
      selected: ["extensions/matrix/src/matrix/client/storage.test.ts"],
      inherited: testFiles("extensions/matrix/src/matrix", "client/storage thread-bindings"),
    },
    {
      directory: "extensions/matrix/src/matrix/sdk",
      // Worker membership belongs to the database lane; this case protects the
      // directory intersection as that membership grows.
      selected: databaseWorkerExtensionTestFiles.filter((file) =>
        file.startsWith("extensions/matrix/src/matrix/sdk/"),
      ),
      inherited: ["extensions/matrix/**/*.test.ts"],
    },
  ])(
    "intersects $directory and inherited worker selections before emitting include files",
    ({ directory, selected, inherited }) => {
      withIncludeFile(inherited, (includeFile) => {
        const specs = runSpecs([directory], {
          baseEnv: { OPENCLAW_VITEST_INCLUDE_FILE: includeFile },
        });
        const worker = specs.find(
          (spec) => spec.config === configFile("extension-database-workers"),
        );
        expect(worker?.includePatterns).toEqual(selected);
        expect(selectedTestFiles(specs)).not.toContain(
          "extensions/matrix/src/matrix/thread-bindings.test.ts",
        );
      });
    },
  );

  it("keeps grouped Matrix targets covered when bounding the directory", () => {
    const testFile = listExtensionTestFilesForRoots(["extensions/matrix"])[0];
    if (!testFile) {
      throw new Error("expected a Matrix test fixture");
    }

    const plans = planRuns(["extensions/matrix", testFile], process.cwd());

    expect(plans.length).toBeGreaterThan(1);
    expect(
      plans.every((plan) => (plan.includePatterns?.length ?? 0) <= MATRIX_TEST_PROCESS_FILE_LIMIT),
    ).toBe(true);
    expect(selectedTestFiles(plans).toSorted()).toEqual(
      listExtensionTestFilesForRoots(["extensions/matrix"]).toSorted(),
    );
  });

  it("keeps a grouped Matrix config target unsplit beside its worker tests", () => {
    const plans = planRuns(["extensions/matrix", configFile("extension-matrix")]);
    expect(plans).toEqual([
      {
        config: configFile("extension-database-workers"),
        forwardedArgs: [],
        includePatterns: databaseWorkerExtensionTestFiles.filter((file) =>
          file.startsWith("extensions/matrix/"),
        ),
        watchMode: false,
      },
      runPlan("extension-matrix"),
    ]);
  });

  it("keeps explicit Matrix files and watch runs unchunked", () => {
    const testFile = listExtensionTestFilesForRoots(["extensions/matrix"])[0];
    expect(testFile).toBeDefined();
    expect(planRuns([testFile!])).toHaveLength(1);
    const plans = planRuns(["--watch", "extensions/matrix"]);
    expect(plans).toEqual([
      {
        config: configFile("database-worker-watch"),
        databaseWorkerWatchOwner: configFile("extension-matrix"),
        databaseWorkerWatchTests: databaseWorkerExtensionTestFiles.filter((file) =>
          file.startsWith("extensions/matrix/"),
        ),
        forwardedArgs: [],
        includePatterns: expect.arrayContaining(["extensions/matrix/**/*.test.ts"]),
        watchMode: true,
      },
    ]);
  });

  it("keeps the opaque retention child owner beside additional fixture consumers", () => {
    const helper = "src/plugins/runtime.retention.test-support.ts";
    const owner = "src/plugins/runtime.retention.test.ts";
    const direct = "src/other/direct.test.ts";
    const indirect = "src/plugins/shared-consumer.test.ts";
    withTinyGitRepo(
      {
        [helper]: "export const fixture = 1;\n",
        [owner]: "export {};\n",
        [direct]: 'import "../plugins/runtime.retention.test-support.js";\n',
        "src/plugins/bridge.ts": 'export * from "./runtime.retention.test-support.js";\n',
        [indirect]: 'import "./bridge.js";\n',
        "src/plugins/unrelated.test.ts": "export {};\n",
      },
      (cwd) => {
        const plan = changedPlan([helper], { cwd, boundedOwners: true });
        expect(plan.ownerTargets).toEqual([owner]);
        expect(plan.targets.toSorted()).toEqual([owner, direct, indirect].toSorted());
        expect(plan.ownerAreas).toEqual(["src/plugins"]);
      },
    );
  });

  it("adds transitive owner tests and keeps direct cross-area readers without broad fallback", () => {
    withTinyGitRepo(
      {
        "package.json": "{}",
        "src/feature/value.ts": "export const value = 1;\n",
        "src/feature/value.test.ts": "export const owner = true;\n",
        "src/feature/consumer.test.ts": 'import "./value.js";\n',
        "src/feature/bridge.ts": 'export * from "./value.js";\n',
        "src/feature/indirect.test.ts": 'import "./bridge.js";\n',
        "src/feature/unrelated.test.ts": "export const unrelated = true;\n",
        "src/other/reader.test.ts": 'import "../feature/value.js";\n',
        "src/other/indirect.test.ts": 'import "../feature/bridge.js";\n',
      },
      (cwd) => {
        expect(
          changedPlan(["package.json", "src/feature/value.ts"], {
            cwd,
            broad: true,
            boundedOwners: true,
            resolveAliases: true,
            runtimeOnly: true,
            combineSiblingWithImportGraph: true,
          }),
        ).toEqual({
          mode: "targets",
          ownerTargets: ["src/feature/value.test.ts"],
          ownerAreas: ["scripts", "src/scripts", "test/scripts", "src/feature"],
          targets: testFiles("src", "feature/value feature/consumer feature/indirect other/reader"),
        });
      },
    );
  });

  describe("Kova schema selection", () => {
    const wrapper = "src/config/zod-schema.agent-defaults.ts";
    const base = "src/config/zod-schema.agent-defaults-base.ts";
    const sibling = "src/config/zod-schema.agent-defaults.test.ts";
    const baseConsumer = "src/config/base-consumer.test.ts";
    const wrapperConsumer = "src/config/wrapper-consumer.test.ts";
    const unrelated = "src/config/unrelated.ts";
    const unrelatedTest = "src/config/unrelated.test.ts";
    const kova = "test/scripts/openclaw-performance-workflow.test.ts";
    const changed = ["--changed", "origin/main"];
    const normal = [baseConsumer, sibling, wrapperConsumer];
    const files = {
      [base]: "export const defaults = {};\n",
      [wrapper]: 'export { defaults } from "./zod-schema.agent-defaults-base.js";\n',
      [sibling]: 'import "./zod-schema.agent-defaults.js";\n',
      [baseConsumer]: 'import "./zod-schema.agent-defaults-base.js";\n',
      [wrapperConsumer]: 'import "./zod-schema.agent-defaults.js";\n',
      [unrelated]: "export const unrelated = true;\n",
      [unrelatedTest]: 'import "./unrelated.js";\n',
      [kova]: "export {};\n",
    };
    it.each<[string, string[], string[], string[], boolean, boolean]>([
      ["changed wrapper", changed, [wrapper], [sibling, kova], false, false],
      ["explicit schemas", [base, wrapper, kova, base], [], [...normal, kova], false, false],
      ["CI wrapper", changed, [wrapper], [sibling, wrapperConsumer, kova], false, true],
      ["unrelated source", changed, [unrelated], [unrelatedTest], false, false],
      ["changed watch", ["--watch", ...changed], [base], normal, true, false],
      ["explicit watch", ["--watch", wrapper], [], [sibling], true, false],
      ["disabled watch", ["--watch", "false", wrapper], [], [sibling, kova], false, false],
      ["equals watch", ["--watch=false", wrapper], [], [sibling, kova], false, false],
      ["negated watch", ["--no-watch", wrapper], [], [sibling, kova], false, false],
    ])("preserves owner selection for %s", (_name, args, paths, expected, watchMode, ci) => {
      withTinyGitRepo(files, (cwd) => {
        const options = ci
          ? { combineSiblingWithImportGraph: true, forceFullImportGraph: true }
          : {};
        const plans = planRuns(args, cwd, () => paths, options);
        expect(selectedTestFiles(plans).toSorted()).toEqual(expected.toSorted());
        expect(plans.every((plan) => plan.watchMode === watchMode)).toBe(true);
        expect(
          plans.find((plan) => plan.config === configFile("tooling"))?.includePatterns,
        ).toEqual(expected.includes(kova) ? [kova] : undefined);
        if (watchMode) {
          expectRun(plans, "runtime-config", {
            includePatterns: expect.arrayContaining(expected),
            watchMode: true,
          });
        }
        expect(unmatchedTargets(args, cwd)).toEqual([]);
      });
    });
    it("does not admit unmatched watch sources through Kova", () => {
      withTinyGitRepo({ [base]: "export {};\n", [kova]: "export {};\n" }, (cwd) => {
        expect(unmatchedTargets([base], cwd)).toEqual([]);
        expect(unmatchedTargets(["--watch", base], cwd)).toEqual([
          expect.objectContaining({ target: base, reason: "target-matched-no-test-files" }),
        ]);
      });
    });
    it("keeps skipped import-graph paths visible with mixed broad changes", () => {
      withTinyGitRepo(files, (cwd) => {
        const paths = [base, "unknown/file.txt"];
        expect(changedPlan(paths, { cwd })).toEqual({
          mode: "targets",
          targets: [kova],
          skippedBroadFallbackPaths: paths,
        });
        expect(changedPlan(paths, { cwd, broad: true })).toEqual({
          mode: "broad",
          targets: [],
        });
      });
    });
  });

  it.each(["changed", "explicit"])(
    "routes %s ui support files to the ui lane without dead include globs",
    (mode) => {
      const targets = ["ui/src/styles/base.css", "ui/src/test-helpers/dom.setup.ts"];
      const plans = planRuns(
        mode === "changed" ? ["--changed", "origin/main"] : targets,
        process.cwd(),
        () => targets,
      );

      expect(plans[0]).toEqual(runPlan("ui"));
      expect(plans[1]?.config).toBe(configFile("ui-browser"));
      expect(plans[1]?.includePatterns).toContain(
        "ui/src/components/markdown-mermaid.runtime.browser.test.ts",
      );
    },
  );

  it.each(["relative", "trailing slash", "absolute", "dot segments"])(
    "keeps an existing nested ui directory and explicit e2es scoped (%s)",
    (spelling) => {
      const directory = "ui/src/pages/new-session";
      const isolated = [
        `${directory}/draft-persistence.test.ts`,
        `${directory}/new-session-attachment-lazy.test.ts`,
      ];
      const unitFiles = [
        `${directory}/view.test.ts`,
        `${directory}/nested/child.test.ts`,
        ...isolated,
      ];
      const e2es = testFiles(
        "ui/src/e2e",
        "new-session-page.workspace-validation.e2e new-session-page.projects-places.e2e new-session-page.device-dispatch.e2e",
      );
      withTinyFileTree(
        Object.fromEntries(
          [
            ...unitFiles,
            ...e2es,
            "ui/src/pages/other/view.test.ts",
            "ui/src/pages/workboard/view.test.ts",
            "ui/src/components/other.browser.test.ts",
            "ui/src/e2e/other.e2e.test.ts",
          ].map((file) => [file, ""]),
        ),
        (cwd) => {
          const target =
            spelling === "absolute"
              ? path.join(cwd, directory)
              : spelling === "trailing slash"
                ? `./${directory}/`
                : spelling === "dot segments"
                  ? "ui/src/pages/./new-session/../new-session"
                  : directory;
          const plans = planRuns([target, ...e2es], cwd);
          expect(plans).toEqual([
            runPlan("ui", [`${directory}/**/*.test.ts`]),
            runPlan("ui-isolated", isolated),
            runPlan("ui-e2e", e2es),
          ]);
          const includeFile = path.join(cwd, "include.json");
          const filesByPlan = plans.map((plan) => {
            writeVitestIncludeFile(includeFile, plan.includePatterns!, { cwd });
            return JSON.parse(fs.readFileSync(includeFile, "utf8"));
          });
          // Shared UI intersects these files with its ownership exclusions.
          expect(filesByPlan).toEqual([unitFiles.toSorted(), isolated, e2es]);
        },
      );
    },
  );

  it("adds isolated and Chromium projects before timing budgets for broad ui targets", () => {
    const plans = planRuns(["ui/src"]);

    expect(plans.map((plan) => plan.config)).toEqual([
      configFile("ui"),
      configFile("ui-isolated"),
      configFile("ui-browser"),
      configFile("ui-timing"),
    ]);
    expect(plans[1]?.includePatterns).toContain("ui/src/pages/chat/chat-pane.test.ts");
    expect(plans[2]?.includePatterns).toContain(
      "ui/src/components/markdown-mermaid.runtime.browser.test.ts",
    );
    expect(plans[3]?.includePatterns).toEqual(["ui/src/components/markdown.progress.node.test.ts"]);
  });

  it.each([
    ["ui/src/**/*.browser.test.ts"],
    [
      "ui/src/components/*.browser.test.ts",
      "ui/src/pages/chat",
      "ui/src/styles/cursor-policy.browser.test.ts",
    ],
  ])("retains both browser owners for mixed selectors %j", (...targets) => {
    const plans = planRuns(targets);
    const native = plans.find((plan) => plan.config === configFile("ui-browser"));
    const node = plans.find((plan) => plan.config === configFile("ui"));
    expect(native?.includePatterns).toContain(
      "ui/src/components/markdown-mermaid.runtime.browser.test.ts",
    );
    expect(
      node?.includePatterns === null ||
        node?.includePatterns?.includes("ui/src/components/form-controls.browser.test.ts"),
    ).toBe(true);
    expect(node?.includePatterns ?? []).not.toContain(
      "ui/src/components/markdown-mermaid.runtime.browser.test.ts",
    );
    expect(native?.includePatterns).not.toContain(
      "ui/src/components/form-controls.browser.test.ts",
    );
    if (targets.length === 1) {
      // Browser screenshots live in directories named after their test files.
      const matchingFiles = fs.globSync(targets[0]!).filter((file) => fs.statSync(file).isFile());
      expect(selectedTestFiles(plans).toSorted()).toEqual(matchingFiles.toSorted());
    }
  });

  it("rejects UI glob watch before freezing the current matching files", () => {
    expect(() => planRuns(["--watch", "ui/src/components/markdown-*.browser.test.ts"])).toThrow(
      "use a literal test path, directory, or dedicated UI suite",
    );
  });

  it.each([
    {
      expandGlobs: true,
      withRepo: withTinyGitRepo,
      patterns: testFiles("src/gateway", "**/* server-* @(core|server-startup)"),
      expected: testFiles("src/gateway", "core server-methods/ping server-startup"),
    },
    {
      expandGlobs: false,
      withRepo: withTinyFileTree,
      patterns: ["src/gateway/**/*.test.ts"],
      expected: ["src/gateway/**/*.test.ts"],
    },
  ])(
    "writes include files with expandGlobs=$expandGlobs",
    ({ expandGlobs, withRepo, patterns, expected }) => {
      withRepo(
        {
          "src/gateway/core.test.ts": "",
          "src/gateway/server-methods/ping.test.ts": "",
          "src/gateway/server-startup.test.ts": "",
        },
        (cwd) => {
          const includeFile = path.join(cwd, "include.json");
          writeVitestIncludeFile(includeFile, patterns, { cwd, expandGlobs });
          expect(JSON.parse(fs.readFileSync(includeFile, "utf8"))).toEqual(expected);
        },
      );
    },
  );

  it("preflights targeted UI E2E specs with Playwright browser assets", () => {
    const [spec] = runSpecs(["ui/src/pages/cron/run-transcript.e2e.test.ts"], {
      baseEnv: {},
    });

    expect(spec?.config).toBe(configFile("ui-e2e"));
    expect(spec?.preflightPnpmArgs).toEqual([
      "exec",
      "node",
      "--import",
      "tsx",
      "scripts/ensure-playwright-chromium.mts",
    ]);
  });

  it("skips import-graph scans once a diff already needs broad fallback", () => {
    const readFileSync = vi.spyOn(fs, "readFileSync");
    const before = readFileSync.mock.calls.length;
    const plan = changedPlan([".crabbox.yaml", "scripts/check.mts", "src/gateway/server.impl.ts"]);
    const repoSourceReads = readFileSync.mock.calls
      .slice(before)
      .filter(([file]) => typeof file === "string" && repoPath(file).includes("/src/"));
    readFileSync.mockRestore();

    expect(plan).toEqual({
      mode: "targets",
      skippedBroadFallbackPaths: ["src/gateway/server.impl.ts"],
      targets: testFiles("test/scripts", "package-acceptance-workflow check pr-gate-base"),
    });
    expect(repoSourceReads).toEqual([]);
  });

  it("routes prompt snapshot generator helper edits to the owner test", () => {
    for (const target of [
      "scripts/generate-prompt-snapshots.ts",
      "scripts/prompt-snapshot-files.ts",
      "scripts/sync-codex-model-prompt-fixture.ts",
      "test/helpers/agents/happy-path-prompt-snapshots.ts",
      "test/fixtures/agents/prompt-snapshots/codex-model-catalog/gpt-5.5.pragmatic.source.json",
      "test/fixtures/agents/prompt-snapshots/codex-runtime-happy-path/telegram-direct-codex-message-tool.md",
      "test/fixtures/agents/prompt-snapshots/codex-runtime-happy-path/discord-group-codex-message-tool.md.diff",
    ]) {
      expectChangedTargets([target], ["test/scripts/prompt-snapshots.test.ts"]);
    }
  });

  it("routes package fixture assets to their owner test", () => {
    const owner = "packages/ai/src/provider-transport-parity.test.ts";
    const fixturePaths = [
      "packages/ai/test/fixtures/provider-transport-parity/anthropic-success.snap.txt",
      "packages/ai/test/fixtures/provider-transport-parity/anthropic-error.snap.txt",
    ];
    for (const fixturePath of fixturePaths) {
      expectChangedTargets([fixturePath], [owner]);
    }
    expectChangedTargets(fixturePaths, [owner]);
    expectRun(
      planRuns(["--changed", "origin/main"], process.cwd(), () => fixturePaths),
      "unit",
      { forwardedArgs: [owner], includePatterns: [owner] },
    );
  });
});

describe("changed export mock consumers", () => {
  it.each`
    name                                                 | before                                                                                | after                                                                                                   | selected
    ${"member access cannot invent an export"}           | ${"export const old = 1; const api = { export: 0 }; api.export\nfunction added() {}"} | ${"export const old = 1; const api = { export: 0 }; api.export\nfunction added() {} export { added };"} | ${true}
    ${"a preceding period literal is not member access"} | ${"export const old = 1;"}                                                            | ${'export const old = 1; "."\nexport const added = 2;'}                                                 | ${true}
    ${"empty-string export alias"}                       | ${"export const old = 1; const value = 2;"}                                           | ${'export const old = 1; const value = 2; export { value as "" };'}                                     | ${true}
    ${"quoted closing brace is an export name"}          | ${"export const old = 1;"}                                                            | ${'export const old = 1; export { "}" as added } from "./other.js";'}                                   | ${true}
    ${"erased default becomes a runtime export"}         | ${"export default interface API {}"}                                                  | ${"export default class API {}"}                                                                        | ${true}
    ${"erased namespace gains a runtime member"}         | ${"export namespace API { export type Value = string; }"}                             | ${"export namespace API { export const value = 1; }"}                                                   | ${true}
    ${"const enums retain mock coverage"}                | ${"export const enum Old { Value = 1 }"}                                              | ${"export const enum Old { Value = 1 } export const enum Added { Value = 2 }"}                          | ${true}
    ${"JSX text cannot hide a later export"}             | ${"function component() { return <div>}</div>; } export const old = 1;"}              | ${"function component() { return <div>}</div>; } export const old = 1; export const added = 2;"}        | ${true}
    ${"Unicode names retain mock coverage"}              | ${"export function café() {}"}                                                        | ${"export function cafè() {}"}                                                                          | ${true}
    ${"bracket CommonJS exports retain mock coverage"}   | ${'module["exports"] = { old: 1 };'}                                                  | ${'module["exports"] = { old: 1, added: 2 };'}                                                          | ${true}
    ${"CommonJS exports retain mock coverage"}           | ${"exports.old = 1;"}                                                                 | ${"exports.old = 1; exports.added = 2;"}                                                                | ${true}
    ${"implicit statement does not hide a new export"}   | ${"export const old = 1\nconst hidden = 2, added = 3;"}                               | ${"export const old = 1\nconst hidden = 2, added = 3; export { added };"}                               | ${true}
    ${"namespace member does not hide a module export"}  | ${"export namespace API { export const added = 1; }"}                                 | ${"export namespace API { export const added = 1; } export const added = 2;"}                           | ${true}
    ${"generic initializer does not hide a new export"}  | ${"class Handler {}; export const cache = new Map<string, Handler>();"}               | ${"class Handler {}; export const cache = new Map<string, Handler>(); export { Handler };"}             | ${true}
    ${"added function"}                                  | ${"export const old = 1;"}                                                            | ${"export const old = 1; export function added() {}"}                                                   | ${true}
    ${"removed export"}                                  | ${"export const old = 1;"}                                                            | ${"const old = 1;"}                                                                                     | ${true}
    ${"renamed re-export"}                               | ${'export { original as old } from "./value.js";'}                                    | ${'export { original as renamed } from "./value.js";'}                                                  | ${true}
    ${"multiline export list"}                           | ${"const old = 1; export { old };"}                                                   | ${"const old = 1, added = 2; export {\n old,\n added\n };"}                                             | ${true}
    ${"second variable"}                                 | ${"export const old = 1;"}                                                            | ${"export const old = 1, added = 2;"}                                                                   | ${true}
    ${"default export"}                                  | ${"export const old = 1;"}                                                            | ${"export const old = 1; export default () => 2;"}                                                      | ${true}
    ${"wildcard source"}                                 | ${'export * from "./one.js";'}                                                        | ${'export * from "./two.js";'}                                                                          | ${true}
    ${"implementation only"}                             | ${"export function old() { return 1; }"}                                              | ${"export function old() { return 2; }"}                                                                | ${false}
    ${"initializer only"}                                | ${"export const old = 1;"}                                                            | ${"export const old = call(2, 3);"}                                                                     | ${false}
    ${"type only"}                                       | ${"export const old = 1;"}                                                            | ${"export const old = 1; export type New = string; export interface Shape {}"}                          | ${false}
    ${"comments and strings"}                            | ${"export const old = 1;"}                                                            | ${`export const old = 1; // export const added = 2;\nconst text = 'export { added }';`}                 | ${false}
    ${"unknown bindings"}                                | ${"export const old = 1;"}                                                            | ${"export const { old, added } = value;"}                                                               | ${true}
  `(
    "selects all mock owners on $name",
    ({ before, after, selected }: { before: string; after: string; selected: boolean }) => {
      const producer = "src/owner/runtime.ts";
      const consumers = testFiles("test", "relative alias package shared");
      withTinyGitRepo(
        {
          [producer]: before,
          "src/owner/runtime.test.ts": "export {};",
          "src/owner/other.ts": 'const value = 1; export { value as "}" };',
          "tsconfig.json": JSON.stringify({
            compilerOptions: { paths: { "@runtime/*": ["src/owner/*"] } },
          }),
          "package.json": JSON.stringify({
            name: "example",
            exports: { "./runtime": "./src/owner/runtime.ts" },
          }),
          [consumers[0]!]: 'vi.mock("../src/owner/runtime.js", () => ({ old: 1 }));',
          [consumers[1]!]: 'vi.mock(import("@runtime/runtime"), () => ({ old: 1 }));',
          [consumers[2]!]: 'vi.mock("example/runtime", () => ({ old: 1 }));',
          "test/mock-factory.ts": 'vi.mock("../src/owner/runtime.js", () => ({ old: 1 }));',
          "test/shared-layer.ts": '"."\nimport "./mock-factory.js";',
          [consumers[3]!]: 'import "./shared-layer.js";',
          "test/fixture-text.test.ts": `const fixture = 'vi.mock("../src/owner/runtime.js", () => ({}))';`,
          "test/comment.test.ts": '// vi.mock("../src/owner/runtime.js", () => ({}));',
        },
        (cwd) => {
          const baseRef = gitTree(cwd);
          fs.writeFileSync(path.join(cwd, producer), after);
          const reasons: string[] = [];
          const result = changedPlan([producer], {
            cwd,
            baseRef,
            boundedOwners: true,
            resolveAliases: true,
            runtimeOnly: true,
            aggressive: { maxDirectImporters: 1, maxDirectoryTests: 1 },
            onSelection: ({ rule, targets }) => {
              if (rule === "mock-export-consumer") {
                reasons.push(...targets);
              }
            },
          });
          expect(reasons.toSorted()).toEqual(selected ? consumers.toSorted() : []);
          if (selected) {
            expect(result.targets).toEqual(expect.arrayContaining(consumers));
          }
          expect(result.targets).not.toContain("test/fixture-text.test.ts");
          expect(result.targets).not.toContain("test/comment.test.ts");
        },
      );
    },
  );

  it.each`
    name                                                 | before                                                      | after                                                                                       | selected
    ${"namespace re-export becomes star re-export"}      | ${'export * as runtime from "./runtime.js";'}               | ${'export * from "./runtime.js";'}                                                          | ${true}
    ${"literal star becomes namespace consumption"}      | ${'import { "*" as star } from "./runtime.js"; void star;'} | ${'import * as runtime from "./runtime.js"; void runtime.existing;'}                        | ${true}
    ${"literal star becomes dynamic consumption"}        | ${'import { "*" as star } from "./runtime.js"; void star;'} | ${'const runtime = await import("./runtime.js"); void runtime.existing;'}                   | ${true}
    ${"literal star becomes re-export consumption"}      | ${'export { "*" as star } from "./runtime.js";'}            | ${'export * from "./runtime.js";'}                                                          | ${true}
    ${"import after a period literal"}                   | ${'import { old } from "./runtime.js";'}                    | ${'"."\nimport { existing } from "./runtime.js";'}                                          | ${true}
    ${"quoted closing brace is a consumed name"}         | ${'import { old } from "./runtime.js";'}                    | ${'import { "}" as existing } from "./runtime.js";'}                                        | ${true}
    ${"named re-export switches consumed binding"}       | ${'export { old as run } from "./runtime.js";'}             | ${'export { existing as run } from "./runtime.js";'}                                        | ${true}
    ${"erased query becomes a runtime namespace import"} | ${'type Runtime = typeof import("./runtime.js");'}          | ${'type Runtime = typeof import("./runtime.js"); import * as runtime from "./runtime.js";'} | ${true}
    ${"default binding named type"}                      | ${'import { old } from "./runtime.js";'}                    | ${'import type from "./runtime.js";'}                                                       | ${true}
    ${"default binding named type with named imports"}   | ${'import { old } from "./runtime.js";'}                    | ${'import type, { old } from "./runtime.js";'}                                              | ${true}
    ${"new named import"}                                | ${'import { old } from "./runtime.js";'}                    | ${'import { old, existing } from "./runtime.js";'}                                          | ${true}
    ${"new default import"}                              | ${'import { old } from "./runtime.js";'}                    | ${'import value, { old } from "./runtime.js";'}                                             | ${true}
    ${"local rename"}                                    | ${'import { old } from "./runtime.js";'}                    | ${'import { old as renamed } from "./runtime.js";'}                                         | ${false}
    ${"new erased binding"}                              | ${'import { old } from "./runtime.js";'}                    | ${'import { old, type Shape } from "./runtime.js";'}                                        | ${false}
  `(
    "protects existing exports on $name",
    ({ before, after, selected }: { before: string; after: string; selected: boolean }) => {
      const producer = "src/owner/caller.ts";
      withTinyGitRepo(
        {
          [producer]: before,
          "src/owner/caller.test.ts": "export {};",
          "src/owner/runtime.ts":
            'export const old = 1, existing = 2; export default 3; export { existing as "}", existing as "*" };',
          "test/consumer.test.ts":
            'import "./layer-one.js"; vi.mock("../src/owner/runtime.js", () => ({ old: 1, "*": 2 }));',
          "test/layer-one.ts": 'import "./layer-two.js";',
          "test/layer-two.ts": 'import "../src/owner/caller.js";',
          "test/unrelated.test.ts":
            'vi.mock("../src/owner/runtime.js", () => ({ old: 1, "*": 2 }));',
        },
        (cwd) => {
          const baseRef = gitTree(cwd);
          fs.writeFileSync(path.join(cwd, producer), after);
          const result = changedPlan([producer], {
            cwd,
            baseRef,
            boundedOwners: true,
            aggressive: { maxDirectImporters: 1, maxDirectoryTests: 1 },
          });
          expect(result.targets.includes("test/consumer.test.ts")).toBe(selected);
          expect(result.targets).not.toContain("test/unrelated.test.ts");
        },
      );
    },
  );

  it.each([
    'vi.mock<{ old: number }>(import("../src/owner/runtime.js"), () => ({ old: 1 }));',
    'import { vi as mocker } from "vitest"; mocker.doMock("../src/owner/runtime.js", () => ({ old: 1 }));',
  ])("retains consumers of typed and aliased mock installers: %s", (installer) => {
    withTinyGitRepo(
      {
        "src/owner/runtime.ts": "export const old = 1;",
        "src/owner/runtime.test.ts": "export {};",
        "test/installer.ts": installer,
        "test/layer.ts": 'import "./installer.js";',
        "test/consumer.test.ts": 'import "./layer.js";',
      },
      (cwd) => {
        const baseRef = gitTree(cwd);
        fs.appendFileSync(path.join(cwd, "src/owner/runtime.ts"), "export const added = 2;");
        expect(
          changedPlan(["src/owner/runtime.ts"], {
            cwd,
            baseRef,
            boundedOwners: true,
            runtimeOnly: true,
            aggressive: { maxDirectImporters: 1, maxDirectoryTests: 1 },
          }).targets,
        ).toContain("test/consumer.test.ts");
      },
    );
  });

  it("fails closed when current source cannot be read", () => {
    withTinyGitRepo(
      {
        "src/owner/runtime.ts": "export const old = 1;",
        "src/owner/runtime.test.ts": "export {};",
        "test/consumer.test.ts": 'vi.mock("../src/owner/runtime.js", () => ({ old: 1 }));',
      },
      (cwd) => {
        const baseRef = gitTree(cwd);
        const read = fs.readFileSync;
        const denied = Object.assign(new Error("Current source is unreadable"), { code: "EACCES" });
        const spy = vi.spyOn(fs, "readFileSync").mockImplementation((...args) => {
          if (args[0] === path.join(cwd, "src/owner/runtime.ts")) {
            throw denied;
          }
          return read(...args);
        });
        try {
          expect(() =>
            changedPlan(["src/owner/runtime.ts"], {
              cwd,
              baseRef,
              boundedOwners: true,
            }),
          ).toThrow(denied);
        } finally {
          spy.mockRestore();
        }
      },
    );
  });

  it.each([undefined, "missing-base"])(
    "keeps mock coverage when base %s is unavailable",
    (baseRef) => {
      withTinyGitRepo(
        {
          "src/owner/runtime.ts": "export const old = 1;",
          "src/owner/runtime.test.ts": "export {};",
          "test/consumer.test.ts": 'vi.mock("../src/owner/runtime.js", () => ({ old: 1 }));',
        },
        (cwd) => {
          expect(
            changedPlan(["src/owner/runtime.ts"], {
              cwd,
              baseRef,
              boundedOwners: true,
            }).targets,
          ).toContain("test/consumer.test.ts");
        },
      );
    },
  );
});

describe("test selector native source facts", () => {
  it("classifies runtime-worker descriptors by their declaration and self-reads", () => {
    const descriptor =
      '{ currentModuleUrl: import.meta.url, sourceWorkerName: "fixtures/worker", package: { name: "worker" } }';
    const sources = {
      "inline.ts": `function run() { return ${descriptor}; }`,
      "single.ts": `export const worker = ${descriptor} as const;`,
      "group.ts": `export const workers = {
        first: ${descriptor},
        second: { nested: { sourceWorkerName: "fixtures/second", package: {}, currentModuleUrl: import.meta.url } },
      } as const;`,
      "array.ts": `export const workers = [${descriptor}];`,
      "call.ts": `export const workers = register(${descriptor});`,
      "local.ts": `const worker = ${descriptor}; export { worker };`,
      "default.ts": `export default ${descriptor};`,
      "wrong-base.ts":
        'export const worker = { currentModuleUrl: someVariable, sourceWorkerName: "fixtures/wrong" };',
      "dynamic.ts":
        "export const worker = { currentModuleUrl: import.meta.url, sourceWorkerName: workerName };",
      "nested-base.ts":
        'const worker = { sourceWorkerName: "fixtures/wrong", nested: { currentModuleUrl: import.meta.url } };',
      "literal-reference.ts": `export const worker = ${descriptor}; const label = "worker"; unrelated.worker;`,
      "jsx.tsx":
        'export const view = <View />; const worker = { currentModuleUrl: otherUrl, sourceWorkerName: "fixtures/conservative" };',
      ...Object.fromEntries(
        ["worker", "worker.distWorkerPath", "worker[key]", "({ ...worker })"].map((read, index) => [
          `self-read-${index}.ts`,
          `export const worker = ${descriptor}; void ${read};`,
        ]),
      ),
    };
    withTinyFileTree(sources, (cwd) => {
      const facts = new Map(
        readSourceFacts(
          cwd,
          Object.keys(sources).map((file) => ({ file, parseImports: true })),
          [],
          1024 * 1024,
        ).map(({ file, imports, typeOnlyImports, workerExports }) => [
          file,
          { imports, typeOnlyImports, workerExports },
        ]),
      );
      const inline = { imports: ["./fixtures/worker.js"], typeOnlyImports: [], workerExports: [] };
      for (const file of [
        "inline.ts",
        "local.ts",
        "default.ts",
        ...[0, 1, 2, 3].map((index) => `self-read-${index}.ts`),
      ]) {
        expect(facts.get(file), file).toEqual(inline);
      }
      const expectedExports: Record<string, [string, string][]> = {
        "single.ts": [["worker", "fixtures/worker"]],
        "group.ts": [
          ["workers.first", "fixtures/worker"],
          ["workers.second", "fixtures/second"],
        ],
        "array.ts": [["workers", "fixtures/worker"]],
        "call.ts": [["workers", "fixtures/worker"]],
        "literal-reference.ts": [["worker", "fixtures/worker"]],
      };
      for (const [file, workerExports] of Object.entries(expectedExports)) {
        expect(facts.get(file), file).toEqual({
          imports: [],
          typeOnlyImports: [],
          workerExports,
        });
      }
      for (const file of ["wrong-base.ts", "dynamic.ts", "nested-base.ts"]) {
        expect(facts.get(file), file).toEqual({
          imports: [],
          typeOnlyImports: [],
          workerExports: [],
        });
      }
      expect(facts.get("jsx.tsx")).toEqual({
        imports: ["./fixtures/conservative.js"],
        typeOnlyImports: [],
        workerExports: [],
      });
    });
  });

  const descriptorReads: Array<[string, Array<[string, string[]]>]> = [
    ['import { group as local } from "source"; void local.member;', [["source", ["group.member"]]]],
    [
      'import { group } from "source"; Object.values(group); void group[key];',
      [["source", ["group"]]],
    ],
    ['import { group } from "source"; void { ...group };', [["source", ["group"]]]],
    [
      'import { group } from "source"; void { ...group }; void { group }; const { member } = group; typeof group; group?.member;',
      [["source", ["group"]]],
    ],
    [
      'import * as ns from "source"; void ns.group.member; void ns.single;',
      [["source", ["group.member", "single"]]],
    ],
    ['import * as ns from "source"; void ns[key];', [["source", ["*"]]]],
    [
      'import("dynamic"); require("required"); export * from "all";',
      [
        ["dynamic", ["*"]],
        ["required", ["*"]],
        ["all", ["*"]],
      ],
    ],
    ['export { group as renamed, single } from "source";', [["source", ["group", "single"]]]],
    [
      'import type { group } from "types"; import { type single, group as local } from "source"; void group; void single; void local.member;',
      [["source", ["group.member"]]],
    ],
    [
      'import local from "source"; void local.member; import { unused } from "unused"; const text = "unused"; other.unused;',
      [],
    ],
    ['import { group } from "source"; const view = <View />;', [["source", ["*"]]]],
  ];
  it.each(descriptorReads)(
    "reads runtime-worker descriptor consumption in %s",
    (source, expected) => {
      expect([...readDescriptorUses(source)]).toEqual(expected);
    },
  );

  it("keeps whole-area UI consumers and source readers across graph cache scopes", () => {
    const pluginModule = "extensions/example/browser/view.ts";
    const pluginConsumer = "test/plugin-browser-consumer.test.ts";
    // This import belongs to the virtual repository, not this test's module graph.
    const pluginImport = path.posix
      .relative(path.posix.dirname(pluginConsumer), pluginModule)
      .replace(/\.ts$/u, ".js");
    withTinyGitRepo(
      {
        "src/owner/value.ts": "export const value = 1;\n",
        "ui/src/presenter.ts": 'export { value } from "../../src/owner/value.js";\n',
        "ui/src/catalog.json": '{"label":"Changed dynamically loaded data"}\n',
        "ui/src/catalog-extra.json": '{"label":"Another dynamically loaded catalog"}\n',
        "ui/src/presenter.test.ts": 'import { value } from "./presenter.js"; void value;\n',
        [pluginModule]: "export const view = 1;\n",
        "src/consumer.test.ts": 'import { value } from "../ui/src/presenter.js"; void value;\n',
        "scripts/ui-consumer.mjs": 'export { value } from "../ui/src/presenter.js";\n',
        "test/scripts/ui-consumer.test.ts":
          'import { value } from "../../scripts/ui-consumer.mjs"; void value;\n',
        [pluginConsumer]: `import { view } from ${JSON.stringify(pluginImport)}; void view;\n`,
        "test/scripts/ui-catalog-reader.test.ts":
          'import { readFileSync } from "node:fs"; readFileSync("ui/src/catalog.json", "utf8");\n',
        "test/scripts/ui-extra-reader.test.ts":
          'import { readFileSync } from "node:fs"; readFileSync("ui/src/catalog-extra.json", "utf8");\n',
        "test/scripts/ui-shared-reader.test.ts":
          'import { readFileSync } from "node:fs"; ["ui/src/catalog.json", "ui/src/catalog-extra.json"].map((file) => readFileSync(file, "utf8"));\n',
        "test/ui-consumer.live.test.ts": 'import "../ui/src/presenter.js";\n',
        "src/unrelated.test.ts": "export {};\n",
      },
      (cwd) => {
        const sourcePlan = () =>
          changedPlan(["src/owner/value.ts"], {
            cwd,
            forceFullImportGraph: true,
          });
        const expectedSourcePlan = {
          mode: "targets",
          targets: ["src/consumer.test.ts", "ui/src/presenter.test.ts"],
        };
        expect(sourcePlan()).toEqual(expectedSourcePlan);
        const graphConsumers = [
          "src/consumer.test.ts",
          "test/plugin-browser-consumer.test.ts",
          "test/scripts/ui-consumer.test.ts",
        ];
        expect(uiConsumers(["ui/src/catalog.json"], cwd)).toEqual([
          ...graphConsumers,
          "test/scripts/ui-catalog-reader.test.ts",
          "test/scripts/ui-shared-reader.test.ts",
        ]);
        expect(
          uiConsumers(
            ["ui/src/catalog.json", "ui/src/catalog-extra.json", "ui/src/catalog.json"],
            cwd,
          ),
        ).toEqual([
          ...graphConsumers,
          "test/scripts/ui-catalog-reader.test.ts",
          "test/scripts/ui-shared-reader.test.ts",
          "test/scripts/ui-extra-reader.test.ts",
        ]);
        expect(uiConsumers(["ui/src/catalog-extra.json", "ui/src/catalog.json"], cwd)).toEqual([
          ...graphConsumers,
          "test/scripts/ui-extra-reader.test.ts",
          "test/scripts/ui-shared-reader.test.ts",
          "test/scripts/ui-catalog-reader.test.ts",
        ]);
        expect(sourcePlan()).toEqual(expectedSourcePlan);
      },
    );
  });

  it("separates executable imports from source fixtures and erased type declarations", () => {
    const regexContexts = {
      arrow: `const pattern = () => /['"]/;`,
      asyncArrow: `const pattern = async () => /['"]/;`,
      typeof: `const pattern = typeof /['"]/;`,
      void: `const pattern = void /['"]/;`,
      delete: `const pattern = delete /['"]/.source;`,
      binary: `const pattern = 1 + /['"]/.source;`,
      comparison: `const pattern = 1 < /['"]/.source;`,
      if: `if (true) /['"]/.test('');`,
      while: `while (false) /['"]/.test('');`,
      ifBlock: `if (true) {} /['"]/.test('');`,
      functionDeclaration: `function example() {} /['"]/.test('');`,
      asyncDeclaration: `async function example() {} /['"]/.test('');`,
      classDeclaration: `class Example {} /['"]/.test('');`,
      classExtends: `class Example extends factory({}) {} /['"]/.test('');`,
      labeledBlock: `label: {} /['"]/.test('');`,
      caseBlock: `switch (1) { case 1: {} /['"]/.test(''); }`,
      asiDeclaration: `const value = 1\nfunction example() {} /['"]/.test('');`,
    };
    const divisionContexts = {
      object: `const value = ({}) / await import('./during.js') / 2;`,
      function: `const value = function() {} / await import('./during.js') / 2;`,
      asyncFunction: `const value = async function() {} / await import('./during.js') / 2;`,
      class: `const value = class {} / await import('./during.js') / 2;`,
      arrowBody: `const value = (() => {}) / await import('./during.js') / 2;`,
      increment: `let value = 1; value++ / await import('./during.js') / 2;`,
      decrement: `let value = 1; value-- / await import('./during.js') / 2;`,
    };
    const syntaxFiles = Object.fromEntries(
      Object.entries({ ...regexContexts, ...divisionContexts }).map(([name, prefix]) => [
        `${name}.ts`,
        `${prefix}\nawait import('./consumer.js');`,
      ]),
    );
    syntaxFiles["ambiguous-template.ts"] =
      `${regexContexts.labeledBlock} await import(\`./template-consumer.js\`);`;
    syntaxFiles["generic-callback.ts"] = "export type Callback = <T>(value: T) => T;";
    syntaxFiles["generic-callback-import.ts"] =
      'export type Callback = <T>(value: T) => import("./callback-type.js").Value;';
    withTinyFileTree(
      {
        ...syntaxFiles,
        "source.ts": [
          '// import "./comment.js";',
          '/* export * from "./block-comment.js"; */',
          `const fixture = 'import "./quoted.js";';`,
          'const template = `import "./template.js"; ${import("./expression.js")}`;',
          String.raw`const pattern = /import "\.\/regexp\.js"/;`,
          'import type { Value } from "./types.js";',
          'export type * from "./reexport-types.js";',
          'import { type Value, type Other as Alias } from "./named-types.js";',
          'import { type Value, runtime } from "./mixed.js";',
          'type Shape = typeof import("./import-type.js");',
          'interface Options { input: import("./interface-type.js").Value }',
          'const runtimeTypeof = typeof import("./runtime-expression.js");',
          'import type from "./default-value.js";',
          'import {} from "./side-effect.js";',
          'import { type as value } from "./named-value.js";',
          'export { type Value } from "./shared.js";',
          'import "./shared.js";',
          'import /* boundary */ "./real.js";',
        ].join("\n"),
      },
      (cwd) => {
        const [facts, ...syntaxFacts] = readSourceFacts(
          cwd,
          [
            { file: "source.ts", parseImports: true },
            ...Object.keys(syntaxFiles).map((file) => ({ file, parseImports: true })),
          ],
          [],
          16 * 1024 * 1024,
        );
        expect(facts?.imports).toEqual([
          "./expression.js",
          "./types.js",
          "./reexport-types.js",
          "./named-types.js",
          "./mixed.js",
          "./import-type.js",
          "./interface-type.js",
          "./runtime-expression.js",
          "./default-value.js",
          "./side-effect.js",
          "./named-value.js",
          "./shared.js",
          "./real.js",
        ]);
        expect(facts?.typeOnlyImports).toEqual([
          "./types.js",
          "./reexport-types.js",
          "./import-type.js",
          "./interface-type.js",
        ]);
        const importsByFile = new Map(syntaxFacts.map(({ file, imports }) => [file, imports]));
        expect(syntaxFacts.find(({ file }) => file === "generic-callback.ts")).toMatchObject({
          imports: [],
          typeOnlyImports: [],
          mocks: [],
          workerExports: [],
        });
        expect(syntaxFacts.find(({ file }) => file === "generic-callback-import.ts")).toMatchObject(
          {
            imports: ["./callback-type.js"],
            typeOnlyImports: ["./callback-type.js"],
          },
        );
        expect(importsByFile.get("ambiguous-template.ts")).toEqual(["./template-consumer.js"]);
        for (const [name, source] of Object.entries(regexContexts)) {
          expect(importsByFile.get(`${name}.ts`), source).toEqual(["./consumer.js"]);
        }
        for (const [name, source] of Object.entries(divisionContexts)) {
          expect(importsByFile.get(`${name}.ts`), source).toEqual(["./during.js", "./consumer.js"]);
        }
      },
    );
  });

  it("preserves literal matches and whole-token references across a native source batch", () => {
    const sources = {
      "empty.txt": "",
      "overlap.txt": "ushers ababa",
      "paths.txt": "scripts/tool.mts @scope/name+tag_value-1.0 xabcdy abcd",
      "unicode.txt": "éabcd😀foo/bar中 abc😀xyz",
      "embedded.txt": "xabcdy scripts/tool.mts scripts/tool abcd",
      "binary.txt": "null\0abcd\0tail",
      "repeated.txt": "aaaaaaaaa aba aaa aaaa",
      "late-references.txt":
        "ushers ababa xabcdy scripts/tool.mts @scope/name+tag_value-1.0 xfoo/bary 😀 null\0 aaaaaa absent\n abcd scripts/tool foo/bar aaaa",
    };
    const terms = [
      "",
      "he",
      "she",
      "hers",
      "aba",
      "ba",
      "aba",
      "abcd",
      "bcd",
      "scripts/tool",
      "scripts/tool.mts",
      "@scope/name+tag_value-1.0",
      "foo/bar",
      "😀",
      "\ud83d",
      "\ude00",
      // Failure links cross between dense ASCII rows and sparse non-ASCII edges.
      "d😀foo",
      "中 abc",
      "😀xyz",
      "é😀",
      "null\0",
      "aaa",
      "aaaa",
      "absent",
    ];
    withTinyFileTree(sources, (cwd) => {
      const files = Object.keys(sources).map((file) => ({ file, parseImports: false }));
      const expected = Object.entries(sources).map(([file, source]) => {
        const tokens = new Set(source.match(/[A-Za-z0-9_.@+/-]{4,}/gu));
        return {
          file,
          imports: [],
          typeOnlyImports: [],
          mocks: [],
          workerExports: [],
          matches: terms.filter((term) => source.includes(term)),
          references: terms.filter((term) => tokens.has(term)),
        };
      });
      expect(readSourceFacts(cwd, files, terms, 1024 * 1024)).toEqual(expected);
    });
  });

  it("keeps request order across a striped multi-worker source scan", () => {
    // Enough files for several scan workers; each row must return to its request slot.
    const rows = Array.from({ length: 600 }, (_, index) => ({
      file: `f${String(index).padStart(3, "0")}.ts`,
      dependency: `./dep-${index}.js`,
      readable: index % 7 !== 3,
      matched: index % 3 === 0,
    }));
    const sources = Object.fromEntries(
      rows
        .filter(({ readable }) => readable)
        .map(({ file, dependency, matched }) => [
          file,
          `import "${dependency}";\n${matched ? "// needle\n" : ""}`,
        ]),
    );
    withTinyFileTree(sources, (cwd) => {
      const files = rows.map(({ file }) => ({ file, parseImports: true }));
      expect(
        readSourceFacts(cwd, files, ["needle"], 16 * 1024 * 1024, {
          matchingOnly: true,
        }),
      ).toEqual(
        rows
          .filter(({ readable, matched }) => readable && matched)
          .map(({ file, dependency }) => ({
            file,
            imports: [dependency],
            typeOnlyImports: [],
            mocks: [],
            workerExports: [],
            matches: ["needle"],
            references: ["needle"],
          })),
      );
      expect(readSourceFacts(cwd, files, [], 16 * 1024 * 1024)).toEqual(
        rows
          .filter(({ readable }) => readable)
          .map(({ file, dependency }) => ({
            file,
            imports: [dependency],
            typeOnlyImports: [],
            mocks: [],
            workerExports: [],
            matches: [],
            references: [],
          })),
      );
    });
  });

  it("reads complete files without installed packages, inherited hooks, or reparsing cached imports", () => {
    withTinyFileTree(
      {
        "unterminated.ts": '// "\nconst value = "\\u{000',
        "large.mts": `${"// padding\n".repeat(220_000)}export type {\n Value\n } from "./barrel.js";\nimport(\n "./dynamic.mjs"\n);\nconst fixture = "scripts/tool.mts";\nnew URL(\n "./native-fixture.mjs?generation=1#child", import.meta.url,\n);\nnew URL("./other-base.mjs", "file:///elsewhere/");\nrequire("dependency/runtime");\nrequire.resolve("dependency/package.json");\nimport.meta.resolve("other-dependency");`,
      },
      (cwd) => {
        const files = [
          { file: "large.mts", parseImports: true },
          { file: "unterminated.ts", parseImports: true },
          { file: "deleted.ts", parseImports: true },
        ];
        // Rows omit empty descriptor exports; parsed facts restore them.
        const unterminatedFacts = {
          imports: [],
          typeOnlyImports: [],
          mocks: [],
          matches: [],
          references: [],
        };
        const expectedFacts = {
          imports: [
            "./barrel.js",
            "./dynamic.mjs",
            "./native-fixture.mjs",
            "dependency/runtime",
            "dependency/package.json",
            "other-dependency",
          ],
          typeOnlyImports: ["./barrel.js"],
          mocks: [],
          matches: ["scripts/tool.mts", "scripts/tool"],
          references: ["scripts/tool.mts"],
        };
        for (const file of [
          "scripts/lib/test-selector-source-facts.mts",
          "scripts/lib/test-source-term-matcher.mts",
          "src/infra/node-runtime-executable.ts",
        ]) {
          const target = path.join(cwd, file);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.copyFileSync(path.resolve(file), target);
        }
        const scanner = path.join(
          fs.realpathSync(cwd),
          "scripts/lib/test-selector-source-facts.mts",
        );
        const native = spawnSync(requireNodeTool("node"), [scanner], {
          cwd,
          input: JSON.stringify({ files, terms: ["scripts/tool.mts", "scripts/tool"] }),
          encoding: "utf8",
          // A malformed escape must not rewind the scanner's cursor forever.
          timeout: 5_000,
        });
        expect(native.error).toBeUndefined();
        expect(native.status, native.stderr).toBe(0);
        expect(JSON.parse(native.stdout)).toEqual([expectedFacts, unterminatedFacts, null]);
        vi.stubEnv(
          "NODE_OPTIONS",
          "--import=data:text/javascript,throw%20Error('inherited-loader')",
        );
        try {
          expect(
            readSourceFacts(cwd, files, ["scripts/tool.mts", "scripts/tool"], 16 * 1024 * 1024, {
              matchingOnly: true,
            }),
          ).toEqual([{ file: "large.mts", ...expectedFacts, workerExports: [] }]);
          expect(
            readSourceFacts(cwd, files, ["scripts/tool.mts", "scripts/tool"], 16 * 1024 * 1024),
          ).toEqual([
            { file: "large.mts", ...expectedFacts, workerExports: [] },
            { file: "unterminated.ts", ...unterminatedFacts, workerExports: [] },
          ]);
          expect(
            readSourceFacts(
              cwd,
              [{ file: "large.mts", parseImports: false }],
              ["scripts/tool.mts"],
              16 * 1024 * 1024,
            ),
          ).toEqual([
            {
              file: "large.mts",
              imports: [],
              typeOnlyImports: [],
              mocks: [],
              workerExports: [],
              matches: ["scripts/tool.mts"],
              references: ["scripts/tool.mts"],
            },
          ]);
        } finally {
          vi.unstubAllEnvs();
        }
      },
    );
  });

  it("fails loudly on child launch, output overflow, and invalid native requests", () => {
    withTinyFileTree({ "value.ts": 'import "./dependency.js";' }, (cwd) => {
      const files = [{ file: "value.ts", parseImports: true }];
      expect(() => readSourceFacts(path.join(cwd, "missing"), files, [], 1024)).toThrow(
        "Test selector source scan failed",
      );
      expect(() => readSourceFacts(cwd, files, [], 1)).toThrow("Test selector source scan failed");
      const result = spawnSync(
        requireNodeTool("node"),
        [path.resolve("scripts/lib/test-selector-source-facts.mts")],
        {
          cwd,
          input: '{"files":false}',
          encoding: "utf8",
        },
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("[test-selector-source-facts] FAILED (exit 1)");
    });
  });
});

describe("scripts/test-projects full-suite sharding", () => {
  function expectChunkedFiles(
    plans: ReturnType<typeof planFullSuite>,
    files: string[],
    limit: number,
  ) {
    expect(plans.every((plan) => plan.forwardedArgs.length <= limit)).toBe(true);
    expect(plans.flatMap((plan) => plan.forwardedArgs).toSorted()).toEqual(
      [...new Set(files)].toSorted(),
    );
  }

  const fastTooling = {
    config: configFile("tooling"),
    includePatterns: ["test/scripts/run-with-env.test.ts"],
  };
  const slowTooling = {
    ...fastTooling,
    includePatterns: ["test/scripts/vitest-worker-artifacts.test.ts"],
  };
  const runtime = {
    config: configFile("runtime-config"),
    includePatterns: ["src/config/sessions/session-accessor.sqlite-archive.worker.test.ts"],
  };
  it.each([
    [
      "null whole-config selection",
      fastTooling,
      { config: configFile("gateway"), includePatterns: null },
    ],
    [
      "empty whole-config selection",
      fastTooling,
      { config: configFile("gateway"), includePatterns: [] },
    ],
    ["expensive selected files", runtime, slowTooling],
    [
      "expanded chunks",
      { ...runtime, includePatterns: null },
      { ...slowTooling, includePatterns: null, timingTargets: slowTooling.includePatterns },
    ],
  ] as const)("prioritizes %s", (_name, cheaper, expensive) => {
    expect(orderFullSuiteSpecsForParallelRun([cheaper, expensive])).toEqual([expensive, cheaper]);
  });

  it("uses observed selection timings without substituting a whole-config sample", () => {
    const timings = new Map([
      [fastTooling.config, 1_000_000],
      [resolveShardTimingKey(fastTooling), 500],
      [resolveShardTimingKey(slowTooling), 153_000],
      [resolveShardTimingKey(runtime), 35_000],
    ]);
    expect(orderFullSuiteSpecsForParallelRun([fastTooling, slowTooling, runtime], timings)).toEqual(
      [slowTooling, fastTooling, runtime],
    );
  });

  it("raises the effective last aggregate extension heap override", () => {
    const specs = applyFullExtensionsHeapBudget([
      {
        config: configFile("full-extensions"),
        env: { NODE_OPTIONS: "--max-old-space-size=12288 --max_old_space_size=4096" },
      },
    ]);

    expect(specs[0]?.env.NODE_OPTIONS).toBe("--max-old-space-size=12288 --max_old_space_size=8192");
  });

  it.each([false, true])("bounds full-suite CI processes for Testbox=%s", (testbox) => {
    vi.stubEnv("CI", "1");
    vi.stubEnv("GITHUB_ACTIONS", "");
    vi.stubEnv("OPENCLAW_TESTBOX_REMOTE_RUN", testbox ? "1" : "");
    vi.stubEnv("OPENCLAW_TEST_PROJECTS_LEAF_SHARDS", "");
    vi.stubEnv("OPENCLAW_TEST_PROJECTS_PARALLEL", "");
    try {
      const plans = planFullSuite([], process.cwd());
      const configs = plans.map((plan) => plan.config);

      if (!testbox) {
        expect(configs).toContain(configFile("full-agentic"));
        expect(configs).toContain(configFile("full-extensions"));
        expect(configs).not.toContain(configFile("gateway-server"));
        expect(configs).not.toContain(configFile("extension-telegram"));
        return;
      }
      expect(configs).not.toContain(configFile("full-agentic"));
      expect(configs).not.toContain(configFile("full-extensions"));
      expect(configs).toContain(configFile("agents-core"));
      expect(configs).toContain(configFile("extension-telegram"));

      const targetedPlans = (config: string) =>
        plans.filter((plan) => plan.config === config && plan.forwardedArgs.length > 0);
      expect(targetedPlans(configFile("agents-core"))).toHaveLength(6);
      expect(
        targetedPlans(configFile("agents-core")).flatMap((plan) => plan.forwardedArgs),
      ).not.toContain("src/agents/agent-command-local.test.ts");
      expect(configs.filter((config) => config === configFile("cli-process"))).toHaveLength(1);
      const gatewayTargets = targetedPlans(configFile("gateway-server")).map(
        (plan) => plan.forwardedArgs,
      );
      expect(gatewayTargets.every((files) => files.length > 0 && files.length <= 16)).toBe(true);
      expect(gatewayTargets.flat()).toEqual(
        listGitTrackedFiles({ pathspecs: "src/gateway" })
          ?.filter(isGatewayServerTestFile)
          .toSorted((a, b) => a.localeCompare(b)),
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("expands untargeted local runs to leaf project configs by default", async () => {
    const infraConfig = configFile("infra");
    const infraFiles = await listVitestConfigTestFiles(infraConfig);
    const toolingFiles = await listVitestConfigTestFiles(configFile("tooling"));
    const uiFiles = await listVitestConfigTestFiles(configFile("ui"));
    const gatewayFiles = await listVitestConfigTestFiles(configFile("gateway-database-workers"));
    const extensionDatabaseFiles = await listVitestConfigTestFiles(
      configFile("extension-database-workers"),
    );
    withEnv(
      {
        OPENCLAW_TEST_PROJECTS_LEAF_SHARDS: undefined,
        OPENCLAW_TEST_PROJECTS_PARALLEL: undefined,
        OPENCLAW_TEST_PROJECTS_SERIAL: undefined,
        CI: undefined,
        GITHUB_ACTIONS: undefined,
        OPENCLAW_VITEST_MAX_WORKERS: undefined,
        OPENCLAW_TEST_WORKERS: undefined,
      },
      () => {
        const plans = planFullSuite([], process.cwd());
        const configs = plans.map((plan) => plan.config);

        expect(configs).toContain(configFile("gateway-server"));
        expect(configs).toContain(configFile("extension-telegram"));
        expect(configs).not.toContain(configFile("full-agentic"));
        expect(configs).not.toContain(configFile("full-core-unit-fast"));

        const targetedPlans = (config: string) =>
          plans.filter((plan) => plan.config === config && plan.forwardedArgs.length > 0);
        const unitFastPlans = targetedPlans(configFile("unit-fast"));
        expect(unitFastPlans.length).toBeGreaterThan(1);
        expect(unitFastPlans.every((plan) => plan.forwardedArgs.length <= 70)).toBe(true);
        const unitSrcPlans = targetedPlans(configFile("unit-src"));
        expect(unitSrcPlans.length).toBeGreaterThan(1);
        expect(unitSrcPlans.every((plan) => plan.forwardedArgs.length <= 150)).toBe(true);
        const toolingPlans = targetedPlans(configFile("tooling"));
        expect(toolingPlans.length).toBeGreaterThan(1);
        expect(toolingPlans).toHaveLength(Math.ceil(toolingFiles.length / 8));
        expectChunkedFiles(toolingPlans, toolingFiles, 8);
        const uiPlans = targetedPlans(configFile("ui"));
        expect(uiPlans).toHaveLength(Math.ceil(uiFiles.length / 8));
        expectChunkedFiles(uiPlans, uiFiles, 8);
        const gatewayPlans = targetedPlans(configFile("gateway-database-workers"));
        expect(gatewayPlans).toHaveLength(Math.ceil(gatewayFiles.length / 50));
        expectChunkedFiles(gatewayPlans, gatewayFiles, 50);
        const extensionDatabasePlans = targetedPlans(configFile("extension-database-workers"));
        expectChunkedFiles(extensionDatabasePlans, extensionDatabaseFiles, 20);
        expect(
          extensionDatabasePlans
            .filter((plan) =>
              plan.forwardedArgs.some((file) => file.startsWith("extensions/telegram/")),
            )
            .every((plan) => plan.forwardedArgs.length === 1),
        ).toBe(true);
        const infraPlans = plans.filter((plan) => plan.config === infraConfig);
        expect(infraPlans.length).toBeGreaterThan(1);
        expect(
          infraPlans.every(
            (plan) => plan.forwardedArgs.length > 0 && plan.forwardedArgs.length <= 64,
          ),
        ).toBe(true);
        expect(infraPlans.flatMap((plan) => plan.forwardedArgs).toSorted()).toEqual(
          [...new Set(infraFiles)].toSorted(),
        );
        const toolingTargets = toolingPlans.flatMap((plan) => plan.forwardedArgs);
        expect(toolingTargets.filter((file) => file.startsWith("test/fixtures/"))).toEqual([]);
        expect(plans.flatMap((plan) => plan.forwardedArgs)).toEqual(
          expect.arrayContaining(testFiles("test/scripts", "oxlint-boundary-guards ts-topology")),
        );
        for (const plan of plans.filter((entry) => entry.forwardedArgs.length > 0)) {
          expect(plan.timingTargets).toEqual(plan.forwardedArgs);
          expect(plan.includePatterns).toBeNull();
        }
      },
    );
  });

  it("preserves one database invocation when Vitest owns suite-wide sharding", () => {
    withEnv(
      { CI: undefined, GITHUB_ACTIONS: undefined, OPENCLAW_TEST_PROJECTS_PARALLEL: undefined },
      () => {
        const plans = planFullSuite(["--shard=1/2"], process.cwd()).filter(
          (plan) => plan.config === configFile("extension-database-workers"),
        );
        expect(plans).toHaveLength(1);
        expect(plans[0]?.forwardedArgs).toContain("--shard=1/2");
      },
    );
  });

  it("keeps shared Vitest config helpers out of whole-config targets", () => {
    const args = [configFile("shared")];

    expect(unmatchedTargets(args, process.cwd())).toEqual([]);
    expectRun(planRuns(args, process.cwd()), "tooling", {
      includePatterns: ["test/vitest/**/*.test.ts"],
    });

    withTinyFileTree({ [configFile("helper")]: "export default {};\n" }, (cwd) => {
      const helperArgs = [configFile("helper")];
      expect(unmatchedTargets(helperArgs, cwd)).toEqual([
        {
          target: configFile("helper"),
          reason: "target-matched-no-test-files",
          includePattern: "test/vitest/**/*.test.ts",
        },
      ]);
      expectRun(planRuns(helperArgs, cwd), "tooling", {
        includePatterns: ["test/vitest/**/*.test.ts"],
      });
    });
  });
});

describe("scripts/test-projects Vitest stall watchdog", () => {
  it("arms non-watch jobs without shortening the direct runner's slow-config watchdog", () => {
    const configs = [configFile("extension-feishu"), configFile("gateway-server")];
    const specs = applyDefaultVitestNoOutputTimeout(
      configs.map((config) => ({ config, env: {}, watchMode: false })),
      { env: {} },
    );

    for (const [index, spec] of specs.entries()) {
      const timeout = Number(spec.env.OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS);
      const heartbeat = Number(spec.env.OPENCLAW_VITEST_NO_OUTPUT_HEARTBEAT_MS);
      expect(timeout).toBeGreaterThan(0);
      expect(heartbeat).toBeGreaterThan(0);
      expect(heartbeat).toBeLessThan(timeout);
      expect(timeout).toBeGreaterThanOrEqual(
        resolveDefaultVitestNoOutputTimeoutMs(["run", "--config", configs[index]!]),
      );
    }
    expect(Number(specs[1]?.env.OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS)).toBeGreaterThan(
      Number(specs[0]?.env.OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS),
    );
  });
});
