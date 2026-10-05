import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assert, beforeAll, describe, expect, it, vi } from "vitest";
import { listExtensionTestFilesForRoots } from "../../scripts/lib/extension-test-plan.mts";
import { readTestSelectorSourceFacts } from "../../scripts/lib/test-selector-source-facts.mts";
import {
  listVitestRuntimeConsumerFiles,
  resolveVitestPretestBuildMode,
  resolveVitestRuntimeConfigScopes,
} from "../../scripts/lib/vitest-build-prerequisites.mts";
import { resolveDefaultVitestNoOutputTimeoutMs } from "../../scripts/lib/vitest-process-env.mts";
import { resolveVitestRuntimeCliSelections } from "../../scripts/lib/vitest-runtime-selection.mts";
import { resolveShardTimingKey } from "../../scripts/lib/vitest-shard-metadata.mts";
import { scriptModuleEntrypoints } from "../../scripts/script-module-runtime.test-support.mjs";
import {
  applyDefaultVitestNoOutputTimeout,
  applyFullExtensionsHeapBudget,
  buildFullSuiteVitestRunPlans,
  buildVitestRunPlans,
  createVitestRunSpecs,
  findUnmatchedExplicitTestTargets,
  hasImportGraphImpactOnTargets,
  isTestFileTarget,
  orderFullSuiteSpecsForParallelRun,
  parseTestProjectsArgs,
  resolveChangedTestTargetPlanForArgs,
  resolveChangedTestTargetPlan,
  resolveChangedTargetArgs,
  resolveAffectedTestsFromImportGraph,
  resolveControlUiTestConsumers,
  resolveDependencyTestConsumers,
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

const normalizeRepoPath = toRepoPath;
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
      expect(findUnmatchedExplicitTestTargets(targets)).toEqual([]);
      return {
        targets,
        configs: new Set(createVitestRunSpecs(targets, { baseEnv: {} }).map((spec) => spec.config)),
      };
    });
    assert(first && second);
    const targets = [...first.targets, ...second.targets];
    expect(new Set(targets).size).toBe(targets.length);
    // Tooling and infra own shared fixtures; the extension catch-all retains
    // separate plugin processes. The other projects share setup within one part.
    expect([...first.configs].filter((config) => second.configs.has(config))).toEqual([
      "test/vitest/vitest.tooling.config.ts",
      "test/vitest/vitest.infra.config.ts",
      "test/vitest/vitest.extensions.config.ts",
    ]);
  });
});

describe("test runtime prerequisites", () => {
  it.each([
    ["lifecycle file", ["extensions/qa-lab/src/suite-process-lifecycle.test.ts"], "private-qa"],
    [
      "cold identity child",
      ["extensions/qa-lab/src/agent-run-identity-repeated-turn-child.process.test.ts"],
      "private-qa",
    ],
    ["full local suite", [], "private-qa"],
    ["Windows Claude CLI process", ["src/process/exec.windows.integration.test.ts"], "runtime"],
    ["agent command child", ["src/agents/agent-command-local.test.ts"], "runtime"],
    ["process config", ["test/vitest/vitest.process.config.ts"], "runtime"],
    ["ordinary process unit", ["src/process/exec.windows.test.ts"], undefined],
    ["TUI native provider policy", ["src/tui/tui-session-identity-pty.e2e.test.ts"], "runtime"],
    ["TUI PTY config", ["test/vitest/vitest.tui-pty.config.ts"], "runtime"],
    ["ordinary TUI PTY test", ["src/tui/tui-text-wrap-pty.e2e.test.ts"], undefined],
    ["config startup SDK", ["src/config/config-startup-corpus.test.ts"], "runtime"],
    ["runtime config project", ["test/vitest/vitest.runtime-config.config.ts"], "runtime"],
    ["native direct loader SDK", ["src/plugins/loader.test.ts"], "runtime"],
  ] as const)("prepares only the prerequisite selected by %s", (_name, args, expected) => {
    const plans = args.length ? buildVitestRunPlans([...args]) : buildFullSuiteVitestRunPlans([]);
    expect(
      resolveVitestPretestBuildMode(
        plans.map((plan) => ({
          configs: [plan.config],
          includePatterns: plan.includePatterns,
        })),
      ),
    ).toBe(expected);
  });

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
    ["gateway-core", ["--exclude", "gateway-*.test.ts"], undefined],
    ["gateway", ["--exclude", "gateway-*.test.ts"], "runtime"],
    ["tooling", ["--exclude", "**/gateway-codex-delivery-cache.test.ts"], "runtime"],
    [
      "agents-core",
      resolveVitestRuntimeConfigScopes("test/vitest/vitest.agents-core.config.ts").flatMap(
        ({ file, dir }) => ["--exclude", path.posix.relative(dir, file)],
      ),
      undefined,
    ],
  ] as const)("binds %s prerequisites to CLI selection %j", (project, args, expected) => {
    expect(
      resolveVitestPretestBuildMode(
        resolveVitestRuntimeCliSelections(
          `test/vitest/vitest.${project}.config.ts`,
          ["run", ...args],
          {},
        ),
      ),
    ).toBe(expected);
  });

  it("keeps Gateway worker runtime selection rooted at the repository for src/gateway/setup-inference.first-signin.integration.test.ts", () => {
    const file = "src/gateway/setup-inference.first-signin.integration.test.ts";
    const config = "test/vitest/vitest.gateway-database-workers.config.ts";
    expect(listVitestRuntimeConsumerFiles([config])).toContain(file);
    expect(
      listVitestRuntimeConsumerFiles(["test/vitest/vitest.gateway-methods.config.ts"]),
    ).not.toContain(file);
    expect(
      resolveVitestPretestBuildMode(resolveVitestRuntimeCliSelections(config, ["run", file], {})),
    ).toBe("runtime");
    expect(
      resolveVitestPretestBuildMode(
        resolveVitestRuntimeCliSelections(config, ["run", file, "--exclude", file], {}),
      ),
    ).toBeUndefined();
  });

  it.each([
    [
      "gateway-server",
      "src/gateway/server-request-context.test.ts",
      "src/gateway/server-sidecar-retention.test.ts",
    ],
    ["gateway-database-workers", "src/gateway/server-methods/cron.runs.test.ts", freshnessFile],
  ])("projects invocation-owned include files under %s", (project, ordinaryFile, runtimeFile) => {
    const selections = resolveVitestRuntimeCliSelections(
      `test/vitest/vitest.${project}.config.ts`,
      ["run"],
      {},
    );
    for (const selection of selections) {
      selection.includePatterns = [ordinaryFile];
    }
    expect(resolveVitestPretestBuildMode(selections)).toBeUndefined();
    for (const selection of selections) {
      selection.includePatterns = [runtimeFile];
    }
    expect(resolveVitestPretestBuildMode(selections)).toBe("runtime");
  });

  it("combines private QA and runtime readers into one private build", () => {
    expect(
      resolveVitestPretestBuildMode([
        { includePatterns: ["test/e2e/qa-lab/runtime/**/*.test.ts"] },
        { includePatterns: ["extensions/qa-lab/**/*.test.ts"] },
      ]),
    ).toBe("private-qa");
    expect(resolveVitestPretestBuildMode([])).toBeUndefined();
    expect(resolveVitestPretestBuildMode([{ configs: ["test/vitest/vitest.config.ts"] }])).toBe(
      "private-qa",
    );
  });
});

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

function expectChangedTargets(changedPaths: string[], targets: string[]): void {
  expect(resolveChangedTestTargetPlan(changedPaths), changedPaths.join(", ")).toEqual({
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

function expectSingleVitestRunPlan(
  actual: ReturnType<typeof buildVitestRunPlans>,
  expected: {
    config: string;
    forwardedArgs?: string[];
    includePatterns?: string[] | null;
    watchMode?: boolean;
  },
): void {
  expect(actual).toEqual([
    {
      config: expected.config,
      forwardedArgs: expected.forwardedArgs ?? [],
      includePatterns: expected.includePatterns ?? null,
      watchMode: expected.watchMode ?? false,
    },
  ]);
}

describe("scripts/test-projects changed-target routing", () => {
  beforeAll(() => {
    buildVitestRunPlans(["src/commands/onboard-non-interactive.test-helpers.ts"]);
    findUnmatchedExplicitTestTargets(["test/vitest/vitest.shared.config.ts"], process.cwd());
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

        expectSingleVitestRunPlan(buildVitestRunPlans([target], cwd), {
          config: "test/vitest/vitest.unit.config.ts",
          forwardedArgs: [`${target}.extra.spec.mts`, `${target}.test.ts`],
        });
        expect(findUnmatchedExplicitTestTargets([target], cwd)).toEqual([]);

        fs.unlinkSync(path.join(cwd, `${target}.extra.spec.mts`));
        expectSingleVitestRunPlan(buildVitestRunPlans([target], cwd), {
          config: "test/vitest/vitest.unit.config.ts",
          forwardedArgs: [`${target}.test.ts`],
          includePatterns: [`${target}.test.ts`],
        });
        expect(findUnmatchedExplicitTestTargets([target], cwd)).toEqual([]);

        fs.unlinkSync(path.join(cwd, `${target}.test.ts`));
        expect(findUnmatchedExplicitTestTargets([target], cwd)).toEqual([
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
      resolveChangedTargetArgs(["--changed", "origin/main"], process.cwd(), () => [
        "test/deleted-changed-target.test.ts",
      ]),
    ).toStrictEqual([]);
  });

  it.each([
    [
      "test/vitest/vitest.shared.config.ts",
      "src/utils/provider-utils.ts",
      "src/utils/provider-utils.test.ts",
    ],
    ["package.json", "src/commands/channels.add.ts", "src/commands/channels.add.test.ts"],
  ])("records skipped broad fallback %s beside precise source %s", (fallback, source, target) => {
    expect(resolveChangedTestTargetPlan([fallback, source])).toEqual({
      mode: "targets",
      skippedBroadFallbackPaths: [fallback],
      targets: [target],
    });
  });

  it.each<[string[], string[]]>([
    [["src/plugin-sdk/provider-entry.ts"], ["src/plugin-sdk/provider-entry.test.ts"]],
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
      ["test/scripts/build-and-run-mac.test.ts", "test/scripts/restart-mac.test.ts"],
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
        expect(
          resolveChangedTestTargetPlan([`scripts/nested/fixture.${extension}`], { cwd }),
        ).toEqual({
          mode: "targets",
          targets: [
            "test/scripts/nested/fixture.test.ts",
            "test/scripts/nested-fixture.test.ts",
            "test/scripts/fixture.test.ts",
            "src/scripts/nested/fixture.test.ts",
            "src/scripts/nested-fixture.test.ts",
            "src/scripts/fixture.test.ts",
          ],
        });
        expect(
          resolveChangedTestTargetPlan([`scripts/fixture.${extension}`], { cwd }).targets,
        ).toEqual(["test/scripts/fixture.test.ts", "src/scripts/fixture.test.ts"]);
        expect(
          resolveChangedTestTargetPlan([`scripts/unowned.${extension}`], { cwd }).targets,
        ).toEqual(["test/vitest/vitest.tooling.config.ts"]);
      },
    );
  });

  it("routes unmatched script changes to the tooling suite instead of skipping tests", () => {
    const targets = ["scripts/check-no-raw-http2-imports.mts"];

    expectChangedTargets(targets, ["test/vitest/vitest.tooling.config.ts"]);
    expectSingleVitestRunPlan(
      buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => targets),
      { config: "test/vitest/vitest.tooling.config.ts" },
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
        const targets = resolveChangedTestTargetPlan(
          [".github/workflows/full-release-validation.yml"],
          { cwd },
        ).targets;

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
      exactTargets: [
        "test/scripts/plugin-npm-extended-stable-workflow.test.ts",
        "test/scripts/plugin-release-git-lifecycle.test.ts",
      ],
    },
    {
      changedPath: ".github/actions/setup-node-env/action.yml",
      exactTargets: [
        "test/scripts/setup-node-env-bun.test.ts",
        "test/scripts/setup-node-env-semantic-memory.test.ts",
      ],
    },
  ])("unions exact owners and references for $changedPath", ({ changedPath, exactTargets }) => {
    withTinyGitRepo(
      {
        [changedPath]: "name: fixture\n",
        "test/scripts/direct-workflow-reference.test.ts": `const target = "${changedPath}";\n`,
      },
      (cwd) => {
        const targets = resolveChangedTestTargetPlan([changedPath], { cwd }).targets;

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
        const targets = resolveChangedTestTargetPlan(["scripts/pr"], { cwd }).targets;

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
          expect(
            resolveChangedTestTargetPlan([".github/actionlint.yaml"], {
              cwd,
              forceFullImportGraph: true,
              resolveAliases: true,
              runtimeOnly: true,
            }),
          ).toEqual({
            mode: "targets",
            targets: withConsumers
              ? ["test/scripts/lint-import.test.ts", "test/scripts/lint-reader.test.ts"]
              : [],
          });
          expect(
            resolveChangedTestTargetPlan([".github/unknown-lint.yaml"], { cwd }).targets,
          ).toEqual(["test/vitest/vitest.tooling.config.ts"]);
        },
      );
    }
  });

  it("keeps CI scope edits on owner tests", () => {
    const changedScopeTestFamily = fs
      .readdirSync("src/scripts")
      .filter((file) => /^ci-changed-scope(?:\.[^/]+)?\.test\.ts$/u.test(file))
      .map((file) => `src/scripts/${file}`)
      .toSorted((left, right) => left.localeCompare(right));
    expectChangedTargets(
      ["scripts/ci-changed-scope.mjs"],
      [...changedScopeTestFamily, "test/scripts/control-ui-i18n.test.ts"],
    );
  });

  it.each<{
    file: string;
    owner: string;
    source?: string;
    inventory?: readonly string[];
  }>([
    {
      file: "src/gateway/server-startup-early.test.ts",
      owner: "gateway-server",
      source: "src/gateway/server-startup-early.ts",
    },
    {
      file: "src/commands/onboarding-plugin-install.test.ts",
      owner: "commands",
      source: "src/commands/onboarding-plugin-install.ts",
    },
    { file: "src/agents/cli-runner/bundle-mcp.user-config.test.ts", owner: "agents-core-isolated" },
    {
      file: "src/agents/subagents/spawn/subagent-spawn.production-boundary.test.ts",
      owner: "agents-spawn-production-boundary",
    },
    { file: "src/agents/agent-command-local.test.ts", owner: "cli-process" },
    ...[
      "src/gateway/health/collector.queue-health.test.ts",
      "src/gateway/provider-auth-account-relogin.persistence.integration.test.ts",
      "src/gateway/server-methods/server-methods.test.ts",
    ].map((file) => ({
      file,
      owner: "gateway-database-workers",
      inventory: gatewayDatabaseWorkerTestFiles,
    })),
    ...[
      "src/agents/command/session-store.test.ts",
      "src/agents/embedded-agent-runner/run-entry.cyber-failover.runner.test.ts",
      "src/agents/models-config.providers.endpoint.test.ts",
      "src/agents/models-config.root-authorship.test.ts",
      "src/agents/models-config.runtime-source-snapshot.test.ts",
      "src/agents/models-config.write-serialization.test.ts",
      "src/agents/plugin-model-catalog-auth.test.ts",
      "src/agents/plugin-model-catalog.test.ts",
      "src/agents/prepared-model-catalog-worker.agent-database.integration.test.ts",
      "src/agents/prepared-model-catalog-worker.heap.integration.test.ts",
      "src/agents/prepared-model-catalog-worker.workspace-heap.integration.test.ts",
      "src/state/openclaw-state-db.test.ts",
      "src/worker/worker.runtime.test.ts",
      "test/cron-conversation-delivery.codex.integration.test.ts",
    ].map((file) => ({ file, owner: "infra", inventory: databaseWorkerCoreTestFiles })),
  ])("routes $file to $owner", ({ file, owner, source, inventory }) => {
    expectSingleVitestRunPlan(buildVitestRunPlans([source ?? file]), {
      config: `test/vitest/vitest.${owner}.config.ts`,
      includePatterns: [file],
    });
    if (inventory) {
      expect(inventory.filter((entry) => entry === file)).toEqual([file]);
    }
  });

  it.each(["src/selector/one.test.ts", "./src/selector/one.test.ts"])(
    "records exact default-unit ownership for %s without removing CLI filters",
    (target) => {
      withTinyFileTree({ "src/selector/one.test.ts": "" }, (cwd) => {
        expectSingleVitestRunPlan(buildVitestRunPlans([target, "--", "-t", "case"], cwd), {
          config: "test/vitest/vitest.unit.config.ts",
          forwardedArgs: ["-t", "case", target],
          includePatterns: ["src/selector/one.test.ts"],
        });
      });
    },
  );

  it.each([
    ["src/selector/missing.test.ts"],
    ["src/selector/one.spec.ts"],
    ["src/selector/*.test.ts"],
    ["src/selector/one.test.ts", "src/selector/one.spec.ts"],
    ["src/selector/one.test.ts", "src/selector/missing.test.ts"],
    ["src/selector/one.live.test.ts"],
    ["outside/one.test.ts"],
  ])("keeps unsupported default-unit targets on the CLI route: %j", (...targets) => {
    withTinyFileTree(
      {
        "src/selector/one.test.ts": "",
        "src/selector/one.spec.ts": "",
        "src/selector/one.live.test.ts": "",
        "outside/one.test.ts": "",
      },
      (cwd) => {
        expectSingleVitestRunPlan(buildVitestRunPlans(targets, cwd), {
          config: "test/vitest/vitest.unit.config.ts",
          forwardedArgs: targets,
        });
      },
    );
  });

  it("preserves absolute and watch default-unit target semantics", () => {
    const target = "src/selector/one.test.ts";
    withTinyFileTree({ [target]: "" }, (cwd) => {
      const absolute = path.join(cwd, target);
      expectSingleVitestRunPlan(buildVitestRunPlans([absolute], cwd), {
        config: "test/vitest/vitest.unit.config.ts",
        forwardedArgs: [absolute],
      });
      expectSingleVitestRunPlan(buildVitestRunPlans(["--watch", target], cwd), {
        config: "test/vitest/vitest.unit.config.ts",
        forwardedArgs: [target],
        watchMode: true,
      });
    });
  });

  it("keeps inherited default-unit include files intersected with the CLI target", () => {
    const target = "src/selector/one.test.ts";
    withTinyFileTree({ [target]: "", "include.json": JSON.stringify([]) }, (cwd) => {
      const includeFile = path.join(cwd, "include.json");
      const [spec] = createVitestRunSpecs([target], {
        cwd,
        baseEnv: { OPENCLAW_VITEST_INCLUDE_FILE: includeFile },
      });
      expect(spec).toMatchObject({
        config: "test/vitest/vitest.unit.config.ts",
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
        const [spec] = createVitestRunSpecs([target], {
          baseEnv: { OPENCLAW_VITEST_INCLUDE_FILE: borrowed },
        });
        expect(spec?.includePatterns).toEqual([target]);
        expect(spec?.includeFilePath).toBeTruthy();
        expect(spec?.env.OPENCLAW_VITEST_INCLUDE_FILE).toBe(spec?.includeFilePath);
        expect(spec?.env.OPENCLAW_VITEST_INCLUDE_FILE).not.toBe(borrowed);
        expect(fs.existsSync(borrowed)).toBe(false);
      });
    },
  );

  it.each([false, true])(
    "preserves mixed target order with directory first=%s",
    (directoryFirst) => {
      withTinyFileTree({}, (tempDir) => {
        const owned = "test/scripts/run-node.test.ts";
        const selected = "test/helpers/temp-dir.test.ts";
        const borrowed = path.join(tempDir, "include.json");
        fs.writeFileSync(borrowed, JSON.stringify([selected]));
        const args = directoryFirst ? ["test/helpers", owned] : [owned, "test/helpers"];
        const [spec] = createVitestRunSpecs(args, {
          baseEnv: { OPENCLAW_VITEST_INCLUDE_FILE: borrowed },
        });
        expect(spec?.includePatterns).toEqual(
          directoryFirst ? [selected, owned] : [owned, selected],
        );
      });
    },
  );

  it("keeps an owned worker file beside a restricted directory selection", () => {
    withTinyFileTree({}, (tempDir) => {
      const owned = "extensions/matrix/src/matrix/client/storage.test.ts";
      const selected = "extensions/matrix/src/matrix/sdk/idb-persistence.test.ts";
      const borrowed = path.join(tempDir, "include.json");
      fs.writeFileSync(borrowed, JSON.stringify([selected]));
      const specs = createVitestRunSpecs([owned, "extensions/matrix/src/matrix/sdk"], {
        baseEnv: { OPENCLAW_VITEST_INCLUDE_FILE: borrowed },
      });
      const worker = specs.find(
        (spec) => spec.config === "test/vitest/vitest.extension-database-workers.config.ts",
      );
      expect(worker?.includePatterns?.toSorted()).toEqual([owned, selected].toSorted());
      expect(fs.readFileSync(borrowed, "utf8")).toBe(JSON.stringify([selected]));
    });
  });

  it("deduplicates explicit source tests that share import-graph owners", () => {
    let plans: ReturnType<typeof buildVitestRunPlans> = [];
    withTinyGitRepo(
      {
        "src/runtime-a.ts": "export const a = 'a';\n",
        "src/runtime-b.ts": "export const b = 'b';\n",
        "src/runtime.consumer.test.ts":
          "import { a } from './runtime-a.js';\nimport { b } from './runtime-b.js';\nvoid [a, b];\n",
      },
      (cwd) => {
        plans = buildVitestRunPlans(["src/runtime-a.ts", "src/runtime-b.ts"], cwd);
      },
    );

    expectSingleVitestRunPlan(plans, {
      config: "test/vitest/vitest.unit.config.ts",
      forwardedArgs: ["src/runtime.consumer.test.ts"],
      includePatterns: ["src/runtime.consumer.test.ts"],
    });
  });

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

        expect(resolveChangedTestTargetPlan(["src/runtime.ts"], { cwd }).targets).toEqual([
          "src/runtime.consumer.test.ts",
        ]);
        const includeFile = path.join(cwd, "include.json");
        writeVitestIncludeFile(includeFile, ["src/**/*.test.ts"], { cwd });
        expect(JSON.parse(fs.readFileSync(includeFile, "utf8")).toSorted()).toEqual([
          "src/runtime.consumer.test.ts",
          "src/runtime.untracked.test.ts",
        ]);
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
        expect(resolveChangedTestTargetPlan(["src/value.ts"], { cwd }).targets).toEqual([
          "src/combined.consumer.test.ts",
          "src/right.consumer.test.ts",
        ]);
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
          expect(resolveAffectedTestsFromImportGraph(changed, cwd, { direct: true })).toEqual([
            "src/direct.test.ts",
          ]);
        }
        expect(
          resolveAffectedTestsFromImportGraph(["src/shared.test.ts"], cwd, { direct: true }),
        ).toEqual(["src/shared-consumer.test.ts", "src/shared.test.ts"]);
        expect(
          hasImportGraphImpactOnTargets(["src/value.ts"], ["src/direct.test.ts"], cwd, {
            direct: true,
          }),
        ).toBe(true);
        expect(
          hasImportGraphImpactOnTargets(["src/value.ts"], ["src/indirect.test.ts"], cwd, {
            direct: true,
          }),
        ).toBe(false);
        expect(hasImportGraphImpactOnTargets(["src/value.ts"], ["src/indirect.test.ts"], cwd)).toBe(
          true,
        );
      },
    );
  });

  it("retains configured Vitest setup, runner, and environment consumers", () => {
    withTinyGitRepo(
      {
        "test/vitest/vitest.shared.config.ts": `
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
        "test/vitest/vitest.ui.config.ts": `
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
          expect(
            hasImportGraphImpactOnTargets(
              [helper],
              ["test/vitest/vitest.ui.config.ts"],
              cwd,
              options,
            ),
            helper,
          ).toBe(true);
        }
        expect(
          hasImportGraphImpactOnTargets(
            ["ui/src/setup-helper.ts"],
            ["ui/vitest.config.ts"],
            cwd,
            options,
          ),
        ).toBe(true);
        expect(
          hasImportGraphImpactOnTargets(
            ["src/unrelated.test.ts"],
            ["test/vitest/vitest.ui.config.ts"],
            cwd,
            options,
          ),
        ).toBe(false);
        const consumers = resolveDependencyTestConsumers(
          [{ root: ".", dependencies: ["jsdom"] }],
          cwd,
          { runtimeOnly: true },
        );
        expect(consumers.unresolved).toEqual([]);
        expect(consumers.sources.toSorted()).toEqual([
          "test/vitest/vitest.ui.config.ts",
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
        const expected = [
          "extensions/consumer/direct.test.ts",
          "extensions/consumer/downstream.test.ts",
          "extensions/consumer/shared.test.ts",
        ];
        expect(resolveAffectedTestsFromImportGraph(["src/value.ts"], cwd)).toEqual([]);
        expect(
          resolveAffectedTestsFromImportGraph(["src/value.ts"], cwd, { resolveAliases: true }),
        ).toEqual([...expected, "extensions/consumer/type-only.test.ts"]);
        expect(
          resolveAffectedTestsFromImportGraph(["src/value.ts"], cwd, {
            resolveAliases: true,
            runtimeOnly: true,
          }),
        ).toEqual(expected);
        expect(
          resolveAffectedTestsFromImportGraph(["extensions/consumer/shared.test.ts"], cwd, {
            resolveAliases: true,
            forceFull: true,
          }),
        ).toEqual(["extensions/consumer/downstream.test.ts"]);
        expect(
          resolveAffectedTestsFromImportGraph(["packages/library/src/other.ts"], cwd, {
            resolveAliases: true,
          }),
        ).toEqual(["extensions/consumer/other.test.ts"]);
        for (const target of [
          "packages/library/src/import.test.ts",
          "packages/library/src/require.test.ts",
        ]) {
          expect(
            resolveAffectedTestsFromImportGraph([target], cwd, {
              resolveAliases: true,
              forceFull: true,
            }),
          ).toEqual(["extensions/consumer/conditional.test.ts"]);
        }
        expect(
          resolveAffectedTestsFromImportGraph(["test/fixtures/owner/index.test.ts"], cwd, {
            resolveAliases: true,
            forceFull: true,
          }),
        ).toEqual(["extensions/consumer/fixture.test.ts"]);
        expect(resolveAffectedTestsFromImportGraph("src/value.ts", cwd, { tooling: true })).toEqual(
          ["src/script-consumer.test.ts"],
        );
        expect(
          resolveAffectedTestsFromImportGraph(["src/value.ts"], cwd, {
            tooling: true,
            resolveAliases: true,
            runtimeOnly: true,
          }),
        ).toEqual([...expected, "src/script-consumer.test.ts"]);
        fs.unlinkSync(path.join(cwd, "extensions/consumer/shared.test.ts"));
        expect(
          resolveAffectedTestsFromImportGraph(["extensions/consumer/shared.test.ts"], cwd, {
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
        resolveAffectedTestsFromImportGraph(["src/removed.ts"], cwd, {
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
          resolveDependencyTestConsumers(
            [{ root: "extensions/consumer", dependencies: ["dependency"] }],
            cwd,
          ).tests,
        ).toEqual(["extensions/consumer/direct.test.ts", "extensions/consumer/source.test.ts"]);
        const root = resolveDependencyTestConsumers(
          [{ root: ".", dependencies: ["dependency"] }],
          cwd,
        );
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
        const mixed = resolveDependencyTestConsumers(
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
          resolveDependencyTestConsumers([{ root: ".", dependencies: ["types-only"] }], cwd, {
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
          resolveDependencyTestConsumers([{ root: ".", dependencies: ["dependency"] }], cwd, {
            importerBindings,
          }).tests,
        ).toEqual(["extensions/undeclared/value.test.ts", "src/root.test.ts"]);
        expect(
          resolveDependencyTestConsumers(
            [{ root: "packages/own", dependencies: ["dependency"] }],
            cwd,
            { importerBindings },
          ).tests,
        ).toEqual(["packages/own/src/value.test.ts", "src/package-consumer.test.ts"]);
        expect(
          resolveDependencyTestConsumers([{ root: "ui", dependencies: ["dependency"] }], cwd, {
            importerBindings: importerBindings.filter(({ root }) => root !== "ui"),
          }).tests,
        ).toEqual(["ui/src/own.test.ts"]);
        expect(
          resolveDependencyTestConsumers([{ root: ".", dependencies: ["workspace-only"] }], cwd, {
            importerBindings,
          }).unresolved,
        ).toEqual([{ root: ".", dependency: "workspace-only" }]);
        expect(
          resolveDependencyTestConsumers([{ root: "ui", dependencies: ["workspace-only"] }], cwd, {
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
            resolveChangedTestTargetPlan(["src/owner/value.ts"], { cwd }).targets,
            "initial owner selection",
          ).toEqual(expectedTargets);
          expect(
            resolveChangedTestTargetPlan(["src/owner/value.ts"], { cwd }).targets,
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
        expect(
          resolveChangedTestTargetPlan(["scripts/fixture-source.mts"], { cwd }).targets,
        ).toEqual([
          "test/scripts/direct.consumer.test.ts",
          "test/scripts/type.consumer.test.ts",
          "test/scripts/literal.consumer.test.ts",
        ]);
        const ciOptions = {
          cwd,
          forceFullImportGraph: true,
          resolveAliases: true,
          runtimeOnly: true,
        };
        expect(
          resolveChangedTestTargetPlan(["scripts/fixture-source.mts"], ciOptions).targets,
        ).toEqual([
          "test/scripts/alias.consumer.test.ts",
          "test/scripts/direct.consumer.test.ts",
          "test/scripts/transitive.consumer.test.ts",
          "test/scripts/literal.consumer.test.ts",
        ]);
        expect(
          resolveChangedTestTargetPlan(["scripts/no-direct-owner.mts"], { cwd }).targets,
        ).toEqual(["test/vitest/vitest.tooling.config.ts"]);
        expect(
          resolveChangedTestTargetPlan(["scripts/no-direct-owner.mts"], ciOptions).targets,
        ).toEqual([
          "test/scripts/alias.consumer.test.ts",
          "test/scripts/transitive.consumer.test.ts",
        ]);
        expect(
          resolveChangedTestTargetPlan(["scripts/fixture-data.json"], { cwd }).targets,
        ).toEqual(["test/vitest/vitest.tooling.config.ts"]);
        expect(
          resolveChangedTestTargetPlan(["scripts/fixture-data.json"], ciOptions).targets,
        ).toEqual([
          "test/scripts/alias.consumer.test.ts",
          "test/scripts/transitive.consumer.test.ts",
        ]);
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
          expect(resolveChangedTestTargetPlan([changed], { cwd, broad: true })).toEqual({
            mode: "targets",
            targets: [direct, indirect],
          });
          expect(resolveChangedTestTargetPlan([changed], options)).toEqual({
            mode: "targets",
            targets: ["test/scripts/after-test.consumer.test.ts", direct, indirect],
          });
        }
        // A literal reference alone cannot prove an opaque helper's complete frontier.
        expect(resolveChangedTestTargetPlan([opaque, direct], { cwd, broad: true })).toEqual({
          mode: "targets",
          targets: [opaque, direct],
        });
        expect(resolveChangedTestTargetPlan([opaque, direct], options)).toEqual({
          mode: "targets",
          targets: [
            "test/scripts/relative.opaque.consumer.test.ts",
            "test/scripts/literal.opaque.consumer.test.ts",
            direct,
          ],
        });
        expect(buildVitestRunPlans([explicitHelper], cwd)).toEqual([
          runPlan("tooling", [explicitConsumer]),
        ]);
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
          expect(resolveChangedTestTargetPlan(inputs, { cwd })).toEqual({
            mode: "targets",
            targets: [changedTest, reader, ...(mixedInput ? [otherTest] : [])],
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
          expect(resolveChangedTestTargetPlan([changedPath], { cwd })).toEqual({
            mode: "targets",
            targets: expectedTargets,
          });
        },
      );
    },
  );

  it("routes many explicit source files through one import-graph-backed owner set", () => {
    let plans: ReturnType<typeof buildVitestRunPlans> = [];
    const files: Record<string, string> = {};
    const imports: string[] = [];
    const refs: string[] = [];
    for (let index = 0; index < 13; index += 1) {
      files[`src/runtime-${index}.ts`] = `export const value${index} = ${index};\n`;
      imports.push(`import { value${index} } from './runtime-${index}.js';`);
      refs.push(`value${index}`);
    }
    files["src/runtime.consumer.test.ts"] = `${imports.join("\n")}\nvoid [${refs.join(", ")}];\n`;

    withTinyFileTree(files, (cwd) => {
      plans = buildVitestRunPlans(
        Array.from({ length: 13 }, (_, index) => `src/runtime-${index}.ts`),
        cwd,
      );
    });

    expectSingleVitestRunPlan(plans, {
      config: "test/vitest/vitest.unit.config.ts",
      forwardedArgs: ["src/runtime.consumer.test.ts"],
      includePatterns: ["src/runtime.consumer.test.ts"],
    });
  });

  it.each<{
    args: string[];
    owner: string;
    watchMode: boolean;
    env?: NodeJS.ProcessEnv;
    inheritedProjectShards?: string;
  }>([
    { args: ["src/gateway/server.health.test.ts"], owner: "gateway-server", watchMode: false },
    {
      args: ["--watch", "src/gateway/server.health.test.ts"],
      owner: "gateway",
      watchMode: true,
    },
    {
      args: ["src/gateway/server.health.test.ts", "src/gateway/call.test.ts"],
      owner: "gateway",
      watchMode: false,
    },
    {
      args: ["--watch", "src/gateway/server.health.test.ts", "src/gateway/call.test.ts"],
      owner: "gateway",
      watchMode: true,
    },
    {
      args: ["src/gateway/server.health.test.ts"],
      owner: "gateway",
      watchMode: false,
      env: { OPENCLAW_GATEWAY_PROJECT_SHARDS: "0" },
    },
    {
      args: ["src/gateway/server.health.test.ts"],
      owner: "gateway",
      watchMode: false,
      inheritedProjectShards: "0",
    },
    {
      args: ["src/gateway/server.health.test.ts"],
      owner: "gateway-server",
      watchMode: false,
      env: { OPENCLAW_GATEWAY_PROJECT_SHARDS: "1" },
      inheritedProjectShards: "0",
    },
    {
      args: ["test/vitest/vitest.gateway-server.config.ts"],
      owner: "gateway-server",
      watchMode: false,
      env: { OPENCLAW_GATEWAY_PROJECT_SHARDS: "0" },
    },
  ])(
    "keeps exact Gateway server files on their $owner owner for $args",
    ({ args, owner, watchMode, env, inheritedProjectShards }) => {
      withEnv({ OPENCLAW_GATEWAY_PROJECT_SHARDS: inheritedProjectShards }, () => {
        expectSingleVitestRunPlan(
          buildVitestRunPlans(args, process.cwd(), () => [], { env }),
          {
            config: `test/vitest/vitest.${owner}.config.ts`,
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
      expect(buildVitestRunPlans([...targets, ...forwardedArgs])).toEqual([
        {
          config: "test/vitest/vitest.gateway.config.ts",
          forwardedArgs,
          includePatterns: targets.map((file) =>
            file === "src/gateway" ? "src/gateway/**/*.test.ts" : file,
          ),
          watchMode: false,
        },
        {
          config: "test/vitest/vitest.infra.config.ts",
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
    [
      "test/vitest/vitest.gateway.config.ts",
      "src/gateway/config-reload.telegram-policy.test.ts",
    ].flatMap((target) => [true, false].map((workerFirst) => ({ target, workerFirst }))),
  )(
    "coalesces Gateway worker config with $target (worker first: $workerFirst)",
    ({ target, workerFirst }) => {
      const workerConfig = "test/vitest/vitest.gateway-database-workers.config.ts";
      const targets = workerFirst ? [workerConfig, target] : [target, workerConfig];
      expectSingleVitestRunPlan(buildVitestRunPlans(targets), {
        config: "test/vitest/vitest.gateway.config.ts",
        includePatterns: target.endsWith(".config.ts")
          ? null
          : workerFirst
            ? [...gatewayDatabaseWorkerTestFiles, target]
            : [target, ...gatewayDatabaseWorkerTestFiles],
      });
    },
  );

  it.each([
    ["src/agents/**/*.test.ts", "test/vitest/vitest.agents.config.ts"],
    ["test/plugins", "test/vitest/vitest.tooling.config.ts"],
    ["test/scripts", "test/vitest/vitest.tooling.config.ts"],
    ["src/plugin-state", "test/vitest/vitest.unit.config.ts"],
  ])("preserves watch selection across database ownership for %s", (target, owner) => {
    expect(buildVitestRunPlans(["--watch", target])).toEqual([
      {
        config: "test/vitest/vitest.database-worker-watch.config.ts",
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
    ["src/agents/**/*.test.ts", "src/agents/**/memory-*.test.ts", "src/agents/**/memory-*.test.ts"],
    [
      "extensions/matrix",
      "extensions/matrix/**/storage.test.ts",
      "extensions/matrix/**/storage.test.ts",
    ],
    [
      "extensions/matrix/**/storage.test.ts",
      "extensions/matrix/**/*.test.ts",
      "extensions/matrix/**/storage.test.ts",
    ],
    [
      "extensions/matrix/**/storage.test.ts",
      "extensions/matrix/**/storage.test.ts",
      "extensions/matrix/**/storage.test.ts",
    ],
  ])("retains watch intersection for %s and %s", (directory, pattern, expected) => {
    withTinyFileTree({}, (tempDir) => {
      const includeFile = path.join(tempDir, "include.json");
      fs.writeFileSync(includeFile, JSON.stringify([pattern]));
      const specs = createVitestRunSpecs(["--watch", directory], {
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
    ["src/agents/**/*.test.ts", "test/plugins"],
    ["src/plugin-sdk/memory-host-events.test.ts", "src/plugin-sdk/provider-auth.test.ts"],
    ["src/plugin-sdk/outbound-media.bulk.test.ts", "src/plugin-sdk/provider-auth.test.ts"],
  ])("retains the mixed watch rejection for %s and %s", (...targets) => {
    expect(() => buildVitestRunPlans(["--watch", ...targets])).toThrow(
      "watch mode with mixed test suites is not supported",
    );
  });

  it.each([
    [
      "test/vitest/vitest.plugins.config.ts",
      "src/plugins/doctor-contract-registry.load-paths.test.ts",
    ],
    ["test/vitest/vitest.plugin-sdk.config.ts", "src/plugin-sdk/provider-auth.test.ts"],
    [
      "test/vitest/vitest.unit-fast.config.ts",
      "src/agents/embedded-agent-runner/run/model-setup.selected-model.test.ts",
    ],
    [
      "test/vitest/vitest.unit-fast.config.ts",
      "test/e2e/qa-lab/runtime/gateway-loopback-lan-access.test.ts",
    ],
    [
      "test/vitest/vitest.unit-fast-isolated.config.ts",
      "src/state/openclaw-agent-execution-cleanup.test.ts",
    ],
  ])("preserves whole-owner watch coverage for %s with %s", (config, file) => {
    const [plan] = buildVitestRunPlans(["--watch", config, file]);
    expect(plan).toMatchObject({
      config: "test/vitest/vitest.database-worker-watch.config.ts",
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
        "src/plugin-sdk/outbound-media.bulk.test.ts",
      );
    }
    const [spec] = createVitestRunSpecs(["--watch", config, file], { baseEnv: {} });
    expect(spec?.includeFilePath).toBeNull();
    expect(spec?.env.OPENCLAW_VITEST_DATABASE_WORKER_WATCH_OWNER).toBe(config);
    expect(JSON.parse(spec?.env.OPENCLAW_VITEST_DATABASE_WORKER_WATCH_TESTS ?? "null")).toEqual(
      plan?.databaseWorkerWatchTests,
    );
  });

  it.each([
    "src/plugin-state",
    "src/plugin-sdk",
    "src/agents",
    "src/commands",
    "src/config",
    "test/plugins",
  ])("retains database worker ownership for directory and glob target %s", (directory) => {
    const expected = databaseWorkerCoreTestFiles.filter((file) => file.startsWith(`${directory}/`));
    for (const target of [directory, `${directory}/**/*.test.ts`]) {
      const plans = buildVitestRunPlans([target]);
      const infra = plans.find((plan) => plan.config === "test/vitest/vitest.infra.config.ts");
      expect(infra?.includePatterns?.toSorted()).toEqual(expected.toSorted());
    }
  });

  describe("agent directory and glob inventory", () => {
    const inventories = new Map<string, string[]>();
    const toolRoot = "src/agents/tools";
    const failoverRoot = "src/agents/failover";
    const embeddedRoot = "src/agents/embedded-agent-runner";
    const runtimeRoot = "src/agents/runtime-plan";
    const ownerExamples = [
      ["src/agents/agent-command-local.test.ts", "cli-process"],
      [`${toolRoot}/chat-history-text.test.ts`, "unit-fast"],
      [`${toolRoot}/computer-tool.schema.test.ts`, "unit-fast-isolated"],
      [`${toolRoot}/gateway.hosted-routing.test.ts`, "infra"],
      [`${failoverRoot}/classify.legacy-provider-predicates.test.ts`, "agents-core-isolated"],
      [`${failoverRoot}/failover-classification.corpus.test.ts`, "agents-core-isolated"],
      [`${failoverRoot}/provider-structured-signals.test.ts`, "agents-core-isolated"],
      [`${runtimeRoot}/materialize-model.test.ts`, "agents-support"],
      [`${embeddedRoot}/run.inherited-auth-owner.test.ts`, "infra"],
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

    it.each([
      {
        label: "agent root directory",
        targets: ["src/agents"],
        patterns: ["src/agents/**/*.test.ts"],
      },
      {
        label: "agent root glob",
        targets: ["src/agents/**/*.test.ts"],
        patterns: ["src/agents/**/*.test.ts"],
      },
      { label: "tools directory", targets: [toolRoot], patterns: [`${toolRoot}/**/*.test.ts`] },
      {
        label: "tools glob",
        targets: [`${toolRoot}/**/*.test.ts`],
        patterns: [`${toolRoot}/**/*.test.ts`],
      },
      {
        label: "failover trailing slash",
        targets: [`./${failoverRoot}/`],
        patterns: [`${failoverRoot}/**/*.test.ts`],
      },
      {
        label: "failover glob",
        targets: [`${failoverRoot}/**/*.test.ts`],
        patterns: [`${failoverRoot}/**/*.test.ts`],
      },
      {
        label: "runtime directory",
        targets: [runtimeRoot],
        patterns: [`${runtimeRoot}/**/*.test.ts`],
      },
      {
        label: "embedded directory",
        targets: [embeddedRoot],
        patterns: [`${embeddedRoot}/**/*.test.ts`],
      },
      {
        label: "embedded run glob",
        targets: [`${embeddedRoot}/run/*.test.ts`],
        patterns: [`${embeddedRoot}/run/*.test.ts`],
      },
      {
        label: "mixed overlapping directories and globs",
        targets: [
          path.resolve(toolRoot),
          `src/agents/{tools,failover}/**/*.test.ts`,
          `${toolRoot}/chat-history-text.test.ts`,
        ],
        patterns: [`${toolRoot}/**/*.test.ts`, `${failoverRoot}/**/*.test.ts`],
      },
    ])("selects every ordinary test exactly once for $label", async ({ targets, patterns }) => {
      const expected = [...new Set(fs.globSync(patterns).map(normalizeRepoPath))]
        .filter((file) => !isSharedVitestExcludedPath(file))
        .toSorted();
      expect(expected.length).toBeGreaterThan(0);
      const controls = ["--sequence.shuffle", "--sequence.seed", "3"];
      const plans = buildVitestRunPlans([...targets, "--", ...controls]);
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
                  .map((file) =>
                    normalizeRepoPath(path.relative(process.cwd(), path.resolve(file))),
                  ),
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
    });

    it.each([toolRoot, `${toolRoot}/**/*.test.ts`])(
      "intersects inherited includes for %s without dropping an explicit file",
      (target) => {
        const selected = `${toolRoot}/computer-tool.schema.test.ts`;
        const explicit = `${failoverRoot}/classify.legacy-provider-predicates.test.ts`;
        withTinyFileTree({ "include.json": JSON.stringify([selected]) }, (cwd) => {
          const specs = createVitestRunSpecs([target, explicit], {
            baseEnv: { OPENCLAW_VITEST_INCLUDE_FILE: path.join(cwd, "include.json") },
          });
          expect(specs.flatMap((spec) => spec.includePatterns ?? []).toSorted()).toEqual(
            [selected, explicit].toSorted(),
          );
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
            const plans = buildVitestRunPlans([target], cwd);
            expect(plans.flatMap((plan) => plan.includePatterns ?? [])).toEqual([ordinary]);
            const explicitPlans = buildVitestRunPlans([target, live, e2e], cwd);
            expect(
              explicitPlans.find((plan) => plan.config === "test/vitest/vitest.e2e.config.ts")
                ?.forwardedArgs,
            ).toEqual([e2e]);
            expect(explicitPlans.flatMap((plan) => plan.includePatterns ?? [])).toContain(live);
            expectSingleVitestRunPlan(buildVitestRunPlans([`${toolRoot}/*.e2e.test.ts`], cwd), {
              config: "test/vitest/vitest.e2e.config.ts",
              forwardedArgs: [`${toolRoot}/*.e2e.test.ts`],
            });
          },
        );
      },
    );
  });

  it.each(["scripts/docker/setup.sh", "scripts/lib/build-metadata.sh"])(
    "routes stubbed Docker setup checks to tooling for %s",
    (target) => {
      const plan = buildVitestRunPlans([target]).find((candidate) =>
        candidate.includePatterns?.includes("test/scripts/docker-setup.test.ts"),
      );
      expect(plan).toMatchObject({ config: "test/vitest/vitest.tooling.config.ts" });
    },
  );

  it("routes Docker E2E script targets to their owner tooling tests", () => {
    const targets = ["scripts/e2e/kitchen-sink-plugin-docker.sh"];
    expect(findUnmatchedExplicitTestTargets(targets)).toEqual([]);
    expect(buildVitestRunPlans(targets)).toEqual([
      runPlan("tooling-docker", ["test/scripts/docker-build-helper.test.ts"]),
      runPlan("tooling", ["test/scripts/plugin-prerelease-test-plan.test.ts"]),
    ]);
  });

  it("routes changed Parallels process helpers to their owner tooling tests", () => {
    expectSingleVitestRunPlan(
      buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => [
        "scripts/e2e/parallels/host-command.ts",
      ]),
      {
        config: "test/vitest/vitest.tooling.config.ts",
        includePatterns: [
          "test/scripts/parallels-smoke-model.test.ts",
          "test/scripts/parallels-npm-update-smoke.test.ts",
        ],
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
        "test/scripts/session-log-mentions.test.ts",
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
      [
        "test/scripts/docker-build-helper.test.ts",
        "test/scripts/docker-e2e-plan.test.ts",
        "test/scripts/codex-media-path-client.test.ts",
        "test/scripts/package-acceptance-workflow.test.ts",
        "test/scripts/live-plugin-tool-assertions.test.ts",
        "test/scripts/plugin-binding-command-escape-docker.test.ts",
      ],
    ],
  ])("routes Docker E2E targets %j to their semantic owners", (targets, owners) => {
    expect(findUnmatchedExplicitTestTargets(targets)).toEqual([]);
    expectChangedTargets(targets, owners);
  });

  it.each([
    ["chunks the broad shell helper tooling shard after isolated targets", "test/scripts"],
    ["chunks broad shell helper globs after isolated targets", "test/scripts/*.test.ts"],
  ])("%s", (_title, target) => {
    const plans = buildVitestRunPlans([target, "--reporter=dot"], process.cwd());
    const pattern = target === "test/scripts" ? "test/scripts/**/*.test.ts" : target;
    const expected = fs.globSync(pattern).map(normalizeRepoPath).toSorted();
    const selected = plans.flatMap(
      (plan) =>
        plan.includePatterns ?? plan.forwardedArgs.filter((arg) => arg.endsWith(".test.ts")),
    );
    expect(selected.toSorted()).toEqual(expected);
    expect(new Set(selected).size).toBe(selected.length);

    const requiredOwners: Record<string, string> = {
      "test/scripts/ci-git-prerequisites.test.ts":
        "test/vitest/vitest.unit-fast-isolated.config.ts",
      "test/scripts/pr-ci-sweeper.reopen-timer.test.ts":
        "test/vitest/vitest.unit-fast-fake-timers.config.ts",
      "test/scripts/docker-build-helper.test.ts": "test/vitest/vitest.tooling-docker.config.ts",
      "test/scripts/openclaw-e2e-instance.test.ts": "test/vitest/vitest.tooling-isolated.config.ts",
    };
    for (const plan of plans) {
      const files =
        plan.includePatterns ?? plan.forwardedArgs.filter((arg) => arg.endsWith(".test.ts"));
      expect(plan.watchMode).toBe(false);
      expect(plan.forwardedArgs).toContain("--reporter=dot");
      if (plan.config === "test/vitest/vitest.tooling.config.ts") {
        expect(files.length).toBeLessThanOrEqual(60);
      }
      for (const file of files) {
        const owner = file.endsWith(".e2e.test.ts")
          ? "test/vitest/vitest.e2e.config.ts"
          : requiredOwners[file];
        if (owner) {
          expect(plan.config, file).toBe(owner);
        }
      }
    }
  });

  it("adds the CLI process project for broad CLI targets", () => {
    const plans = buildVitestRunPlans(["src/cli"]);

    expect(plans.map((plan) => plan.config)).toEqual(
      expect.arrayContaining([
        "test/vitest/vitest.unit-fast.config.ts",
        "test/vitest/vitest.cli-process.config.ts",
        "test/vitest/vitest.cli.config.ts",
        "test/vitest/vitest.tooling-isolated.config.ts",
      ]),
    );
    const processPlan = plans.find(
      (plan) => plan.config === "test/vitest/vitest.cli-process.config.ts",
    );
    expect(processPlan?.includePatterns).toContain("src/cli/help-exit.process.test.ts");
    expect(processPlan?.includePatterns).toContain("src/cli/update-dry-run-state.process.test.ts");
    expect(
      plans.find((plan) => plan.config === "test/vitest/vitest.tooling-isolated.config.ts")
        ?.includePatterns,
    ).toEqual(["src/cli/update-cli/update-command-legacy-finalize.test.ts"]);
  });

  it.each([
    { directory: "src/state", file: "src/state/openclaw-database-verify.process.test.ts" },
    { directory: "src/agents", file: "src/agents/agent-command-local.test.ts" },
  ])(
    "deduplicates the process selected by $directory and its exact leaf",
    ({ directory, file }) => {
      const plans = buildVitestRunPlans([directory, file]);
      expect(
        plans.filter((plan) => plan.config === "test/vitest/vitest.cli-process.config.ts"),
      ).toEqual([runPlan("cli-process", [file])]);
    },
  );

  it("preserves post-separator Vitest args without parsing them as targets", () => {
    for (const [arg, watchMode] of [
      ["--reporter=verbose", false],
      ["--watch", true],
    ] as const) {
      expectSingleVitestRunPlan(
        buildVitestRunPlans(["test/scripts/run-vitest.test.ts", "--", arg]),
        {
          config: "test/vitest/vitest.tooling.config.ts",
          forwardedArgs: [arg],
          includePatterns: ["test/scripts/run-vitest.test.ts"],
          watchMode,
        },
      );
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
          env: { ...process.env, TMPDIR: tempDir, TMP: tempDir, TEMP: tempDir },
          timeout: 5_000,
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Usage: node --import tsx scripts/test-projects.mts");
      expect(result.stderr).not.toContain("[test] starting");
    });
  });

  it("fans contract directory targets out to the owning contract lanes", () => {
    // Regression: the generic channels project excludes contracts/**, so the
    // directory target used to run zero tests and exit green.
    const plans = buildVitestRunPlans(["src/channels/plugins/contracts"]);

    expect(plans.map((plan) => plan.config)).toEqual([
      "test/vitest/vitest.contracts-channel-surface.config.ts",
      "test/vitest/vitest.contracts-channel-config.config.ts",
      "test/vitest/vitest.contracts-channel-registry.config.ts",
      "test/vitest/vitest.contracts-channel-session.config.ts",
    ]);
    expect(plans.every((plan) => plan.includePatterns === null)).toBe(true);
  });

  it("routes the plugin contracts directory across contract and database worker lanes", () => {
    const plans = buildVitestRunPlans(["src/plugins/contracts"]);

    expect(plans).toEqual([
      runPlan("contracts-plugin"),
      runPlan("infra", [
        "src/plugins/contracts/host-hook-state.identity.test.ts",
        "src/plugins/contracts/host-hooks.contract.test.ts",
      ]),
    ]);
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
      const plan = resolveChangedTestTargetPlan([changedPath]);

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
        resolveChangedTestTargetPlanForArgs(
          ["--changed", "origin/main"],
          process.cwd(),
          () => [changedPath],
          { broad: true },
        ),
        changedPath,
      ).toEqual({ mode: "broad", targets: [] });
    }
  });

  it("keeps unknown root surface skip reasons available to changed-mode callers", () => {
    expect(
      resolveChangedTestTargetPlanForArgs(["--changed", "origin/main"], process.cwd(), () => [
        "unknown/file.txt",
      ]),
    ).toEqual({
      mode: "targets",
      skippedBroadFallbackPaths: ["unknown/file.txt"],
      targets: [],
    });
  });

  it("keeps the broad changed run available for unknown root surfaces", () => {
    expect(
      resolveChangedTargetArgs(
        ["--changed", "origin/main"],
        process.cwd(),
        () => ["unknown/file.txt"],
        { env: { OPENCLAW_TEST_CHANGED_BROAD: "1" } },
      ),
    ).toBeNull();
  });

  it("skips app-only changes because app tests are separate from Vitest lanes", () => {
    expect(
      buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => [
        "apps/macos/OpenClaw/AppDelegate.swift",
      ]),
    ).toStrictEqual([]);
  });

  it("keeps the top-level extensions watch target on its aggregate owner", () => {
    expectSingleVitestRunPlan(buildVitestRunPlans(["--watch", "extensions"]), {
      config: "test/vitest/vitest.full-extensions.config.ts",
      watchMode: true,
    });
  });

  it("bounds an explicit Telegram config target across process lifetimes", () => {
    const config = "test/vitest/vitest.extension-telegram.config.ts";
    const plans = buildVitestRunPlans([config], process.cwd());

    expect(plans).toHaveLength(expectedTelegramTestProcessCount());
    expect(plans.every((plan) => plan.config === config)).toBe(true);
    expect(
      plans.every(
        (plan) => (plan.includePatterns?.length ?? 0) <= TELEGRAM_TEST_PROCESS_FILE_LIMIT,
      ),
    ).toBe(true);
    expect(plans.flatMap((plan) => plan.includePatterns ?? [])).toEqual(
      listOrdinaryExtensionFiles("extensions/telegram"),
    );
  });

  it.each([
    {
      channel: "Telegram",
      config: "test/vitest/vitest.extension-telegram.config.ts",
    },
    { channel: "Matrix", config: "test/vitest/vitest.extension-matrix.config.ts" },
  ])("preserves an externally scoped $channel config target", ({ config }) => {
    expectSingleVitestRunPlan(
      buildVitestRunPlans([config], process.cwd(), () => [], {
        env: { OPENCLAW_VITEST_INCLUDE_FILE: "ci-shard.json" },
      }),
      {
        config,
      },
    );
  });

  it.each([
    {
      channel: "Telegram",
      config: "test/vitest/vitest.extension-telegram.config.ts",
      directory: "extensions/telegram",
    },
    {
      channel: "Matrix",
      config: "test/vitest/vitest.extension-matrix.config.ts",
      directory: "extensions/matrix",
    },
  ])("preserves an externally scoped $channel directory run spec", ({ config, directory }) => {
    withTinyFileTree({}, (tempDir) => {
      const includeFile = path.join(tempDir, "ci-shard.json");
      fs.writeFileSync(includeFile, JSON.stringify([`${directory}/src/example.test.ts`]));
      const [spec] = createVitestRunSpecs([directory], {
        baseEnv: { OPENCLAW_VITEST_INCLUDE_FILE: includeFile },
      });

      expect(spec).toMatchObject({
        config,
        env: { OPENCLAW_VITEST_INCLUDE_FILE: includeFile },
        includeFilePath: null,
        includePatterns: null,
      });
    });
  });

  it.each([
    {
      directory: "extensions/matrix/src/matrix/client",
      selected: ["extensions/matrix/src/matrix/client/storage.test.ts"],
      inherited: [
        "extensions/matrix/src/matrix/client/storage.test.ts",
        "extensions/matrix/src/matrix/thread-bindings.test.ts",
      ],
    },
    {
      directory: "extensions/matrix/src/matrix/sdk",
      selected: [
        "extensions/matrix/src/matrix/sdk/idb-persistence.test.ts",
        "extensions/matrix/src/matrix/sdk/recovery-key-store.test.ts",
      ],
      inherited: ["extensions/matrix/**/*.test.ts"],
    },
  ])(
    "intersects $directory and inherited worker selections before emitting include files",
    ({ directory, selected, inherited }) => {
      withTinyFileTree({}, (tempDir) => {
        const includeFile = path.join(tempDir, "include.json");
        fs.writeFileSync(includeFile, JSON.stringify(inherited));
        const specs = createVitestRunSpecs([directory], {
          baseEnv: { OPENCLAW_VITEST_INCLUDE_FILE: includeFile },
        });
        const worker = specs.find(
          (spec) => spec.config === "test/vitest/vitest.extension-database-workers.config.ts",
        );
        expect(worker?.includePatterns).toEqual(selected);
        expect(specs.flatMap((spec) => spec.includePatterns ?? [])).not.toContain(
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

    const plans = buildVitestRunPlans(["extensions/matrix", testFile], process.cwd());

    expect(plans.length).toBeGreaterThan(1);
    expect(
      plans.every((plan) => (plan.includePatterns?.length ?? 0) <= MATRIX_TEST_PROCESS_FILE_LIMIT),
    ).toBe(true);
    expect(plans.flatMap((plan) => plan.includePatterns ?? []).toSorted()).toEqual(
      listExtensionTestFilesForRoots(["extensions/matrix"]).toSorted(),
    );
  });

  it("keeps a grouped Matrix config target unsplit beside its worker tests", () => {
    const plans = buildVitestRunPlans([
      "extensions/matrix",
      "test/vitest/vitest.extension-matrix.config.ts",
    ]);
    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.extension-database-workers.config.ts",
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
    expect(buildVitestRunPlans([testFile!])).toHaveLength(1);
    const plans = buildVitestRunPlans(["--watch", "extensions/matrix"]);
    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.database-worker-watch.config.ts",
        databaseWorkerWatchOwner: "test/vitest/vitest.extension-matrix.config.ts",
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
        const plan = resolveChangedTestTargetPlan([helper], { cwd, boundedOwners: true });
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
          resolveChangedTestTargetPlan(["package.json", "src/feature/value.ts"], {
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
          targets: [
            "src/feature/value.test.ts",
            "src/feature/consumer.test.ts",
            "src/feature/indirect.test.ts",
            "src/other/reader.test.ts",
          ],
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
        const plans = buildVitestRunPlans(args, cwd, () => paths, options);
        expect(plans.flatMap((plan) => plan.includePatterns ?? []).toSorted()).toEqual(
          expected.toSorted(),
        );
        expect(plans.every((plan) => plan.watchMode === watchMode)).toBe(true);
        expect(
          plans.find((plan) => plan.config === "test/vitest/vitest.tooling.config.ts")
            ?.includePatterns,
        ).toEqual(expected.includes(kova) ? [kova] : undefined);
        if (watchMode) {
          expectSingleVitestRunPlan(plans, {
            config: "test/vitest/vitest.runtime-config.config.ts",
            includePatterns: expect.arrayContaining(expected),
            watchMode: true,
          });
        }
        expect(findUnmatchedExplicitTestTargets(args, cwd)).toEqual([]);
      });
    });
    it("rejects explicitly mixed watch suites", () => {
      withTinyGitRepo(files, (cwd) => {
        expect(() => buildVitestRunPlans(["--watch", wrapper, kova], cwd)).toThrow(
          "watch mode with mixed test suites is not supported",
        );
      });
    });
    it("does not admit unmatched watch sources through Kova", () => {
      withTinyGitRepo({ [base]: "export {};\n", [kova]: "export {};\n" }, (cwd) => {
        expect(findUnmatchedExplicitTestTargets([base], cwd)).toEqual([]);
        expect(findUnmatchedExplicitTestTargets(["--watch", base], cwd)).toEqual([
          expect.objectContaining({ target: base, reason: "target-matched-no-test-files" }),
        ]);
      });
    });
    it("keeps skipped import-graph paths visible with mixed broad changes", () => {
      withTinyGitRepo(files, (cwd) => {
        const paths = [base, "unknown/file.txt"];
        expect(resolveChangedTestTargetPlan(paths, { cwd })).toEqual({
          mode: "targets",
          targets: [kova],
          skippedBroadFallbackPaths: paths,
        });
        expect(resolveChangedTestTargetPlan(paths, { cwd, broad: true })).toEqual({
          mode: "broad",
          targets: [],
        });
      });
    });
  });

  it.each(["changed", "explicit"])(
    "routes %s ui support files to the ui lane without dead include globs",
    (mode) => {
      const targets = ["ui/src/styles/base.css", "ui/src/test-helpers/lit-warnings.setup.ts"];
      const plans = buildVitestRunPlans(
        mode === "changed" ? ["--changed", "origin/main"] : targets,
        process.cwd(),
        () => targets,
      );

      expect(plans[0]).toEqual(runPlan("ui"));
      expect(plans[1]?.config).toBe("test/vitest/vitest.ui-browser.config.ts");
      expect(plans[1]?.includePatterns).toContain(
        "ui/src/components/markdown-mermaid.runtime.browser.test.ts",
      );
    },
  );

  it.each(["relative", "trailing slash", "absolute", "dot segments"])(
    "keeps an existing nested ui directory and explicit e2es scoped (%s)",
    (spelling) => {
      const directory = "ui/src/pages/new-session";
      const isolated = `${directory}/draft-persistence.test.ts`;
      const unitFiles = [
        `${directory}/view.test.ts`,
        `${directory}/nested/child.test.ts`,
        isolated,
      ];
      const e2es = [
        "ui/src/e2e/new-session-page.workspace-validation.e2e.test.ts",
        "ui/src/e2e/new-session-page.projects-places.e2e.test.ts",
        "ui/src/e2e/new-session-page.device-dispatch.e2e.test.ts",
      ];
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
          const plans = buildVitestRunPlans([target, ...e2es], cwd);
          expect(plans).toEqual([
            runPlan("ui", [`${directory}/**/*.test.ts`]),
            runPlan("ui-isolated", [isolated]),
            runPlan("ui-e2e", e2es),
          ]);
          const includeFile = path.join(cwd, "include.json");
          const filesByPlan = plans.map((plan) => {
            writeVitestIncludeFile(includeFile, plan.includePatterns!, { cwd });
            return JSON.parse(fs.readFileSync(includeFile, "utf8"));
          });
          // Shared UI intersects these files with its ownership exclusions.
          expect(filesByPlan).toEqual([unitFiles.toSorted(), [isolated], e2es]);
        },
      );
    },
  );

  it("adds isolated and Chromium projects before timing budgets for broad ui targets", () => {
    const plans = buildVitestRunPlans(["ui/src"]);

    expect(plans.map((plan) => plan.config)).toEqual([
      "test/vitest/vitest.ui.config.ts",
      "test/vitest/vitest.ui-isolated.config.ts",
      "test/vitest/vitest.ui-browser.config.ts",
      "test/vitest/vitest.ui-timing.config.ts",
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
    const plans = buildVitestRunPlans(targets);
    const native = plans.find((plan) => plan.config === "test/vitest/vitest.ui-browser.config.ts");
    const node = plans.find((plan) => plan.config === "test/vitest/vitest.ui.config.ts");
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
      expect(plans.flatMap((plan) => plan.includePatterns ?? []).toSorted()).toEqual(
        matchingFiles.toSorted(),
      );
    }
  });

  it("rejects UI glob watch before freezing the current matching files", () => {
    expect(() =>
      buildVitestRunPlans(["--watch", "ui/src/components/markdown-*.browser.test.ts"]),
    ).toThrow("use a literal test path, directory, or dedicated UI suite");
  });

  it("keeps scoped include files distinct across invocations and borrowed metadata", () => {
    const borrowed = path.join(os.tmpdir(), "borrowed-vitest-include.json");
    const files = Array.from({ length: 2 }, () => {
      const [spec] = createVitestRunSpecs(["src/plugin-sdk/temp-path.test.ts"], {
        baseEnv: { OPENCLAW_VITEST_INCLUDE_FILE: borrowed },
      });
      assert(spec?.includeFilePath);
      expect(path.dirname(spec.includeFilePath)).toBe(os.tmpdir());
      expect(spec.includeFilePath).not.toBe(borrowed);
      return spec.includeFilePath;
    });
    expect(files[0]).not.toBe(files[1]);
  });

  it("expands routed glob targets to literal include-file paths", () => {
    withTinyGitRepo(
      {
        "src/gateway/core.test.ts": "",
        "src/gateway/server-methods/ping.test.ts": "",
        "src/gateway/server-startup.test.ts": "",
      },
      (cwd) => {
        const includeFile = path.join(cwd, "include.json");
        writeVitestIncludeFile(
          includeFile,
          [
            "src/gateway/**/*.test.ts",
            "src/gateway/server-*.test.ts",
            "src/gateway/@(core|server-startup).test.ts",
          ],
          { cwd },
        );

        expect(JSON.parse(fs.readFileSync(includeFile, "utf8"))).toEqual([
          "src/gateway/core.test.ts",
          "src/gateway/server-methods/ping.test.ts",
          "src/gateway/server-startup.test.ts",
        ]);
      },
    );
  });

  it("retains routed glob targets in watch-mode include files", () => {
    withTinyFileTree({}, (tempDir) => {
      const includeFile = path.join(tempDir, "include.json");
      writeVitestIncludeFile(includeFile, ["src/gateway/**/*.test.ts"], {
        expandGlobs: false,
      });

      expect(JSON.parse(fs.readFileSync(includeFile, "utf8"))).toEqual([
        "src/gateway/**/*.test.ts",
      ]);
    });
  });

  it("preflights targeted UI E2E specs with Playwright browser assets", () => {
    const [spec] = createVitestRunSpecs(["ui/src/pages/cron/run-transcript.e2e.test.ts"], {
      baseEnv: {},
    });

    expect(spec?.config).toBe("test/vitest/vitest.ui-e2e.config.ts");
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
    const plan = resolveChangedTestTargetPlan([
      ".crabbox.yaml",
      "scripts/check.mts",
      "src/gateway/server.impl.ts",
    ]);
    const repoSourceReads = readFileSync.mock.calls
      .slice(before)
      .filter(([file]) => typeof file === "string" && normalizeRepoPath(file).includes("/src/"));
    readFileSync.mockRestore();

    expect(plan).toEqual({
      mode: "targets",
      skippedBroadFallbackPaths: ["src/gateway/server.impl.ts"],
      targets: [
        "test/scripts/package-acceptance-workflow.test.ts",
        "test/scripts/check.test.ts",
        "test/scripts/pr-gate-base.test.ts",
      ],
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
    expectSingleVitestRunPlan(
      buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => fixturePaths),
      {
        config: "test/vitest/vitest.unit.config.ts",
        forwardedArgs: [owner],
        includePatterns: [owner],
      },
    );
  });
});

describe("changed export mock consumers", () => {
  it.each([
    {
      name: "member access cannot invent an export",
      before: "export const old = 1; const api = { export: 0 }; api.export\nfunction added() {}",
      after:
        "export const old = 1; const api = { export: 0 }; api.export\nfunction added() {} export { added };",
      selected: true,
    },
    {
      name: "a preceding period literal is not member access",
      before: "export const old = 1;",
      after: 'export const old = 1; "."\nexport const added = 2;',
      selected: true,
    },
    {
      name: "empty-string export alias",
      before: "export const old = 1; const value = 2;",
      after: 'export const old = 1; const value = 2; export { value as "" };',
      selected: true,
    },
    {
      name: "quoted closing brace is an export name",
      before: "export const old = 1;",
      after: 'export const old = 1; export { "}" as added } from "./other.js";',
      selected: true,
    },
    {
      name: "erased default becomes a runtime export",
      before: "export default interface API {}",
      after: "export default class API {}",
      selected: true,
    },
    {
      name: "erased namespace gains a runtime member",
      before: "export namespace API { export type Value = string; }",
      after: "export namespace API { export const value = 1; }",
      selected: true,
    },
    {
      name: "const enums retain mock coverage",
      before: "export const enum Old { Value = 1 }",
      after: "export const enum Old { Value = 1 } export const enum Added { Value = 2 }",
      selected: true,
    },
    {
      name: "JSX text cannot hide a later export",
      before: "function component() { return <div>}</div>; } export const old = 1;",
      after:
        "function component() { return <div>}</div>; } export const old = 1; export const added = 2;",
      selected: true,
    },
    {
      name: "Unicode names retain mock coverage",
      before: "export function café() {}",
      after: "export function cafè() {}",
      selected: true,
    },
    {
      name: "bracket CommonJS exports retain mock coverage",
      before: 'module["exports"] = { old: 1 };',
      after: 'module["exports"] = { old: 1, added: 2 };',
      selected: true,
    },
    {
      name: "CommonJS exports retain mock coverage",
      before: "exports.old = 1;",
      after: "exports.old = 1; exports.added = 2;",
      selected: true,
    },
    {
      name: "implicit statement does not hide a new export",
      before: "export const old = 1\nconst hidden = 2, added = 3;",
      after: "export const old = 1\nconst hidden = 2, added = 3; export { added };",
      selected: true,
    },
    {
      name: "namespace member does not hide a module export",
      before: "export namespace API { export const added = 1; }",
      after: "export namespace API { export const added = 1; } export const added = 2;",
      selected: true,
    },
    {
      name: "generic initializer does not hide a new export",
      before: "class Handler {}; export const cache = new Map<string, Handler>();",
      after:
        "class Handler {}; export const cache = new Map<string, Handler>(); export { Handler };",
      selected: true,
    },
    {
      name: "added function",
      before: "export const old = 1;",
      after: "export const old = 1; export function added() {}",
      selected: true,
    },
    {
      name: "removed export",
      before: "export const old = 1;",
      after: "const old = 1;",
      selected: true,
    },
    {
      name: "renamed re-export",
      before: 'export { original as old } from "./value.js";',
      after: 'export { original as renamed } from "./value.js";',
      selected: true,
    },
    {
      name: "multiline export list",
      before: "const old = 1; export { old };",
      after: "const old = 1, added = 2; export {\n old,\n added\n };",
      selected: true,
    },
    {
      name: "second variable",
      before: "export const old = 1;",
      after: "export const old = 1, added = 2;",
      selected: true,
    },
    {
      name: "default export",
      before: "export const old = 1;",
      after: "export const old = 1; export default () => 2;",
      selected: true,
    },
    {
      name: "wildcard source",
      before: 'export * from "./one.js";',
      after: 'export * from "./two.js";',
      selected: true,
    },
    {
      name: "implementation only",
      before: "export function old() { return 1; }",
      after: "export function old() { return 2; }",
      selected: false,
    },
    {
      name: "initializer only",
      before: "export const old = 1;",
      after: "export const old = call(2, 3);",
      selected: false,
    },
    {
      name: "type only",
      before: "export const old = 1;",
      after: "export const old = 1; export type New = string; export interface Shape {}",
      selected: false,
    },
    {
      name: "comments and strings",
      before: "export const old = 1;",
      after: `export const old = 1; // export const added = 2;\nconst text = 'export { added }';`,
      selected: false,
    },
    {
      name: "unknown bindings",
      before: "export const old = 1;",
      after: "export const { old, added } = value;",
      selected: true,
    },
  ])("selects all mock owners on $name", ({ before, after, selected }) => {
    const producer = "src/owner/runtime.ts";
    const consumers = [
      "test/relative.test.ts",
      "test/alias.test.ts",
      "test/package.test.ts",
      "test/shared.test.ts",
    ];
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
        const base = spawnSync("git", ["write-tree"], { cwd, encoding: "utf8" });
        expect(base.status).toBe(0);
        fs.writeFileSync(path.join(cwd, producer), after);
        const reasons: string[] = [];
        const result = resolveChangedTestTargetPlan([producer], {
          cwd,
          baseRef: base.stdout.trim(),
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
  });

  it.each([
    {
      name: "namespace re-export becomes star re-export",
      before: 'export * as runtime from "./runtime.js";',
      after: 'export * from "./runtime.js";',
      selected: true,
    },
    {
      name: "literal star becomes namespace consumption",
      before: 'import { "*" as star } from "./runtime.js"; void star;',
      after: 'import * as runtime from "./runtime.js"; void runtime.existing;',
      selected: true,
    },
    {
      name: "literal star becomes dynamic consumption",
      before: 'import { "*" as star } from "./runtime.js"; void star;',
      after: 'const runtime = await import("./runtime.js"); void runtime.existing;',
      selected: true,
    },
    {
      name: "literal star becomes re-export consumption",
      before: 'export { "*" as star } from "./runtime.js";',
      after: 'export * from "./runtime.js";',
      selected: true,
    },
    {
      name: "import after a period literal",
      before: 'import { old } from "./runtime.js";',
      after: '"."\nimport { existing } from "./runtime.js";',
      selected: true,
    },
    {
      name: "quoted closing brace is a consumed name",
      before: 'import { old } from "./runtime.js";',
      after: 'import { "}" as existing } from "./runtime.js";',
      selected: true,
    },
    {
      name: "named re-export switches consumed binding",
      before: 'export { old as run } from "./runtime.js";',
      after: 'export { existing as run } from "./runtime.js";',
      selected: true,
    },
    {
      name: "erased query becomes a runtime namespace import",
      before: 'type Runtime = typeof import("./runtime.js");',
      after:
        'type Runtime = typeof import("./runtime.js"); import * as runtime from "./runtime.js";',
      selected: true,
    },
    {
      name: "default binding named type",
      before: 'import { old } from "./runtime.js";',
      after: 'import type from "./runtime.js";',
      selected: true,
    },
    {
      name: "default binding named type with named imports",
      before: 'import { old } from "./runtime.js";',
      after: 'import type, { old } from "./runtime.js";',
      selected: true,
    },
    {
      name: "new named import",
      before: 'import { old } from "./runtime.js";',
      after: 'import { old, existing } from "./runtime.js";',
      selected: true,
    },
    {
      name: "new default import",
      before: 'import { old } from "./runtime.js";',
      after: 'import value, { old } from "./runtime.js";',
      selected: true,
    },
    {
      name: "local rename",
      before: 'import { old } from "./runtime.js";',
      after: 'import { old as renamed } from "./runtime.js";',
      selected: false,
    },
    {
      name: "new erased binding",
      before: 'import { old } from "./runtime.js";',
      after: 'import { old, type Shape } from "./runtime.js";',
      selected: false,
    },
  ])("protects existing exports on $name", ({ before, after, selected }) => {
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
        "test/unrelated.test.ts": 'vi.mock("../src/owner/runtime.js", () => ({ old: 1, "*": 2 }));',
      },
      (cwd) => {
        const base = spawnSync("git", ["write-tree"], { cwd, encoding: "utf8" });
        expect(base.status).toBe(0);
        fs.writeFileSync(path.join(cwd, producer), after);
        const result = resolveChangedTestTargetPlan([producer], {
          cwd,
          baseRef: base.stdout.trim(),
          boundedOwners: true,
          aggressive: { maxDirectImporters: 1, maxDirectoryTests: 1 },
        });
        expect(result.targets.includes("test/consumer.test.ts")).toBe(selected);
        expect(result.targets).not.toContain("test/unrelated.test.ts");
      },
    );
  });

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
        const base = spawnSync("git", ["write-tree"], { cwd, encoding: "utf8" });
        expect(base.status).toBe(0);
        fs.appendFileSync(path.join(cwd, "src/owner/runtime.ts"), "export const added = 2;");
        expect(
          resolveChangedTestTargetPlan(["src/owner/runtime.ts"], {
            cwd,
            baseRef: base.stdout.trim(),
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
        const base = spawnSync("git", ["write-tree"], { cwd, encoding: "utf8" });
        expect(base.status).toBe(0);
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
            resolveChangedTestTargetPlan(["src/owner/runtime.ts"], {
              cwd,
              baseRef: base.stdout.trim(),
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
            resolveChangedTestTargetPlan(["src/owner/runtime.ts"], {
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
          resolveChangedTestTargetPlan(["src/owner/value.ts"], {
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
        expect(resolveControlUiTestConsumers(["ui/src/catalog.json"], cwd)).toEqual([
          ...graphConsumers,
          "test/scripts/ui-catalog-reader.test.ts",
          "test/scripts/ui-shared-reader.test.ts",
        ]);
        expect(
          resolveControlUiTestConsumers(
            ["ui/src/catalog.json", "ui/src/catalog-extra.json", "ui/src/catalog.json"],
            cwd,
          ),
        ).toEqual([
          ...graphConsumers,
          "test/scripts/ui-catalog-reader.test.ts",
          "test/scripts/ui-shared-reader.test.ts",
          "test/scripts/ui-extra-reader.test.ts",
        ]);
        expect(
          resolveControlUiTestConsumers(["ui/src/catalog-extra.json", "ui/src/catalog.json"], cwd),
        ).toEqual([
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
        const [facts, ...syntaxFacts] = readTestSelectorSourceFacts(
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
          matches: terms.filter((term) => source.includes(term)),
          references: terms.filter((term) => tokens.has(term)),
        };
      });
      expect(readTestSelectorSourceFacts(cwd, files, terms, 1024 * 1024)).toEqual(expected);
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
        readTestSelectorSourceFacts(cwd, files, ["needle"], 16 * 1024 * 1024, {
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
            matches: ["needle"],
            references: ["needle"],
          })),
      );
      expect(readTestSelectorSourceFacts(cwd, files, [], 16 * 1024 * 1024)).toEqual(
        rows
          .filter(({ readable }) => readable)
          .map(({ file, dependency }) => ({
            file,
            imports: [dependency],
            typeOnlyImports: [],
            mocks: [],
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
            readTestSelectorSourceFacts(
              cwd,
              files,
              ["scripts/tool.mts", "scripts/tool"],
              16 * 1024 * 1024,
              { matchingOnly: true },
            ),
          ).toEqual([{ file: "large.mts", ...expectedFacts }]);
          expect(
            readTestSelectorSourceFacts(
              cwd,
              files,
              ["scripts/tool.mts", "scripts/tool"],
              16 * 1024 * 1024,
            ),
          ).toEqual([
            { file: "large.mts", ...expectedFacts },
            { file: "unterminated.ts", ...unterminatedFacts },
          ]);
          expect(
            readTestSelectorSourceFacts(
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
      expect(() => readTestSelectorSourceFacts(path.join(cwd, "missing"), files, [], 1024)).toThrow(
        "Test selector source scan failed",
      );
      expect(() => readTestSelectorSourceFacts(cwd, files, [], 1)).toThrow(
        "Test selector source scan failed",
      );
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
  const fastTooling = {
    config: "test/vitest/vitest.tooling.config.ts",
    includePatterns: ["test/scripts/run-with-env.test.ts"],
  };
  const slowTooling = {
    ...fastTooling,
    includePatterns: ["test/scripts/vitest-worker-artifacts.test.ts"],
  };
  const runtime = {
    config: "test/vitest/vitest.runtime-config.config.ts",
    includePatterns: ["src/config/sessions/session-accessor.sqlite-archive.worker.test.ts"],
  };
  it.each([
    [
      "null whole-config selection",
      fastTooling,
      { config: "test/vitest/vitest.gateway.config.ts", includePatterns: null },
    ],
    [
      "empty whole-config selection",
      fastTooling,
      { config: "test/vitest/vitest.gateway.config.ts", includePatterns: [] },
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

  it("keeps CI=1 full-suite runs on aggregate shard configs", () => {
    vi.stubEnv("CI", "1");
    vi.stubEnv("GITHUB_ACTIONS", "");
    vi.stubEnv("OPENCLAW_TESTBOX_REMOTE_RUN", "");
    vi.stubEnv("OPENCLAW_TEST_PROJECTS_LEAF_SHARDS", "");
    vi.stubEnv("OPENCLAW_TEST_PROJECTS_PARALLEL", "");
    try {
      const configs = buildFullSuiteVitestRunPlans([], process.cwd()).map((plan) => plan.config);

      expect(configs).toContain("test/vitest/vitest.full-agentic.config.ts");
      expect(configs).toContain("test/vitest/vitest.full-extensions.config.ts");
      expect(configs).not.toContain("test/vitest/vitest.gateway-server.config.ts");
      expect(configs).not.toContain("test/vitest/vitest.extension-telegram.config.ts");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("raises the effective last aggregate extension heap override", () => {
    const specs = applyFullExtensionsHeapBudget([
      {
        config: "test/vitest/vitest.full-extensions.config.ts",
        env: { NODE_OPTIONS: "--max-old-space-size=12288 --max_old_space_size=4096" },
      },
    ]);

    expect(specs[0]?.env.NODE_OPTIONS).toBe("--max-old-space-size=12288 --max_old_space_size=8192");
  });

  it("splits the Testbox agentic and extension shards into bounded processes", () => {
    vi.stubEnv("CI", "1");
    vi.stubEnv("GITHUB_ACTIONS", "");
    vi.stubEnv("OPENCLAW_TESTBOX_REMOTE_RUN", "1");
    vi.stubEnv("OPENCLAW_TEST_PROJECTS_LEAF_SHARDS", "");
    vi.stubEnv("OPENCLAW_TEST_PROJECTS_PARALLEL", "");
    try {
      const plans = buildFullSuiteVitestRunPlans([], process.cwd());
      const configs = plans.map((plan) => plan.config);

      expect(configs).not.toContain("test/vitest/vitest.full-agentic.config.ts");
      expect(configs).not.toContain("test/vitest/vitest.full-extensions.config.ts");
      expect(configs).toContain("test/vitest/vitest.agents-core.config.ts");
      expect(configs).toContain("test/vitest/vitest.extension-telegram.config.ts");

      const targetedPlans = (config: string) =>
        plans.filter((plan) => plan.config === config && plan.forwardedArgs.length > 0);
      expect(targetedPlans("test/vitest/vitest.agents-core.config.ts")).toHaveLength(6);
      expect(
        targetedPlans("test/vitest/vitest.agents-core.config.ts").flatMap(
          (plan) => plan.forwardedArgs,
        ),
      ).not.toContain("src/agents/agent-command-local.test.ts");
      expect(
        configs.filter((config) => config === "test/vitest/vitest.cli-process.config.ts"),
      ).toHaveLength(1);
      const gatewayTargets = targetedPlans("test/vitest/vitest.gateway-server.config.ts").map(
        (plan) => plan.forwardedArgs,
      );
      expect(gatewayTargets.every((files) => files.length > 0 && files.length <= 50)).toBe(true);
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
    const infraConfig = "test/vitest/vitest.infra.config.ts";
    const infraFiles = await listVitestConfigTestFiles(infraConfig);
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
        const plans = buildFullSuiteVitestRunPlans([], process.cwd());
        const configs = plans.map((plan) => plan.config);

        expect(configs).toContain("test/vitest/vitest.gateway-server.config.ts");
        expect(configs).toContain("test/vitest/vitest.extension-telegram.config.ts");
        expect(configs).not.toContain("test/vitest/vitest.full-agentic.config.ts");
        expect(configs).not.toContain("test/vitest/vitest.full-core-unit-fast.config.ts");

        const targetedPlans = (config: string) =>
          plans.filter((plan) => plan.config === config && plan.forwardedArgs.length > 0);
        const unitFastPlans = targetedPlans("test/vitest/vitest.unit-fast.config.ts");
        expect(unitFastPlans.length).toBeGreaterThan(1);
        expect(unitFastPlans.every((plan) => plan.forwardedArgs.length <= 70)).toBe(true);
        const unitSrcPlans = targetedPlans("test/vitest/vitest.unit-src.config.ts");
        expect(unitSrcPlans.length).toBeGreaterThan(1);
        expect(unitSrcPlans.every((plan) => plan.forwardedArgs.length <= 150)).toBe(true);
        const toolingPlans = targetedPlans("test/vitest/vitest.tooling.config.ts");
        expect(toolingPlans.length).toBeGreaterThan(1);
        expect(toolingPlans.every((plan) => plan.forwardedArgs.length <= 2)).toBe(true);
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
          expect.arrayContaining([
            "test/scripts/oxlint-boundary-guards.test.ts",
            "test/scripts/ts-topology.test.ts",
          ]),
        );
        for (const plan of plans.filter((entry) => entry.forwardedArgs.length > 0)) {
          expect(plan.timingTargets).toEqual(plan.forwardedArgs);
          expect(plan.includePatterns).toBeNull();
        }
      },
    );
  });

  it("keeps shared Vitest config helpers out of whole-config targets", () => {
    const args = ["test/vitest/vitest.shared.config.ts"];

    expect(findUnmatchedExplicitTestTargets(args, process.cwd())).toEqual([]);
    expectSingleVitestRunPlan(buildVitestRunPlans(args, process.cwd()), {
      config: "test/vitest/vitest.tooling.config.ts",
      includePatterns: ["test/vitest/**/*.test.ts"],
    });

    withTinyFileTree({ "test/vitest/vitest.helper.config.ts": "export default {};\n" }, (cwd) => {
      const helperArgs = ["test/vitest/vitest.helper.config.ts"];
      expect(findUnmatchedExplicitTestTargets(helperArgs, cwd)).toEqual([
        {
          target: "test/vitest/vitest.helper.config.ts",
          reason: "target-matched-no-test-files",
          includePattern: "test/vitest/**/*.test.ts",
        },
      ]);
      expectSingleVitestRunPlan(buildVitestRunPlans(helperArgs, cwd), {
        config: "test/vitest/vitest.tooling.config.ts",
        includePatterns: ["test/vitest/**/*.test.ts"],
      });
    });
  });
});

describe("scripts/test-projects Vitest stall watchdog", () => {
  it("arms non-watch jobs without shortening the direct runner's slow-config watchdog", () => {
    const configs = [
      "test/vitest/vitest.extension-feishu.config.ts",
      "test/vitest/vitest.gateway-server.config.ts",
    ];
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
