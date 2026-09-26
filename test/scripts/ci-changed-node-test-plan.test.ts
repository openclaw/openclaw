import childProcess, { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveTestGitCommits } from "../../.github/actions/git-owner/test-prerequisites.mjs";
import {
  buildChildEnv,
  resolveShardPlans,
  runShardPlans,
} from "../../scripts/ci-run-node-test-shard.mts";
import * as changedDependencies from "../../scripts/lib/changed-dependencies.mts";
import { listAvailableExtensionIds } from "../../scripts/lib/changed-extensions.mts";
import * as changedExtensions from "../../scripts/lib/changed-extensions.mts";
import {
  createChangedExtensionFallbackShards,
  createChangedNodeTestShards,
  hasBuildArtifactAffectingChange,
  hasControlUiPerformanceAffectingChange,
  hasCoreExtensionImpact,
  hasPromptSnapshotAffectingChange,
  hasQaSmokeAffectingChange,
  hasSqliteSessionLifecycleAffectingChange,
  hasUiE2eAffectingChange,
  resolveReleaseFastLaneScope,
} from "../../scripts/lib/ci-changed-node-test-plan.mts";
import { encodeNodeTestGroups } from "../../scripts/lib/ci-node-test-groups-codec.mts";
import {
  createNodeTestShardBundles,
  createSelectedNodeTestShardBundles,
  resolvePolicyTestTargets,
  type CompactNodeTestShard,
} from "../../scripts/lib/ci-node-test-plan.mts";
import {
  CI_PROOF_TEST_FILES,
  isCiProofTestFile,
} from "../../scripts/lib/ci-proof-test-inventory.mts";
import { refitTestTimings } from "../../scripts/lib/ci-test-timings-refit.mts";
import * as testTimings from "../../scripts/lib/ci-test-timings.mts";
import {
  listExtensionTestFilesForRoots,
  resolveExtensionTestConfig,
} from "../../scripts/lib/extension-test-plan.mts";
import * as extensionTestPlan from "../../scripts/lib/extension-test-plan.mts";
import { listVitestRuntimeConsumerFiles } from "../../scripts/lib/vitest-build-prerequisites.mts";
import {
  buildVitestRunPlans,
  hasImportGraphConsumers,
  hasImportGraphImpactOnTargets,
  resolveAffectedTestsFromImportGraph,
  resolveChangedTestTargetPlan,
} from "../../scripts/test-projects.test-support.mts";
import * as testProjects from "../../scripts/test-projects.test-support.mts";
import { listGitTrackedFiles } from "../../src/test-utils/repo-files.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createNestedGitEnv } from "../helpers/temp-repo.js";
import {
  databaseWorkerExtensionTestFiles,
  databaseWorkerExtensionTestRoots,
} from "../vitest/vitest.extension-database-workers-paths.mjs";
import { isGatewayServerTestFile } from "../vitest/vitest.gateway-server-paths.mjs";
import { isSharedVitestExcludedPath } from "../vitest/vitest.pattern-file.ts";
import { startupCorpusTestFiles } from "../vitest/vitest.startup-corpus-paths.mjs";
import { boundaryTestFiles } from "../vitest/vitest.unit-paths.mjs";

const CODEX_TEST_PROCESS_FILE_LIMIT = 24;
const argvTempDirs = useAutoCleanupTempDirTracker(afterEach);
const taskBoundaryTest = "src/tasks/task-boundaries.test.ts";
const gatewayCallsitesGuard = "src/gateway/client-callsites.guard.test.ts";

function materializeSourcePolicyFixtures(cwd: string) {
  for (const target of [gatewayCallsitesGuard, taskBoundaryTest]) {
    const file = path.join(cwd, target);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "export {};\n");
  }
}

function createErasedCoreSourceFixture() {
  const cwd = argvTempDirs.make("changed-erased-core-");
  const erasedSource = "export interface Entry { value: string }\n";
  const files = {
    "src/example/entry.ts": erasedSource,
    "src/example/entry-sibling.ts": erasedSource,
    "src/example/entry-sibling.test.ts": "export {};\n",
    "src/example/entry-imported.ts": erasedSource,
    "src/example/import-consumer.test.ts": 'import "./entry-imported.js";\n',
    "src/example/entry-read.ts": erasedSource,
    "src/example/source-reader.test.ts":
      'import { readFileSync } from "node:fs";\nreadFileSync(new URL("./entry-read.ts", import.meta.url), "utf8");\n',
    "src/example/runtime.ts": "export const value = 1;\n",
    "src/example/runtime-consumer.test.ts": 'import "./runtime.js";\n',
    "src/example/unknown.ts": "export const value = 1;\n",
    "src/example/runtime-before.ts": "export const value = 1;\n",
    "src/example/import-retained.ts": erasedSource,
    "src/example/ambient.ts": erasedSource,
    "src/example/incomplete.ts": erasedSource,
    "src/example/entry.d.ts": erasedSource,
    "src/example/retired.ts": erasedSource,
  };
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    writeFileSync(path.join(cwd, file), source);
  }
  materializeSourcePolicyFixtures(cwd);
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      { cwd, env: createNestedGitEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  git("init", "--quiet");
  git("add", ".");
  git("commit", "--quiet", "-m", "fixture baseline");
  const baseRef = git("rev-parse", "HEAD");
  for (const [file, source] of Object.entries({
    "src/example/entry.ts": "export interface Entry { value: number }\n",
    "src/example/entry-sibling.ts": "export type Entry = { value: number };\n",
    "src/example/entry-imported.ts": "export type Entry = { value: number };\n",
    "src/example/entry-read.ts": "export type Entry = { value: number };\n",
    "src/example/runtime.ts": "export const value = 2;\n",
    "src/example/runtime-before.ts": erasedSource,
    "src/example/import-retained.ts":
      'import { type Entry } from "./entry.js";\nexport type Result = Entry;\n',
    "src/example/ambient.ts": "export {};\ndeclare global { interface Window { entry: string } }\n",
    "src/example/incomplete.ts": "export interface Entry { value:\n",
    "src/example/new-entry.ts": erasedSource,
    "src/example/untracked.ts": erasedSource,
  })) {
    writeFileSync(path.join(cwd, file), source);
  }
  git("add", "src/example/new-entry.ts");
  rmSync(path.join(cwd, "src/example/retired.ts"));
  return { cwd, baseRef };
}

it.each([
  ["test/vitest/vitest.extensions.config.ts", "extensions/copilot/index.ts"],
  ["test/vitest/vitest.extension-qa.config.ts", "extensions/qa-lab/src/cli.runtime.ts"],
  ["test/vitest/vitest.extension-providers.config.ts", "extensions/anthropic/index.ts"],
])("emits each affected-package file once through %s", async (config, changedPath) => {
  const partitions = fallbackGroups(createChangedExtensionFallbackShards([changedPath])).filter(
    (group) => group.configs.includes(config),
  );
  const root = changedPath.split("/").slice(0, 2).join("/");
  const expectedFiles = listExecutableExtensionFiles([root]).filter(
    (file) => resolveExtensionTestConfig(file) === config && !isCiProofTestFile(file),
  );
  expect(partitions.length).toBeGreaterThan(0);
  expect(partitions.flatMap((group) => group.includePatterns ?? []).toSorted()).toEqual(
    expectedFiles.toSorted(),
  );
  expect(partitions.every((group) => (group.includePatterns?.length ?? 0) <= 90)).toBe(true);
  const env = {
    OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: encodeNodeTestGroups(partitions),
    OPENCLAW_NODE_TEST_PLAN_CONCURRENCY: "1",
    OPENCLAW_NODE_TEST_VITEST_ARGS_JSON: '["--hookTimeout=600000"]',
    OPENCLAW_VITEST_MAX_WORKERS: "2",
  };
  const argv: string[][] = [];
  const includeFiles: unknown[] = [];
  expect(
    await runShardPlans(resolveShardPlans(env), {
      env,
      scratchDir: argvTempDirs.make("changed-extension-argv-"),
      runChild: async (args, childEnv) => {
        argv.push(args);
        const includeFile = expectDefined(
          childEnv.OPENCLAW_VITEST_INCLUDE_FILE,
          "package include file",
        );
        includeFiles.push(JSON.parse(readFileSync(includeFile, "utf8")));
        expect(childEnv.OPENCLAW_VITEST_MAX_WORKERS).toBe("2");
        return 0;
      },
    }),
  ).toBe(0);
  const prefix = [config, "--", "--hookTimeout=600000"];
  expect(argv).toHaveLength(partitions.length);
  expect(argv).toEqual(partitions.map(() => prefix));
  expect(includeFiles).toEqual(partitions.map((group) => group.includePatterns));
});

const githubActivityHelper = ".agents/skills/openclaw-pr-maintainer/scripts/github-activity.sh";
const gitToolingTargets = [
  "ci-git-owner",
  "ci-linux-git",
  "ci-platform-checkout",
  "openclaw-performance-workflow",
  "openclaw-performance-git-lifecycle",
  "plugin-release-git-lifecycle",
  "release-workflow-git-lifecycle",
  "ci-workflow-guards",
].map((name) => `test/scripts/${name}.test.ts`);

it("keeps ordinary activity unit changes with their UI unit owner", () => {
  expect(hasUiE2eAffectingChange(["ui/src/pages/activity/activity-page.test.ts"])).toBe(false);
});

it.each(
  [
    [],
    ["ui/src/pages/activity/deleted.test.ts"],
    ["ui/src/pages/activity/activity-page.test.ts", "ui/src/pages/activity/activity-page.ts"],
    ["ui/src/pages/activity/activity-page.test.ts", "package.json"],
    ["ui/src/test-helpers/control-ui-e2e.test.ts"],
    ["ui/src/app/gateway-store.test-support.ts"],
    ["ui/src/e2e/board-a2ui.e2e.test.ts"],
    ["ui/src/styles/cursor-policy.browser.test.ts"],
    ["ui/src/components/web-awesome-migration.node.test.ts"],
    ["test/vitest/vitest.ui-e2e-prebuilt.global-setup.ts"],
    ["ui/vitest.config.ts"],
    ["extensions/example/browser/page.test.ts"],
    ["ui/src/pages/activity/../activity/activity-page.test.ts"],
  ].map((paths) => ({ paths })),
)("retains UI E2E for protected or unresolved inputs $paths", ({ paths }) => {
  expect(hasUiE2eAffectingChange(paths)).toBe(true);
});

it.each([
  [null, false],
  ["ui/src/e2e/page.e2e.test.ts", true],
  ["ui/src/pages/page.ts", true],
  ["scripts/fixture.mts", true],
  ["ui/vite.config.ts", true],
  ["ui/public/sw.js", true],
  ["ui/.cache/vitest/generated.mjs", false],
  ["ui/.artifacts/generated.mjs", false],
  ["ui/dist/generated.js", false],
  ["ui/node_modules/dependency/index.js", false],
] as const)("resolves UI E2E ownership for importer %s: %s", (consumer, expected) => {
  const cwd = mkdtempSync(path.join(tmpdir(), "openclaw-ui-unit-consumer-"));
  const target = "ui/src/pages/unit.test.ts";
  try {
    mkdirSync(path.dirname(path.join(cwd, target)), { recursive: true });
    writeFileSync(path.join(cwd, target), "export const fixture = 1;\n");
    if (consumer) {
      mkdirSync(path.dirname(path.join(cwd, consumer)), { recursive: true });
      const relative = path.relative(path.dirname(consumer), target).split(path.sep).join("/");
      writeFileSync(
        path.join(cwd, consumer),
        `import "${relative.startsWith(".") ? relative : `./${relative}`}";\n`,
      );
    }
    writeFileSync(path.join(cwd, ".gitignore"), ".cache/\n.artifacts/\ndist/\nnode_modules/\n");
    execFileSync("git", ["init", "-q"], { cwd });
    execFileSync("git", ["add", "."], { cwd });
    expect(
      hasImportGraphImpactOnTargets([target], (file) => file !== target, cwd, { tooling: true }),
    ).toBe(expected);
    expect(hasUiE2eAffectingChange([target], { cwd })).toBe(expected);
  } finally {
    rmSync(cwd, { force: true, recursive: true });
  }
});

it.each(["archive", "untracked", "symlink"])("retains UI E2E for %s unit inputs", (mode) => {
  const cwd = mkdtempSync(path.join(tmpdir(), "openclaw-ui-unit-inventory-"));
  const target = "ui/src/unit.test.ts";
  try {
    mkdirSync(path.join(cwd, "ui/src"), { recursive: true });
    if (mode === "symlink") {
      writeFileSync(path.join(cwd, "ui/src/source.ts"), "export {};\n");
      symlinkSync("source.ts", path.join(cwd, target));
    } else {
      writeFileSync(path.join(cwd, target), "export {};\n");
    }
    if (mode !== "archive") {
      execFileSync("git", ["init", "-q"], { cwd });
    }
    if (mode === "symlink") {
      execFileSync("git", ["add", "."], { cwd });
    }
    expect(hasUiE2eAffectingChange([target], { cwd })).toBe(true);
  } finally {
    rmSync(cwd, { force: true, recursive: true });
  }
});

function expectBoundedCodexFallback(
  shards: ReturnType<typeof createChangedExtensionFallbackShards>,
) {
  const groups = fallbackGroups(shards);
  const targets = groups.flatMap((group) => group.includePatterns ?? []);

  expect(groups.length).toBeGreaterThan(1);
  expect(
    groups.every(
      (shard) =>
        shard.configs[0] ===
          (shard.includePatterns?.every((file) => databaseWorkerExtensionTestFiles.includes(file))
            ? "test/vitest/vitest.extension-database-workers.config.ts"
            : "test/vitest/vitest.extension-codex.config.ts") &&
        (shard.includePatterns?.length ?? 0) > 0 &&
        (shard.includePatterns?.length ?? 0) <= CODEX_TEST_PROCESS_FILE_LIMIT,
    ),
  ).toBe(true);
  expect(targets.toSorted()).toEqual(listExecutableExtensionFiles(["extensions/codex"]).toSorted());
}

function listExecutableExtensionFiles(roots: string[]) {
  return listExtensionTestFilesForRoots(roots).filter(
    (file) => !isSharedVitestExcludedPath(file, "extensions"),
  );
}

function fallbackGroups(shards: ReturnType<typeof createChangedExtensionFallbackShards>) {
  return shards.flatMap((shard) => shard.groups ?? [{ ...shard, shard_name: shard.shardName }]);
}

function selectedFiles(shards: ReturnType<typeof createChangedNodeTestShards>) {
  return (shards ?? []).flatMap((shard) =>
    (shard.targets ?? []).concat(
      shard.includePatterns ?? [],
      shard.groups?.flatMap((group) => group.includePatterns ?? []) ?? [],
    ),
  );
}

function expectAllExtensionConfigs(
  shards: ReturnType<typeof createChangedExtensionFallbackShards>,
) {
  const configs = new Set(fallbackGroups(shards).flatMap((group) => group.configs));
  const expectedConfigs = new Set(
    listAvailableExtensionIds().map((extensionId) =>
      resolveExtensionTestConfig(`extensions/${extensionId}`),
    ),
  );

  expect(configs).toEqual(expectedConfigs);
  expect(configs).toContain("test/vitest/vitest.extension-codex.config.ts");
}

describe("CI changed Node test plan", () => {
  it("reuses a complete consumer graph until the tracked inventory changes", () => {
    const cwd = argvTempDirs.make("changed-cached-consumers-");
    const files = {
      "tsconfig.json": JSON.stringify({
        compilerOptions: { paths: { "@fixture/shared": ["./src/shared.ts"] } },
      }),
      "src/shared.ts": "export const shared = 1;\n",
      "src/consumer.test.ts": 'import "@fixture/shared";\n',
      "src/self.ts": 'import "./self.js";\n',
      "src/types.ts": "export interface Value { value: string }\n",
      "src/type-consumer.test.ts": 'import type { Value } from "./types.js";\n',
      "src/later.ts": "export const value = 1;\n",
    };
    for (const [file, source] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
      writeFileSync(path.join(cwd, file), source);
    }
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
        cwd,
        env: createNestedGitEnv(),
        stdio: "pipe",
      });
    git("init", "--quiet");
    git("add", ".");
    const options = { tooling: true, resolveAliases: true, runtimeOnly: true, forceFull: true };
    expect(resolveAffectedTestsFromImportGraph(["src/shared.ts"], cwd, options)).toEqual([
      "src/consumer.test.ts",
    ]);
    const spawn = vi.spyOn(childProcess, "spawnSync");
    syncBuiltinESMExports();
    try {
      for (const [file, expected] of [
        ["src/shared.ts", true],
        ["src/self.ts", false],
        ["src/types.ts", false],
        ["src/missing.ts", true],
      ] as const) {
        expect(hasImportGraphConsumers([file], cwd, options), file).toBe(expected);
      }
      expect(
        spawn.mock.calls.filter(([command, args]) => command === "git" && args?.[0] === "grep"),
      ).toEqual([]);
      writeFileSync(path.join(cwd, "src/later-consumer.test.ts"), 'import "./later.js";\n');
      git("add", "src/later-consumer.test.ts");
      expect(hasImportGraphConsumers(["src/later.ts"], cwd, options)).toBe(true);
    } finally {
      spawn.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it("defers named process proofs without dropping mixed ordinary targets", () => {
    const ordinary = "src/plugin-sdk/config-runtime.test.ts";
    const shards = createChangedNodeTestShards([...CI_PROOF_TEST_FILES, ordinary]);
    expect(shards).not.toBeNull();
    const files = (shards ?? []).flatMap((shard) =>
      (shard.targets ?? []).concat(
        shard.includePatterns ?? [],
        shard.groups?.flatMap((group) => group.includePatterns ?? []) ?? [],
      ),
    );
    expect(files).toContain(ordinary);
    expect(files.some(isCiProofTestFile)).toBe(false);
  });

  it("defers indirect runtime proofs after resolving every changed source and helper", () => {
    const cwd = argvTempDirs.make("changed-runtime-proof-");
    const source = "src/infra/release-proof.ts";
    const helper = "src/infra/release-proof.test-support.ts";
    const deferred = "src/state/openclaw-database-preflight.lifecycle.test.ts";
    const ordinary = "src/plugin-sdk/config-runtime.test.ts";
    const unknown = "src/infra/unowned.ts";
    for (const [file, content] of [
      [source, "export {};\n"],
      [helper, 'import "./release-proof.js";\n'],
      [deferred, 'import "../infra/release-proof.test-support.js";\n'],
      [ordinary, 'import "../infra/release-proof.js";\n'],
      [unknown, "export {};\n"],
    ] as const) {
      mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
      writeFileSync(path.join(cwd, file), content);
    }
    materializeSourcePolicyFixtures(cwd);
    const options = { cwd, includeReleaseOnlyRuntimeTests: false };
    const helperPlan = createChangedNodeTestShards([helper], options);
    expect(helperPlan).toEqual([
      expect.objectContaining({ targets: [taskBoundaryTest], requiresDist: false }),
      expect.objectContaining({
        checkName: "checks-node-changed-boundary",
        configs: ["test/vitest/vitest.boundary.config.ts"],
      }),
    ]);
    const sourcePlan = createChangedNodeTestShards([source], options);
    expect(sourcePlan).not.toBeNull();
    expect(sourcePlan?.flatMap((shard) => shard.targets ?? [])).toEqual([
      ordinary,
      gatewayCallsitesGuard,
      taskBoundaryTest,
    ]);
    for (const companion of [unknown, "src/infra/deleted.ts"]) {
      expect(createChangedNodeTestShards([helper, companion], options)).toBeNull();
    }
  });

  it.each(["blacksmith", "github", "hybrid"])(
    "retains directly changed runtime proofs and ordinary dependents with canonical policies (%s)",
    (runnerBackend) => {
      const targets = [
        "src/agents/agent-bundle-mcp-retention.test.ts",
        "src/agents/mcp-stdio-client.cleanup.real.test.ts",
        "src/cli/gateway-cli/pre-bootstrap.process.test.ts",
        "src/commands/doctor-config-preflight.refusal.process.test.ts",
        "src/flows/doctor-health.test.ts",
        "src/gateway/server.sessions.archive-worktree-lifecycle.test.ts",
        "src/gateway/server.sessions.delete-worktree-lifecycle.test.ts",
        "src/infra/update-managed-service-handoff-foreground.test.ts",
        "src/node-host/node-worker-supervisor.recovery.test.ts",
        "src/process/supervisor/adapters/child.service-lifecycle.test.ts",
        "src/state/openclaw-database-preflight.lifecycle.test.ts",
        "src/config/state-startup-corpus.part-2.test.ts",
        "test/scripts/ci-linux-git.test.ts",
        "test/scripts/full-release-validation-at-sha.test.ts",
        "test/scripts/package-acceptance-workflow.test.ts",
        "test/scripts/pr-merge-admission.test.ts",
        "test/scripts/pr-merge-outcome.test.ts",
        "test/scripts/pr-merge-receipt.test.ts",
        "test/scripts/pr-merge-recovery.test.ts",
        "test/scripts/pr-merge-rest.test.ts",
        "test/scripts/pr-worktree-interruption.test.ts",
        "test/scripts/pr-worktree-provision.test.ts",
      ];
      const before = createChangedNodeTestShards(targets, { runnerBackend });
      const selected = createChangedNodeTestShards(targets, {
        runnerBackend,
        includeReleaseOnlyRuntimeTests: false,
      });
      expect(before).not.toBeNull();
      expect(selected).not.toBeNull();
      const envScratch = argvTempDirs.make("changed-runtime-owner-env-");
      const groups = selected?.flatMap((shard) => shard.groups ?? []) ?? [];
      expect(
        [
          ...(selected?.flatMap((shard) => shard.targets ?? []) ?? []),
          ...(selected?.flatMap((shard) => shard.includePatterns ?? []) ?? []),
          ...groups.flatMap((group) => group.includePatterns ?? []),
        ].toSorted(),
      ).toEqual(
        [
          ...targets,
          "test/scripts/ci-git-owner.test.ts",
          "test/scripts/ci-platform-checkout.test.ts",
          "test/scripts/ci-workflow-guards.test.ts",
          "test/scripts/openclaw-performance-git-lifecycle.test.ts",
          "test/scripts/openclaw-performance-workflow.test.ts",
          "test/scripts/plugin-release-git-lifecycle.test.ts",
          "test/scripts/release-workflow-git-lifecycle.test.ts",
          "test/scripts/test-projects.test.ts",
        ].toSorted(),
      );
      for (const target of targets) {
        const ownerJob = expectDefined(
          before?.find(
            (shard) =>
              shard.targets?.includes(target) ||
              shard.includePatterns?.includes(target) ||
              shard.groups?.some((group) => group.includePatterns?.includes(target)),
          ),
          `canonical job for ${target}`,
        );
        const ownerGroup = ownerJob.groups?.find((group) =>
          group.includePatterns?.includes(target),
        );
        const owner = ownerGroup ?? ownerJob;
        const selectedJob = expectDefined(
          selected?.find(
            (shard) =>
              shard.targets?.includes(target) ||
              shard.includePatterns?.includes(target) ||
              shard.groups?.some((group) => group.includePatterns?.includes(target)),
          ),
          `selected job for ${target}`,
        );
        const selectedGroup = selectedJob.groups?.find((group) =>
          group.includePatterns?.includes(target),
        );
        const selectedOwner = selectedGroup ?? selectedJob;
        expect(selectedOwner.configs).toEqual(owner.configs);
        expect(selectedOwner.env).toEqual(owner.env);
        expect(selectedOwner.requiresDist).toBe(owner.requiresDist);
        expect(selectedOwner.pretestBuildMode).toBe(owner.pretestBuildMode);
        expect(selectedGroup?.fallbackMaxWorkers).toBe(ownerGroup?.fallbackMaxWorkers);
        expect(selectedGroup?.minTotalMemoryBytes).toBe(ownerGroup?.minTotalMemoryBytes);
        const ownerEntry = ownerGroup
          ? { kind: "group" as const, name: ownerGroup.shard_name, plan: ownerGroup }
          : { kind: "target" as const, name: target, target };
        const selectedEntry = selectedGroup
          ? { kind: "group" as const, name: selectedGroup.shard_name, plan: selectedGroup }
          : { kind: "target" as const, name: target, target };
        expect(buildChildEnv(selectedEntry, selectedJob.env ?? {}, envScratch, 0)).toEqual({
          ...buildChildEnv(ownerEntry, ownerJob.env ?? {}, envScratch, 0),
          // Repacking changes the label, but every execution policy stays fixed.
          ...(selectedGroup ? { OPENCLAW_VITEST_SHARD_NAME: selectedGroup.shard_name } : {}),
        });
        expect(selectedJob.runner).toBe(ownerJob.runner);
        expect(selectedJob.requiresDist).toBe(ownerJob.requiresDist);
        expect(selectedJob.planConcurrency).toBe(ownerJob.planConcurrency);
        expect(selectedJob.pretestBuildMode).toBe(ownerJob.pretestBuildMode);
      }
    },
  );

  it.each(["blacksmith", "github", "hybrid"])(
    "keeps directly affected tooling owners without selecting unrelated tooling (%s)",
    (runnerBackend) => {
      for (const [changedPath, target] of [
        [
          "src/cli/update-cli/update-command-legacy-finalize.test.ts",
          "src/cli/update-cli/update-command-legacy-finalize.test.ts",
        ],
        ["test/scripts/vitest-report-owner.test.ts", "test/scripts/vitest-report-owner.test.ts"],
        ["scripts/lib/vitest-report-owner.mts", "test/scripts/vitest-report-owner.test.ts"],
      ] as const) {
        const shards = createChangedNodeTestShards([changedPath], {
          runnerBackend,
          includeReleaseOnlyToolingShards: false,
        });
        expect(shards).not.toBeNull();
        const targetConfig = expectDefined(
          buildVitestRunPlans([target])[0]?.config,
          "tooling target config",
        );
        expect(
          selectedFiles(shards).includes(target) ||
            fallbackGroups(shards ?? []).some(
              (group) => group.configs.includes(targetConfig) && !group.includePatterns,
            ),
        ).toBe(true);
        expect(selectedFiles(shards)).not.toContain("test/scripts/mobile-release-ci.test.ts");
      }
    },
  );

  it("keeps product-only precise selections free of maintainer tooling", () => {
    const shards = createChangedNodeTestShards(
      [
        "src/infra/retry.test.ts",
        "src/cli/update-cli/update-command-legacy-finalize-entrypoint.test-support.ts",
      ],
      { includeReleaseOnlyToolingShards: false },
    );
    expect(shards).not.toBeNull();
    const files = shards?.flatMap((shard) => [
      ...(shard.targets ?? shard.includePatterns ?? []),
      ...(shard.groups?.flatMap((group) => group.includePatterns ?? []) ?? []),
    ]);
    expect(files).toContain("src/infra/retry.test.ts");
    expect(files).not.toContain("src/cli/update-cli/update-command-legacy-finalize.test.ts");
    expect(
      shards?.some((shard) =>
        [...shard.configs, ...(shard.groups?.flatMap((group) => group.configs) ?? [])].some(
          (config) => config.includes("vitest.tooling"),
        ),
      ),
    ).toBe(false);
  });

  it.each(["blacksmith", "github", "hybrid"])(
    "retains a directly changed release-only report composition with its tooling owner (%s)",
    (runnerBackend) => {
      const target = "test/scripts/vitest-report-owner.test.ts";
      const shards = createChangedNodeTestShards([target], { runnerBackend });
      expect(shards).not.toBeNull();
      const owners = shards?.flatMap((job) =>
        (job.groups ?? []).filter((group) => group.includePatterns?.includes(target)),
      );
      expect(owners).toHaveLength(1);
      const owner = expectDefined(owners?.[0], "report composition tooling owner");
      expect(owner).toMatchObject({
        configs: ["test/vitest/vitest.tooling.config.ts"],
        env: { OPENCLAW_VITEST_MAX_WORKERS: "2" },
        requiresDist: false,
      });
      expect(shards?.find((job) => job.groups?.includes(owner))?.planConcurrency).toBe(1);
      expect(shards?.some((job) => job.requiresDist)).toBe(false);
      expect(shards).toContainEqual(
        expect.objectContaining({ configs: ["test/vitest/vitest.boundary.config.ts"] }),
      );
    },
  );

  it("retains the paired tooling group for direct Docker helper selection", () => {
    const shards = createSelectedNodeTestShardBundles(["test/scripts/docker-build-helper.test.ts"]);
    expect(shards).not.toBeNull();
    expect(shards?.flatMap((shard) => shard.groups).map((group) => group.shard_name)).toEqual([
      "core-tooling-isolated",
    ]);
  });

  it("avoids full-suite fallback for the ClawHub fixture's four changed paths", () => {
    const shards = createChangedNodeTestShards([
      "scripts/e2e/lib/skills/clawhub-install-proof.sh",
      "scripts/e2e/skill-install-docker.sh",
      "test/scripts/e2e-shell-tempfiles.test.ts",
      "docs/help/testing/docker.md",
    ]);
    expect(shards).not.toBeNull();
    expect(
      shards
        ?.flatMap((shard) => shard.groups ?? [])
        .filter((group) => group.shard_name === "core-tooling-isolated"),
    ).toHaveLength(1);
  });

  it.each(["blacksmith", "github", "hybrid"])(
    "retains the complete paired tooling descriptor and job metadata (%s)",
    (runnerBackend) => {
      const docker = "test/scripts/docker-build-helper.test.ts";
      const isolated = "test/plugins/bundled-provider-auth-literal-parity.test.ts";
      const full = createNodeTestShardBundles({
        compactMode: "pull-request",
        runnerBackend,
        includeReleaseOnlyPluginShards: false,
      });
      const ownerJob = expectDefined(
        full.find((job) =>
          job.groups.some((group) => group.shard_name === "core-tooling-isolated"),
        ),
        "canonical paired tooling job",
      );
      const owner = expectDefined(
        ownerJob.groups.find((group) => group.shard_name === "core-tooling-isolated"),
        "canonical paired tooling group",
      );
      expect(owner.configs).toEqual([
        "test/vitest/vitest.tooling-docker.config.ts",
        "test/vitest/vitest.tooling-isolated.config.ts",
      ]);
      expect(owner.includePatterns).toBeUndefined();
      expect(owner.env?.OPENCLAW_VITEST_MAX_WORKERS).toBe("2");
      expect(ownerJob.planConcurrency).toBe(1);

      for (const targets of [
        [docker],
        [isolated],
        [docker, isolated, "test/scripts/docker-e2e-update-suppression.test.ts", docker, isolated],
        [isolated, "test/scripts/ci-linux-git.test.ts"],
        [docker, "src/agents/embedded-agent-runner/run/attempt-yield-handoff.test.ts"],
        [docker, "src/tui/tui-pty-local.e2e.test.ts"],
      ]) {
        const selected = expectDefined(
          createSelectedNodeTestShardBundles(targets, { runnerBackend }),
          "selected paired tooling plan",
        );
        const pairs = selected.flatMap((job) =>
          job.groups.filter((group) => group.shard_name === "core-tooling-isolated"),
        );
        expect(pairs).toEqual([owner]);
        const selectedJob = expectDefined(
          selected.find((job) => job.groups.includes(pairs[0]!)),
          "selected paired tooling job",
        );
        expect(selectedJob).toEqual({
          ...ownerJob,
          checkName: `checks-node-changed-${ownerJob.shardName}`,
          shardName: `changed-${ownerJob.shardName}`,
          groups: [owner],
        });
        const encodedGroups = selectedJob.groups.map(
          ({ configs, env, includePatterns, shard_name, timing_key }) => ({
            configs,
            env,
            includePatterns,
            shard_name,
            timing_key,
          }),
        );
        expect(
          resolveShardPlans({
            OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: encodeNodeTestGroups(encodedGroups),
          }),
        ).toEqual(
          encodedGroups.map((plan) => ({
            kind: "group",
            name: plan.shard_name,
            timingKey: plan.timing_key ?? plan.shard_name,
            plan,
          })),
        );
        expect(resolveTestGitCommits(selectedJob)).toEqual(
          resolveTestGitCommits({ groups: [owner] }),
        );
        for (const target of targets.filter((file) => file !== docker && file !== isolated)) {
          expect(
            selected.some((job) =>
              job.groups.some(
                (group) =>
                  group.includePatterns?.includes(target) ||
                  (!group.includePatterns &&
                    group.configs.includes(buildVitestRunPlans([target])[0]!.config)),
              ),
            ),
          ).toBe(true);
        }
      }
    },
  );

  it.each([
    "test/scripts/docker-build-helper.test.ts",
    "test/plugins/bundled-provider-auth-literal-parity.test.ts",
  ])("does not borrow paired tooling ownership for another checkout: %s", (target) => {
    const cwd = mkdtempSync(path.join(tmpdir(), "openclaw-paired-tooling-owner-"));
    try {
      mkdirSync(path.dirname(path.join(cwd, target)), { recursive: true });
      writeFileSync(path.join(cwd, target), "export {};\n");
      expect(createChangedNodeTestShards([target], { cwd })).toBeNull();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.each(["blacksmith", "github", "hybrid"])(
    "retains precise files with their canonical process owners (%s)",
    (runnerBackend) => {
      const embeddedTest = "src/agents/embedded-agent-runner/run/attempt.abort-race.test.ts";
      const siblings = [
        "src/agents/embedded-agent-runner/model-resolution-consistency.test.ts",
        "src/agents/embedded-agent-runner/run.incomplete-turn.classification.test.ts",
        "src/agents/embedded-agent-runner/run.overflow-compaction.test.ts",
      ];
      // Precise plans inherit templates before whole-plan runtime relocation.
      const placement = vi.spyOn(testTimings, "readRuntimePlacementTimings").mockReturnValue([]);
      let full: CompactNodeTestShard[];
      try {
        full = createNodeTestShardBundles({
          compactMode: "pull-request",
          runnerBackend,
          includeReleaseOnlyPluginShards: false,
        });
      } finally {
        placement.mockRestore();
      }
      for (const targets of [[embeddedTest], [...siblings, embeddedTest]]) {
        const shards = createChangedNodeTestShards(targets, { runnerBackend });
        expect(shards).not.toBeNull();
        const groups = shards?.flatMap((shard) => shard.groups ?? []) ?? [];
        expect(groups.flatMap((group) => group.includePatterns ?? []).toSorted()).toEqual(
          targets.toSorted(),
        );
        for (const group of groups) {
          const ownerJob = full.find((shard) =>
            shard.groups.some((owner) => owner.shard_name === group.shard_name),
          );
          const owner = ownerJob?.groups.find(
            (candidate) => candidate.shard_name === group.shard_name,
          );
          expect(owner).toBeDefined();
          expect(group.includePatterns?.length).toBeGreaterThan(0);
          for (const target of group.includePatterns ?? []) {
            expect(group.configs).toEqual([buildVitestRunPlans([target])[0]?.config]);
          }
          expect(group.env?.OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS).toBe("660000");
          expect(group.env).toEqual(owner?.env);
          expect(group.timing_key).toContain("#selector-");
          expect(group.timing_key).not.toBe(group.shard_name);
          const { timings } = refitTestTimings(
            [1, 2].map((id) => ({
              id,
              createdAt: "2026-09-12T00:00:00Z",
              completeInventory: false,
              logs: [
                {
                  kind: "compact" as const,
                  labels: ["blacksmith-8vcpu-ubuntu-2404"],
                  text: [
                    `2026-09-12T00:00:00Z [shard:${group.timing_key}] begin`,
                    `2026-09-12T00:00:01Z [shard:${group.timing_key}] end (exit 0)`,
                  ].join("\n"),
                },
              ],
            })),
          );
          expect(timings.compactGroupSeconds.blacksmith[group.timing_key!]).toBe(1);
          expect(timings.compactGroupSeconds.blacksmith[group.shard_name]).toBeUndefined();
          const selectedJob = shards?.find((shard) => shard.groups?.includes(group));
          expect(selectedJob?.runner).toBe(ownerJob?.runner);
          expect(selectedJob?.planConcurrency).toBe(ownerJob?.planConcurrency);
          expect(selectedJob?.pretestBuildMode).toBe(ownerJob?.pretestBuildMode);
          expect(selectedJob?.predictedSeconds).toBe(ownerJob?.predictedSeconds);
          expect(selectedJob?.timeoutMinutes).toBe(ownerJob?.timeoutMinutes);
        }
        expect(shards?.filter((shard) => !shard.groups)).toEqual([
          expect.objectContaining({
            configs: ["test/vitest/vitest.boundary.config.ts"],
            requiresDist: false,
          }),
        ]);
        expect(shards?.some((shard) => shard.requiresDist)).toBe(false);
      }

      const acp = "src/acp/control-plane/manager.accepted-controls.test.ts";
      const logging = "src/logging/logger-file-transport.test.ts";
      const processTest = "src/process/exec.test.ts";
      for (const { targets, configs } of [
        { targets: [acp], configs: ["test/vitest/vitest.acp.config.ts"] },
        {
          targets: ["src/gateway/setup-inference.first-signin.integration.test.ts"],
          configs: ["test/vitest/vitest.gateway-database-workers.config.ts"],
        },
        {
          targets: [
            "src/audit/execution-decision-facts.test.ts",
            "src/auto-reply/reply/commands-export-session.test.ts",
            "src/gateway/server-methods/session-change-event.fallback.test.ts",
          ],
          configs: [
            "test/vitest/vitest.unit-src.config.ts",
            "test/vitest/vitest.auto-reply-reply.config.ts",
            "test/vitest/vitest.gateway-methods.config.ts",
          ],
        },
        { targets: [logging], configs: ["test/vitest/vitest.logging.config.ts"] },
        {
          targets: [logging, processTest],
          configs: ["test/vitest/vitest.logging.config.ts", "test/vitest/vitest.process.config.ts"],
        },
      ]) {
        const selected = expectDefined(
          createSelectedNodeTestShardBundles(targets, { runnerBackend }),
          "precise multi-config owner selection",
        );
        if (targets.includes("src/gateway/setup-inference.first-signin.integration.test.ts")) {
          expect(selected).toEqual([expect.objectContaining({ planConcurrency: 1 })]);
        }
        expect(
          selected
            .flatMap((job) => job.groups.flatMap((group) => group.includePatterns ?? []))
            .toSorted(),
        ).toEqual(targets.toSorted());
        expect(
          selected.flatMap((job) => job.groups.flatMap((group) => group.configs)).toSorted(),
        ).toEqual(configs.toSorted());
        for (const job of selected) {
          for (const group of job.groups) {
            const ownerJob = expectDefined(
              full.find((candidate) =>
                candidate.groups.some((owner) => owner.shard_name === group.shard_name),
              ),
              `canonical job for ${group.shard_name}`,
            );
            const owner = expectDefined(
              ownerJob.groups.find((candidate) => candidate.shard_name === group.shard_name),
              `canonical group for ${group.shard_name}`,
            );
            expect(group.env).toEqual(owner.env);
            expect(group.fallbackMaxWorkers).toBe(owner.fallbackMaxWorkers);
            expect(group.minTotalMemoryBytes).toBe(owner.minTotalMemoryBytes);
            expect(group.pretestBuildMode).toBe(owner.pretestBuildMode);
            expect(job.env).toEqual(ownerJob.env);
            expect(job.runner).toBe(ownerJob.runner);
            expect(job.planConcurrency).toBe(ownerJob.planConcurrency);
            expect(job.timeoutMinutes).toBe(ownerJob.timeoutMinutes);
          }
        }
      }

      const tuiTargets = [
        "src/tui/tui-pty-local.e2e.test.ts",
        "src/tui/tui-pty-harness.e2e.test.ts",
      ];
      const tuiOwnerJob = expectDefined(
        full.find((job) => job.groups.some((group) => group.shard_name === "core-runtime-tui-pty")),
        "canonical built TUI job",
      );
      const tuiOwner = expectDefined(
        tuiOwnerJob.groups.find((group) => group.shard_name === "core-runtime-tui-pty"),
        "canonical built TUI group",
      );
      expect(tuiOwner).toMatchObject({
        configs: ["test/vitest/vitest.tui-pty.config.ts"],
        env: {
          OPENCLAW_TUI_PTY_INCLUDE_LOCAL: "1",
          OPENCLAW_TUI_PTY_USE_BUILT_CLI: "1",
        },
        requiresDist: true,
      });
      expect(tuiOwner.includePatterns).toBeUndefined();
      expect(createSelectedNodeTestShardBundles(tuiTargets, { runnerBackend })).toEqual([
        {
          ...tuiOwnerJob,
          checkName: `checks-node-changed-${tuiOwnerJob.shardName}`,
          shardName: `changed-${tuiOwnerJob.shardName}`,
          groups: [tuiOwner],
        },
      ]);
      const changedTui = createChangedNodeTestShards(tuiTargets, { runnerBackend });
      expect(changedTui).not.toBeNull();
      expect(
        changedTui?.flatMap((job) => job.groups ?? []).filter((group) => group.requiresDist),
      ).toEqual([tuiOwner]);
      expect(selectedFiles(changedTui).some((file) => tuiTargets.includes(file))).toBe(false);
      expect(
        fallbackGroups(changedTui?.filter((job) => !job.requiresDist) ?? []).flatMap(
          (group) => group.configs,
        ),
      ).not.toContain("test/vitest/vitest.tui-pty.config.ts");
    },
  );

  it.each(["blacksmith", "github", "hybrid"])(
    "keeps the complete Git tooling family in canonical serial owners (%s)",
    (runnerBackend) => {
      const changedPaths = ["test/scripts/ci-linux-git.test.ts"];
      const expectedTargets = [...gitToolingTargets, "test/scripts/test-projects.test.ts"];
      const shards = createChangedNodeTestShards(changedPaths, { runnerBackend });
      expect(shards).not.toBeNull();
      const groups = shards?.flatMap((shard) => shard.groups ?? []) ?? [];
      const tooling = groups.filter((group) => !group.requiresDist);
      expect(tooling.flatMap((group) => group.includePatterns ?? []).toSorted()).toEqual(
        expectedTargets.toSorted(),
      );
      expect(
        shards?.filter((shard) => shard.groups).every((shard) => shard.planConcurrency === 1),
      ).toBe(true);
      const full = createNodeTestShardBundles({
        compactMode: "pull-request",
        runnerBackend,
        includeReleaseOnlyPluginShards: false,
        changedPaths,
      });
      const canonical = full.flatMap((shard) => shard.groups);
      for (const group of tooling) {
        const owner = canonical.find((candidate) => candidate.shard_name === group.shard_name);
        expect(owner).toBeDefined();
        expect(group.configs).toEqual(["test/vitest/vitest.tooling.config.ts"]);
        expect(group.env).toEqual({ ...owner?.env, OPENCLAW_VITEST_MAX_WORKERS: "2" });
        expect(group.pretestBuildMode).toBeUndefined();
        // Capacity for an excluded compiler fixture must not transfer to these files.
        expect(group.runner).toBe("blacksmith-4vcpu-ubuntu-2404");
        expect(group.timing_key).not.toBe(owner?.timing_key ?? owner?.shard_name);
        expect(group.timing_key).toContain("#selector-");
        expect(group.includePatterns?.every((file) => owner?.includePatterns?.includes(file))).toBe(
          true,
        );
      }
      expect(shards?.some((shard) => shard.requiresDist)).toBe(false);
      expect(shards).toContainEqual(
        expect.objectContaining({ configs: ["test/vitest/vitest.boundary.config.ts"] }),
      );
      for (const shard of shards?.filter((job) => job.groups) ?? []) {
        const encodedGroups = (shard.groups ?? []).map(
          ({ configs, env, includePatterns, shard_name, timing_key }) => ({
            configs,
            env,
            includePatterns,
            shard_name,
            timing_key,
          }),
        );
        expect(
          resolveShardPlans({
            OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: encodeNodeTestGroups(encodedGroups ?? []),
          }),
        ).toEqual(
          encodedGroups.map((plan: { shard_name: string; timing_key?: string }) => ({
            kind: "group",
            name: plan.shard_name,
            plan,
            timingKey: plan.timing_key ?? plan.shard_name,
          })),
        );
        expect(shard.predictedSeconds).toBeGreaterThan(0);
        if (runnerBackend === "blacksmith" && !shard.requiresDist) {
          expect(shard.runner).toBe("blacksmith-32vcpu-ubuntu-2404");
        }
      }
      expect(new Set((shards ?? []).flatMap(resolveTestGitCommits))).toEqual(
        new Set(expectedTargets.flatMap((target) => resolveTestGitCommits({ targets: [target] }))),
      );
    },
  );

  it("retains ordinary and embedded targets beside a shared Git fixture's canonical family", () => {
    const ordinary = "src/plugin-sdk/config-runtime.test.ts";
    const embedded = "src/agents/embedded-agent-runner/run/attempt.abort-race.test.ts";
    const shards = createChangedNodeTestShards([
      "test/scripts/ci-git-owner.test-support.ts",
      ordinary,
      embedded,
    ]);
    expect(shards).not.toBeNull();
    expect(shards?.flatMap((shard) => shard.targets ?? []).toSorted()).toEqual(
      [ordinary, "test/scripts/ci-git-prerequisites.test.ts"].toSorted(),
    );
    expect(
      fallbackGroups(shards ?? [])
        .flatMap((group) => group.includePatterns ?? [])
        .toSorted(),
    ).toEqual([...gitToolingTargets, embedded].toSorted());
    expect(shards?.some((shard) => shard.requiresDist)).toBe(false);
    expect(shards).toContainEqual(
      expect.objectContaining({ configs: ["test/vitest/vitest.boundary.config.ts"] }),
    );
    for (const other of ["src/deleted.ts", "tsconfig.json"]) {
      expect(createChangedNodeTestShards(["test/scripts/ci-linux-git.test.ts", other])).toBeNull();
    }
  });

  it.each(
    [
      [],
      ["test/scripts/unknown-tooling.test.ts"],
      ["src/agents/embedded-agent-runner/run/unknown-owner.test.ts"],
      ["test/vitest/vitest.tooling.config.ts"],
      ["test/vitest/vitest.tooling-isolated.config.ts"],
      ["test/scripts/docker-build-helper.test.ts", "test/scripts/unknown-tooling.test.ts"],
    ].map((targets) => ({ targets })),
  )("refuses incomplete or unsupported canonical selection $targets", ({ targets }) => {
    expect(createSelectedNodeTestShardBundles(targets)).toBeNull();
  });

  it("does not borrow canonical embedded ownership for another checkout", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "openclaw-embedded-owner-"));
    const target = "src/agents/embedded-agent-runner/run/attempt.abort-race.test.ts";
    try {
      mkdirSync(path.dirname(path.join(cwd, target)), { recursive: true });
      writeFileSync(path.join(cwd, target), "export {};\n");
      expect(buildVitestRunPlans([target], cwd)[0]?.includePatterns).toEqual([target]);
      expect(createChangedNodeTestShards([target], { cwd })).toBeNull();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("leaves dedicated UI tests to their owners while retaining changed Node-driven tests", () => {
    const browser = "ui/src/components/markdown-mermaid.runtime.browser.test.ts";
    const node = "ui/src/components/form-controls.browser.test.ts";
    const uiE2e = [
      "ui/src/e2e/chat-widget-sandbox.real-gateway.e2e.test.ts",
      "ui/src/e2e/settings-layout.e2e.test.ts",
    ];
    const changedPaths = [browser, node, ...uiE2e];
    const shards = createChangedNodeTestShards(changedPaths);
    expect(shards).not.toBeNull();
    const targets = shards?.flatMap((shard) => shard.targets ?? []) ?? [];
    expect(targets).toContain(node);
    expect(targets).not.toContain(browser);
    expect(targets).toEqual(expect.arrayContaining(uiE2e));
    expect(createChangedNodeTestShards(changedPaths, { dedicatedUiE2e: false })).toEqual(shards);

    const dedicated = createChangedNodeTestShards(changedPaths, { dedicatedUiE2e: true });
    expect(dedicated).not.toBeNull();
    expect(dedicated?.flatMap((shard) => shard.targets ?? [])).toEqual(
      targets.filter((target) => !uiE2e.includes(target)),
    );
    expect(dedicated?.filter((shard) => !shard.targets)).toEqual(
      shards?.filter((shard) => !shard.targets),
    );
    const coreE2e = "src/gateway/gateway.test.ts";
    for (const dedicatedUiE2e of [false, true]) {
      const coreShards = createChangedNodeTestShards([coreE2e], { dedicatedUiE2e });
      expect(coreShards).not.toBeNull();
      expect(selectedFiles(coreShards)).toContain(coreE2e);
      expect(buildVitestRunPlans([coreE2e])[0]?.forwardedArgs).toContain(coreE2e);
      expect(
        createChangedNodeTestShards([...changedPaths, "src/deleted.ts"], { dedicatedUiE2e }),
      ).toBeNull();
    }
  });
  it("keeps plugin-owned package metadata on its package and concrete readers", () => {
    const cwd = argvTempDirs.make("changed-plugin-metadata-");
    const manifest = "extensions/msteams/package.json";
    const reader = "src/infra/plugin-package-reader.test.ts";
    const hostReader = "src/plugins/bundled-plugin-metadata.test.ts";
    const pluginTests = ["extensions/msteams/index.test.ts", "extensions/msteams/setup.test.ts"];
    for (const [file, source] of Object.entries({
      [manifest]: JSON.stringify({ name: "@openclaw/msteams" }),
      [reader]: 'import "../../extensions/msteams/package.json" with { type: "json" };',
      [hostReader]: "export {};",
      [pluginTests[0]!]: "export {};",
      [pluginTests[1]!]: "export {};",
      "extensions/discord/package.json": JSON.stringify({ name: "@openclaw/discord" }),
      "extensions/discord/index.test.ts": "export {};",
    })) {
      mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
      writeFileSync(path.join(cwd, file), source);
    }
    const dependencies = vi
      .spyOn(changedDependencies, "resolveChangedDependencies")
      .mockReturnValue({ importers: [], pluginMetadataPaths: [manifest] });
    try {
      const shards = createChangedNodeTestShards([manifest], { cwd });
      expect(shards).not.toBeNull();
      expect(selectedFiles(shards).toSorted()).toEqual([...pluginTests, reader].toSorted());
      expect(
        selectedFiles(createChangedNodeTestShards([manifest, hostReader], { cwd })).toSorted(),
      ).toEqual([...pluginTests, reader, hostReader].toSorted());
    } finally {
      dependencies.mockRestore();
    }
  });

  it.each([
    ["extensions/copilot/index.ts", ["extensions/copilot/index.test.ts"]],
    ["extensions/copilot/harness.ts", ["extensions/copilot/harness.test.ts"]],
    [
      "extensions/copilot/openclaw.plugin.json",
      ["extensions/copilot/index.test.ts", "extensions/copilot/harness.test.ts"],
    ],
  ] as const)("keeps host discovery proof when only %s changes", (changedPath, pluginTests) => {
    const hostTest = "src/agents/prepared-model-runtime.copilot.integration.test.ts";
    const shards = createChangedNodeTestShards([changedPath]);
    expect(shards).not.toBeNull();
    expect(selectedFiles(shards).filter((file) => file === hostTest)).toHaveLength(1);
    const groups = fallbackGroups(shards ?? []);
    for (const pluginTest of pluginTests) {
      const config = expectDefined(
        buildVitestRunPlans([pluginTest])[0]?.config,
        `plugin config for ${pluginTest}`,
      );
      expect(
        groups.some(
          (group) =>
            group.configs.includes(config) &&
            (!group.includePatterns || group.includePatterns.includes(pluginTest)),
        ),
        pluginTest,
      ).toBe(true);
    }
    expect(buildVitestRunPlans([hostTest])).toEqual([
      {
        config: "test/vitest/vitest.agents-core.config.ts",
        forwardedArgs: [],
        includePatterns: [hostTest],
        watchMode: false,
      },
    ]);
    expect(
      buildVitestRunPlans([
        "extensions/copilot/index.test.ts",
        "extensions/copilot/harness.test.ts",
      ]),
    ).toEqual([
      {
        config: "test/vitest/vitest.extension-database-workers.config.ts",
        forwardedArgs: [],
        includePatterns: ["extensions/copilot/harness.test.ts"],
        watchMode: false,
      },
      {
        config: "test/vitest/vitest.extensions.config.ts",
        forwardedArgs: [],
        includePatterns: ["extensions/copilot/index.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it.each([
    {
      source: "ui/src/styles/chat/layout.css",
      targets: [
        "ui/src/styles/base-theme-tokens.node.test.ts",
        "ui/src/styles/cursor-policy.node.test.ts",
      ],
    },
    {
      source: "ui/public/themes/tide.css",
      targets: [
        "ui/src/styles/base-theme-tokens.node.test.ts",
        "ui/src/styles/base-theme-contrast.node.test.ts",
      ],
    },
    {
      source: "extensions/anthropic/openclaw.plugin.json",
      targets: expect.arrayContaining(["src/agents/model-ref-shared.test.ts"]),
    },
    {
      source: "src/test-utils/symlink-rebind-race.ts",
      targets: expect.arrayContaining(["src/infra/fs-safe-import-boundary.test.ts"]),
    },
    {
      source: "src/channels/message-access/operator-authority.test-support.ts",
      targets: expect.arrayContaining(["src/channels/message-access/operator-authority.test.ts"]),
    },
  ])("retains affected owner tests for $source", ({ source, targets: expected }) => {
    if (source.endsWith(".test-support.ts")) {
      expect(hasBuildArtifactAffectingChange([source])).toBe(false);
    }
    const shards = createChangedNodeTestShards([source]);
    const targets = shards?.flatMap((shard) => shard.targets ?? []) ?? [];

    expect(targets).toEqual(expected);
  });

  it.each([
    {
      source: "test/scripts/openclaw-npm-plugin-recovery-workflow.test.ts",
      targets: [
        "test/scripts/openclaw-npm-plugin-recovery-workflow.test.ts",
        "test/scripts/test-projects.test.ts",
      ],
    },
    ...[
      "extensions/codex/src/app-server/run-attempt.native-config.test.ts",
      "extensions/codex/src/app-server/run-attempt.subscription.test.ts",
    ].map((source) => ({
      source,
      targets: expect.arrayContaining([source, "test/vitest-projects-config.test.ts"]),
    })),
  ])("selects inventory guards alongside $source", ({ source, targets: expected }) => {
    const shards = createChangedNodeTestShards([source]);
    expect(shards).not.toBeNull();
    const targets = fallbackGroups(shards ?? []).flatMap((group) => group.includePatterns ?? []);
    expect(targets.toSorted()).toEqual(expected);
  });

  it("routes cron alert sanitization changes through alert policy suites", () => {
    const shards = createChangedNodeTestShards(["src/cron/failure-notification-text.ts"]);
    const targets = selectedFiles(shards);

    expect(targets.toSorted()).toEqual(
      [
        "src/cron/service.stream-trigger.test.ts",
        "src/cron/service.stream-validation.test.ts",
        "src/cron/service/timer.timeout-watchdog.test.ts",
        gatewayCallsitesGuard,
        taskBoundaryTest,
      ].toSorted(),
    );
  });

  it("keeps a focused source job beside its canonical source scanner", () => {
    const shards = createChangedNodeTestShards(["src/agents/live-provider-owner.ts"]);
    const sourceTargets = [
      "src/agents/live-model-dynamic-candidates.test.ts",
      "src/agents/live-model-filter.test.ts",
      "src/agents/live-target-matcher.test.ts",
      "src/agents/model-compat.test.ts",
      taskBoundaryTest,
    ];
    expect(selectedFiles(shards).toSorted()).toEqual(
      [...sourceTargets, gatewayCallsitesGuard].toSorted(),
    );
    expect(shards).toContainEqual({
      checkName: "checks-node-changed",
      configs: [],
      requiresDist: false,
      runner: "blacksmith-8vcpu-ubuntu-2404",
      shardName: "changed",
      targets: sourceTargets,
    });
  });

  it.each([
    "src/node-host/node-worker-bundle-installer.test.ts",
    "src/plugin-sdk/config-runtime.test.ts",
    "src/plugins/contracts/registry.retry.test.ts",
    "src/channels/plugins/config-schema.test.ts",
    "src/tasks/task-registry.test.ts",
  ])("keeps exact test leaf %s focused while retaining boundary coverage", (target) => {
    expect(hasCoreExtensionImpact([target])).toBe(false);
    expect(createChangedExtensionFallbackShards([target])).toEqual([]);
    const dedicatedContractShards = [{ task: "contracts-channels", includePatterns: [target] }];
    expect(createChangedNodeTestShards([target], { dedicatedContractShards })).toEqual([
      {
        checkName: "checks-node-changed",
        configs: [],
        requiresDist: false,
        runner: "blacksmith-8vcpu-ubuntu-2404",
        shardName: "changed",
        targets: [target],
      },
      {
        checkName: "checks-node-changed-boundary",
        configs: ["test/vitest/vitest.boundary.config.ts"],
        requiresDist: false,
        runner: "blacksmith-8vcpu-ubuntu-2404",
        shardName: "changed-boundary",
      },
    ]);
  });

  it.each([
    ["src/plugins/contracts/registry.retry.test.ts", "contracts-plugins"],
    [
      "src/channels/plugins/contracts/session-binding.registry-backed.contract.test.ts",
      "contracts-channels",
    ],
  ])("leaves covered contract target %s to its dedicated matrix", (target, task) => {
    const before = createChangedNodeTestShards([target]);
    const dedicatedContractShards = [{ task, includePatterns: [target] }];
    expect(createChangedNodeTestShards([target], { dedicatedContractShards })).toEqual(
      before?.filter((shard) => !shard.targets),
    );
    // The same path is still a direct local target; CI coverage is opt-in.
    expect(buildVitestRunPlans([target]).flatMap((plan) => plan.includePatterns ?? [])).toEqual([
      target,
    ]);
    for (const coverage of [
      [],
      [{ task, includePatterns: [] }],
      [{ task, includePatterns: ["src/plugins/contracts/other.test.ts"] }],
      [{ task: "unrelated-task", includePatterns: [target] }],
    ]) {
      expect(createChangedNodeTestShards([target], { dedicatedContractShards: coverage })).toEqual(
        before,
      );
    }
  });

  it("keeps uncovered and deleted-path coverage beside a dedicated contract target", () => {
    const target = "src/plugins/contracts/registry.retry.test.ts";
    const remaining = [
      "src/plugin-sdk/config-runtime.test.ts",
      "src/channels/plugins/config-schema.test.ts",
      "src/plugins/contracts/deleted.test.ts",
    ];
    const options = {
      dedicatedContractShards: [{ task: "contracts-plugins", includePatterns: [target] }],
    };
    expect(createChangedNodeTestShards([target, ...remaining], options)).toEqual(
      createChangedNodeTestShards(remaining),
    );
    expect(createChangedNodeTestShards([target, "src/deleted.ts"], options)).toBeNull();
    expect(createChangedNodeTestShards([target, "tsconfig.json"], options)).toBeNull();
  });

  it("requires dedicated config ownership and retains independent source scanners", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "openclaw-contract-coverage-"));
    const target = "src/plugins/contracts/fixture.test.ts";
    const source = "src/fixture.ts";
    const unrelated = [
      "src/plugins/contracts/fixture.e2e.test.ts",
      "src/channels/plugins/contracts/unowned.test.ts",
    ];
    try {
      for (const file of [target, source, ...unrelated]) {
        mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
        writeFileSync(
          path.join(cwd, file),
          file === target ? 'import "../../fixture.js";\nexport {};\n' : "export {};\n",
        );
      }
      materializeSourcePolicyFixtures(cwd);
      for (const file of unrelated) {
        const before = createChangedNodeTestShards([file], { cwd });
        // General E2E and unknown channel patterns keep their exact owner;
        // the dedicated contract configs cannot claim those targets.
        expect(before?.flatMap((shard) => shard.targets ?? [])).toEqual([file]);
        expect(
          createChangedNodeTestShards([file], {
            cwd,
            dedicatedContractShards: [
              { task: "contracts-plugins", includePatterns: [file] },
              { task: "contracts-channels", includePatterns: [file] },
            ],
          }),
        ).toEqual(before);
      }
      const dedicatedContractShards = [{ task: "contracts-plugins", includePatterns: [target] }];
      expect(
        createChangedNodeTestShards([source], { cwd })?.flatMap((shard) => shard.targets ?? []),
      ).toEqual([target, gatewayCallsitesGuard, taskBoundaryTest]);
      expect(createChangedNodeTestShards([source], { cwd, dedicatedContractShards })).toEqual([
        expect.objectContaining({
          targets: [gatewayCallsitesGuard, taskBoundaryTest],
          requiresDist: false,
        }),
      ]);
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });

  it.each(
    [[], ["extensions/matrix/src/matrix/actions/verification.test.ts"]].map((companions) => ({
      companions,
    })),
  )(
    "credits max-lines baseline only with its dedicated guard beside $companions",
    ({ companions }) => {
      const paths = ["config/max-lines-baseline.txt", ...companions];
      for (const options of [{}, { dedicatedMaxLinesRatchet: false }]) {
        const uncredited = createChangedNodeTestShards(paths, options);
        expect(uncredited).not.toBeNull();
        const groups = fallbackGroups(uncredited ?? []);
        const targets = groups.flatMap((group) => group.includePatterns ?? []);
        expect(
          groups
            .filter((group) => group.configs.includes("test/vitest/vitest.tooling.config.ts"))
            .flatMap((group) => group.includePatterns ?? [])
            .toSorted(),
        ).toEqual([
          "test/scripts/check-max-lines-ratchet.test.ts",
          "test/scripts/ci-changed-node-test-plan.test.ts",
          "test/scripts/ci-workflow-planning.test.ts",
        ]);
        expect(targets).toEqual(expect.arrayContaining(companions));
      }
      const shards = createChangedNodeTestShards(paths, { dedicatedMaxLinesRatchet: true });
      expect(shards).not.toBeNull();
      const groups = fallbackGroups(shards ?? []);
      const targets = groups.flatMap((group) => group.includePatterns ?? []);
      const configs = groups.flatMap((group) => group.configs);
      expect(configs).not.toContain("test/vitest/vitest.tooling.config.ts");
      if (companions.length) {
        expect(shards).toEqual(createChangedNodeTestShards(companions));
        expect(targets).toContain("extensions/matrix/src/matrix/actions/verification.test.ts");
      } else {
        expect(groups.map((group) => group.configs)).toEqual([
          ["test/vitest/vitest.boundary.config.ts"],
        ]);
      }
    },
  );

  it.each([
    {
      owner: "scripts/check-max-lines-ratchet.mts",
      tests: ["test/scripts/check-max-lines-ratchet.test.ts"],
    },
    { owner: "scripts/lib/shrink-ratchet.mts", tests: ["test/scripts/shrink-ratchet.test.ts"] },
    {
      owner: ".github/workflows/ci.yml",
      tests: [
        "test/scripts/check-workflows.test.ts",
        "test/scripts/ci-workflow-guards.test.ts",
        "test/scripts/ci-workflow-planning.test.ts",
        "test/scripts/ci-workflow-evidence.test.ts",
        "test/scripts/ci-changed-node-test-plan.test.ts",
      ],
    },
  ])("retains owner coverage for max-lines baseline mixed with $owner", ({ owner, tests }) => {
    const shards = createChangedNodeTestShards(["config/max-lines-baseline.txt", owner], {
      dedicatedMaxLinesRatchet: true,
    });
    expect(shards).not.toBeNull();
    const groups = fallbackGroups(shards ?? []);
    const targets = groups.flatMap((group) => group.includePatterns ?? []);
    const configs = groups.flatMap((group) => group.configs);
    expect(targets).toEqual(expect.arrayContaining(tests));
    expect(configs).toContain("test/vitest/vitest.boundary.config.ts");
    expect(configs).not.toContain("test/vitest/vitest.tui-pty.config.ts");
    expect(shards?.some((shard) => shard.requiresDist)).toBe(false);
  });

  it("retains planner regression coverage beside a dedicated max-lines guard", () => {
    const shards = createChangedNodeTestShards(
      ["config/max-lines-baseline.txt", "scripts/lib/ci-changed-node-test-plan.mts"],
      { dedicatedMaxLinesRatchet: true },
    );
    expect(shards).not.toBeNull();
    expect(selectedFiles(shards)).toContain("test/scripts/ci-changed-node-test-plan.test.ts");
  });

  it("does not credit other config data or a missing max-lines baseline", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "openclaw-ratchet-routing-"));
    try {
      mkdirSync(path.join(cwd, "config"));
      const baseline = "config/max-lines-baseline.txt";
      const unknown = "config/max-lines-baseline-other.txt";
      writeFileSync(path.join(cwd, baseline), "");
      writeFileSync(path.join(cwd, unknown), "");
      const options = { cwd, dedicatedMaxLinesRatchet: true };
      expect(createChangedNodeTestShards([baseline, unknown], options)).toBeNull();
      rmSync(path.join(cwd, baseline));
      expect(createChangedNodeTestShards([baseline], options)).toBeNull();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.each(
    (["blacksmith", "hybrid", "github"] as const).flatMap((runnerBackend) =>
      boundaryTestFiles.map((target) => ({ runnerBackend, target })),
    ),
  )(
    "runs $target once through the local boundary owner on $runnerBackend",
    ({ runnerBackend, target }) => {
      expect(createChangedNodeTestShards([target], { runnerBackend })).toEqual([
        {
          checkName: "checks-node-changed-boundary",
          configs: ["test/vitest/vitest.boundary.config.ts"],
          requiresDist: false,
          runner: "blacksmith-8vcpu-ubuntu-2404",
          shardName: "changed-boundary",
        },
      ]);
      // Local explicit selection still runs only the requested file.
      expect(buildVitestRunPlans([target])).toMatchObject([
        {
          config: "test/vitest/vitest.boundary.config.ts",
          includePatterns: [target],
          forwardedArgs: [],
          watchMode: false,
        },
      ]);
    },
  );

  it.each([
    "src/tasks/task-registry.test.ts",
    "src/agents/embedded-agent-runner/run/attempt-yield-handoff.test.ts",
    "test/scripts/ci-linux-git.test.ts",
  ])("retains the other test owner alongside a boundary target: %s", (companion) => {
    expect(
      createChangedNodeTestShards(["test/extension-import-boundaries.test.ts", companion]),
    ).toEqual(createChangedNodeTestShards([companion]));
  });

  it("leaves explicit boundary coverage with the selected artifact owner", () => {
    const companion = "src/agents/live-provider-owner.ts";
    const target = "test/extension-import-boundaries.test.ts";
    const shards = createChangedNodeTestShards([target, companion]);
    expect(shards).not.toBeNull();
    expect(hasBuildArtifactAffectingChange([companion])).toBe(true);
    expect(shards).toEqual(createChangedNodeTestShards([companion]));
    expect(selectedFiles(shards)).not.toContain(target);
    expect(shards?.map((shard) => shard.checkName)).not.toContain("checks-node-changed-boundary");
  });

  it.each(["docs/help/index.md", "src/infra/deleted-boundary.test.ts"])(
    "retains the local boundary owner with an ignored companion: %s",
    (companion) => {
      const target = "test/extension-import-boundaries.test.ts";
      expect(createChangedNodeTestShards([target, companion])).toEqual(
        createChangedNodeTestShards([target]),
      );
    },
  );

  it.each(["src/infra/deleted-boundary.ts", "tsconfig.json"])(
    "validates an unresolved companion before crediting boundary coverage: %s",
    (companion) => {
      expect(
        createChangedNodeTestShards(["test/extension-import-boundaries.test.ts", companion]),
      ).toBeNull();
    },
  );

  it("retains the complete boundary owner when its leaf config changes", () => {
    const shards = createChangedNodeTestShards([
      "test/extension-import-boundaries.test.ts",
      "test/vitest/vitest.boundary.config.ts",
    ]);
    expect(shards).not.toBeNull();
    expect(fallbackGroups(shards ?? [])).toContainEqual(
      expect.objectContaining({
        configs: ["test/vitest/vitest.boundary.config.ts"],
      }),
    );
    expect(
      fallbackGroups(shards ?? []).find((group) =>
        group.configs.includes("test/vitest/vitest.boundary.config.ts"),
      )?.includePatterns,
    ).toBeUndefined();
  });

  it("classifies build-artifact and QA smoke impact by changed surface", () => {
    expect(hasBuildArtifactAffectingChange(["src/agents/foo.test.ts", "test/helpers/x.ts"])).toBe(
      false,
    );
    expect(
      hasBuildArtifactAffectingChange([
        "src/gateway/server.auth.control-ui.trusted-proxy.suite.ts",
      ]),
    ).toBe(false);
    expect(hasBuildArtifactAffectingChange(["src/agents/foo.ts"])).toBe(true);
    // Build-input classification: only sources and the build pipeline can
    // change dist bytes; repo scripts, workflows, and qa scenarios cannot.
    expect(hasBuildArtifactAffectingChange(["scripts/build-all.mts"])).toBe(true);
    for (const changedPath of [
      "tsdown.config.ts",
      "tsdown.ai.config.ts",
      "scripts/tsdown-build.mts",
      "scripts/write-plugin-sdk-entry-dts.ts",
      "scripts/write-unified-entry-dts.ts",
      "scripts/lib/build-artifact-cache.mts",
      "scripts/lib/compiler-input-snapshot.mts",
      "scripts/lib/declaration-stage.mts",
      "scripts/lib/tsdown-declaration-inputs.mts",
      "scripts/lib/tsdown-declaration-writer.mts",
      "scripts/lib/tsdown-config-groups.mts",
      "scripts/lib/tsdown-output-roots.mts",
    ]) {
      expect(hasBuildArtifactAffectingChange([changedPath]), changedPath).toBe(true);
    }
    expect(hasBuildArtifactAffectingChange(["tsconfig.json"])).toBe(true);
    expect(hasBuildArtifactAffectingChange(["scripts/run-vitest.mjs"])).toBe(false);
    expect(hasBuildArtifactAffectingChange([".github/workflows/ci.yml"])).toBe(false);
    expect(hasBuildArtifactAffectingChange(["qa/scenarios/index.yaml"])).toBe(false);
    expect(hasBuildArtifactAffectingChange(["ui/src/app.ts"])).toBe(false);
    expect(hasQaSmokeAffectingChange(["extensions/qa-lab/src/ci-smoke-plan.ts"])).toBe(true);
    expect(hasQaSmokeAffectingChange(["qa/scenarios/index.yaml"])).toBe(true);
    // Smoke drives matrix + telegram; other channel plugins are invisible to it.
    expect(hasQaSmokeAffectingChange(["extensions/telegram/src/index.ts"])).toBe(true);
    expect(hasQaSmokeAffectingChange(["extensions/discord/src/index.ts"])).toBe(false);
    // Broad runtime changes wait for release validation; only QA owners
    // select smoke on automatic PR and main runs.
    expect(hasQaSmokeAffectingChange(["ui/src/app.ts"])).toBe(false);
    expect(hasQaSmokeAffectingChange(["src/infra/retry.ts"])).toBe(false);
    expect(hasQaSmokeAffectingChange(["packages/llm-core/src/index.ts"])).toBe(false);
    expect(hasQaSmokeAffectingChange(["pnpm-lock.yaml"])).toBe(false);
    expect(hasQaSmokeAffectingChange(["scripts/run-vitest.mjs"])).toBe(false);
    expect(hasQaSmokeAffectingChange(["test/scripts/ci-node-test-plan.test.ts"])).toBe(false);
    // The QA lane's own orchestration must not be able to skip the lane.
    expect(hasQaSmokeAffectingChange([".github/workflows/ci.yml"])).toBe(true);
    expect(hasQaSmokeAffectingChange([".github/actions/setup-node-env/action.yml"])).toBe(true);
    expect(hasQaSmokeAffectingChange(["scripts/lib/ci-changed-node-test-plan.mts"])).toBe(true);
    expect(hasQaSmokeAffectingChange([".github/workflows/labeler.yml"])).toBe(false);
  });

  it.each([
    ["ui/src/main.ts", true],
    ["ui/vite.config.ts", true],
    ["ui/src/pages/chat/chat-gateway.test.ts", false],
    ["packages/gateway-client/src/index.ts", true],
    ["pnpm-lock.yaml", true],
    ["patches/@awesome.me__webawesome@3.13.0.patch", true],
    [".npmrc", true],
    ["scripts/check-control-ui-performance-base.mts", true],
    ["scripts/lib/control-ui-i18n-config.ts", true],
    ["src/gateway/control-ui-asset-manifest.ts", true],
    ["src/infra/retry.ts", true],
    ["src/commands/doctor.ts", true],
    ["src/cli/cron-cli/shared.ts", false],
    ["extensions/telegram/src/index.ts", false],
    ["docs/ci.md", false],
  ] as const)("selects UI performance for %s: %s", (file, expected) => {
    expect(hasControlUiPerformanceAffectingChange([file])).toBe(expected);
  });

  it.each([
    "extensions/browser/src/browser/extension-install.native-host.e2e.test.ts",
    "extensions/browser/src/browser/extension-install.test-support.ts",
    "extensions/browser/chrome-extension/relay-key.test-support.ts",
  ])("keeps the built native-host proof selected when only %s changes", (changedPath) => {
    expect(hasBuildArtifactAffectingChange([changedPath])).toBe(true);
  });

  it("classifies prompt-snapshot impact by surface and generator import graph", () => {
    // Inside the generator's import graph -> regenerated output can change.
    expect(hasPromptSnapshotAffectingChange(["src/auto-reply/reply/prompt-prelude.ts"])).toBe(true);
    // The codex extension loads through a dynamic bundled-plugin module id the
    // graph walk cannot see; it stays on the always-run surface.
    expect(hasPromptSnapshotAffectingChange(["extensions/codex/src/index.ts"])).toBe(true);
    expect(
      hasPromptSnapshotAffectingChange([
        "test/fixtures/agents/prompt-snapshots/codex-runtime-happy-path/README.md",
      ]),
    ).toBe(true);
    expect(hasPromptSnapshotAffectingChange(["scripts/generate-prompt-snapshots.ts"])).toBe(true);
    // Workspace packages feed the generator through package-specifier imports
    // the relative graph walk cannot see.
    expect(hasPromptSnapshotAffectingChange(["packages/llm-core/src/index.ts"])).toBe(true);
    // The gate's own orchestration must not be able to skip the gated lane.
    expect(hasPromptSnapshotAffectingChange([".github/workflows/ci.yml"])).toBe(true);
    expect(hasPromptSnapshotAffectingChange(["scripts/lib/ci-changed-node-test-plan.mts"])).toBe(
      true,
    );
    // Outside the surface and the generator graph -> the lane may skip.
    expect(hasPromptSnapshotAffectingChange(["ui/src/app.ts"])).toBe(false);
    expect(hasPromptSnapshotAffectingChange(["extensions/discord/src/index.ts"])).toBe(false);
    expect(hasPromptSnapshotAffectingChange(["docs/index.md"])).toBe(false);
    expect(hasPromptSnapshotAffectingChange(["test/scripts/ci-node-test-plan.test.ts"])).toBe(
      false,
    );
    // Deleted source files cannot be graphed; fail safe to running the check.
    expect(hasPromptSnapshotAffectingChange(["src/infra/definitely-deleted-module.ts"])).toBe(true);
  });

  it("classifies SQLite session lifecycle impact by owner and import graph", () => {
    expect(
      hasSqliteSessionLifecycleAffectingChange([
        "src/agents/embedded-agent-runner/run/attempt-session-runtime-prepare.ts",
      ]),
    ).toBe(true);
    expect(
      hasSqliteSessionLifecycleAffectingChange(["src/gateway/server-methods/sessions.ts"]),
    ).toBe(true);
    expect(
      hasSqliteSessionLifecycleAffectingChange(["src/sessions/session-lifecycle-admission.ts"]),
    ).toBe(true);
    expect(hasSqliteSessionLifecycleAffectingChange(["src/config/sessions.ts"])).toBe(true);
    expect(
      hasSqliteSessionLifecycleAffectingChange([
        "test/scripts/sqlite-sessions-transcripts-flip-proof.built-cli.e2e.test.ts",
      ]),
    ).toBe(true);
    expect(
      hasSqliteSessionLifecycleAffectingChange([
        "packages/media-understanding-common/src/provider-id.ts",
      ]),
    ).toBe(false);
    expect(hasSqliteSessionLifecycleAffectingChange(["src/agents/model-auth.ts"])).toBe(false);
    expect(hasSqliteSessionLifecycleAffectingChange(["extensions/discord/src/index.ts"])).toBe(
      false,
    );
    expect(
      hasSqliteSessionLifecycleAffectingChange([
        "src/config/sessions/session-registry-maintenance.test.ts",
      ]),
    ).toBe(false);
    expect(
      hasSqliteSessionLifecycleAffectingChange(["src/infra/definitely-deleted-module.ts"]),
    ).toBe(false);
    expect(
      hasSqliteSessionLifecycleAffectingChange([
        "src/agents/embedded-agent-runner/run/deleted-session-runtime.ts",
      ]),
    ).toBe(true);
  });

  describe("release fast lane", () => {
    it("admits release tooling and independently checked documentation", () => {
      expect(
        resolveReleaseFastLaneScope([
          ".github/workflows/openclaw-release-publish.yml",
          "scripts/lib/release-publish-children.sh",
          "test/scripts/release-publish-children.test.ts",
          "docs/reference/RELEASING.md",
          ".agents/skills/release-openclaw-ci/SKILL.md",
          "docs/ci.md",
        ]),
      ).toEqual({ eligible: true });
    });

    it.each(["src/foo.ts", "config/knip.config.ts"])("declines out-of-scope %s", (file) => {
      expect(resolveReleaseFastLaneScope([file])).toEqual({
        eligible: false,
        reason: `outside the release tooling scope: ${file}`,
      });
    });

    it("declines global execution inputs before ordinary scope mismatches", () => {
      expect(
        resolveReleaseFastLaneScope([
          "src/foo.ts",
          "scripts/run-vitest.mts",
          "scripts/run-vitest.mjs",
        ]),
      ).toEqual({
        eligible: false,
        reason: "global execution or resolution input: scripts/run-vitest.mts",
      });
    });

    it.each([null, []])("declines missing changed paths: %j", (changedPaths) => {
      expect(resolveReleaseFastLaneScope(changedPaths)).toEqual({
        eligible: false,
        reason: "missing changed paths",
      });
    });

    it("accepts deleted tooling paths and uses the existing documentation classifier", () => {
      const cwd = argvTempDirs.make("release-fast-lane-scope-");
      mkdirSync(path.join(cwd, "docs"));
      writeFileSync(path.join(cwd, "docs/page.md"), "fixture");
      symlinkSync("page.md", path.join(cwd, "docs/linked.md"));
      expect(
        resolveReleaseFastLaneScope(["scripts/deleted.mts", "docs/page.md", "docs/deleted.md"], {
          cwd,
        }),
      ).toEqual({ eligible: true });
      expect(resolveReleaseFastLaneScope(["docs/linked.md"], { cwd })).toEqual({
        eligible: false,
        reason: "outside the release tooling scope: docs/linked.md",
      });
    });

    it("relaxes only the compact packing policy fallback", () => {
      const onFallback = vi.fn();
      createChangedNodeTestShards(
        ["scripts/lib/ci-node-test-plan.mts", "test/scripts/ci-node-test-plan.test.ts"],
        { runnerBackend: "blacksmith", releaseFastLane: true, onFallback },
      );
      expect(onFallback).not.toHaveBeenCalledWith(
        "compact packing policy requires full-plan proof",
      );
      expect(
        createChangedNodeTestShards(["scripts/run-vitest.mts"], {
          releaseFastLane: true,
          onFallback,
        }),
      ).toBeNull();
      expect(onFallback).toHaveBeenLastCalledWith(
        "global execution or resolution input: scripts/run-vitest.mts",
      );
    });
  });

  it.each([
    ["package.json", "blacksmith", true],
    ["test/scripts/ci-node-test-plan.test.ts", "blacksmith", true],
    ["test/scripts/ci-node-test-plan.test.ts", "hybrid", true],
    ["test/scripts/ci-node-test-plan.test.ts", "github", false],
  ] as const)("resolves full-plan coverage for %s on %s", (changedPath, runnerBackend, full) => {
    const shards = createChangedNodeTestShards([changedPath], { runnerBackend });
    if (full) {
      expect(shards).toBeNull();
    } else {
      expect(shards).not.toBeNull();
      expect(
        fallbackGroups(shards ?? []).flatMap((group) => group.includePatterns ?? []),
      ).toContain(changedPath);
    }
  });

  it.each([
    ...["blacksmith", "hybrid", "runson", "github"].map((runnerBackend) => ({
      changedPath: "scripts/lib/ci-measured-compact-packing.mts",
      runnerBackend,
    })),
    ...["scripts/lib/ci-test-timings.mts", "scripts/lib/vitest-shard-metadata.mts"].flatMap(
      (changedPath) =>
        ["blacksmith", "hybrid", "runson"].map((runnerBackend) => ({ changedPath, runnerBackend })),
    ),
  ])(
    "keeps $changedPath under the $runnerBackend full-plan policy",
    ({ changedPath, runnerBackend }) => {
      const shards = createChangedNodeTestShards([changedPath], { runnerBackend });
      if (runnerBackend === "github") {
        expect(shards).not.toBeNull();
        expect(
          fallbackGroups(shards ?? []).flatMap((group) => group.includePatterns ?? []),
        ).toContain("test/scripts/ci-node-test-plan.test.ts");
      } else {
        expect(shards).toBeNull();
      }
    },
  );

  it("fails safe for raw Git paths that resemble normalized script paths", () => {
    for (const changedPath of [
      " scripts/changed-lanes.mts",
      String.raw`scripts\changed-lanes.mts`,
    ]) {
      expect(createChangedNodeTestShards([changedPath]), changedPath).toBeNull();
    }
  });

  it("keeps minimal-gateway boot coverage reachable from gateway startup changes", () => {
    // A gateway startup stall must fail in the gateway lane; the boot smoke is
    // selected purely through the import graph, so a rename or an import shape
    // the graph walker cannot see would silently drop it from targeted plans
    // and the stall would first surface on unrelated ui-e2e PRs again.
    const bootSmoke = "src/gateway/server-startup-minimal-boot.test.ts";
    expect(isGatewayServerTestFile(bootSmoke)).toBe(true);
    expect(
      hasImportGraphImpactOnTargets(
        ["src/gateway/server-startup-bootstrap.ts"],
        [bootSmoke],
        process.cwd(),
      ),
    ).toBe(true);
  });

  describe("documentation targeting", () => {
    it("keeps the complete two-job corpus plan beside a documentation page", () => {
      const targets = startupCorpusTestFiles;
      const before = createChangedNodeTestShards(targets);
      expect(before).toHaveLength(2);
      expect(before?.flatMap((shard) => shard.targets ?? [])).toEqual(targets);
      expect(before?.some((shard) => shard.pretestBuildMode === "runtime")).toBe(true);
      expect(createChangedNodeTestShards([...targets, "docs/ci/pipeline.md"])).toEqual(before);
    });

    it.each([
      [["docs/guide.md"], "file", true],
      [["docs/guide.mdx"], "file", true],
      [["README.md"], "file", true],
      [["scripts/README.md"], "file", true],
      [["AGENTS.md"], "file", true],
      [["src/agents/AGENTS.md"], "file", true],
      [["src/agents/AGENTS.md"], "missing", true],
      [[".agents/skills/example/SKILL.md"], "file", true],
      [["skills/example/SKILL.md"], "file", true],
      [["docs/deleted.md"], "missing", true],
      [["docs/old.md", "docs/new.md"], "rename", true],
      [["docs/.i18n/zh-CN.tm.jsonl"], "file", true],
      [["ui/src/i18n/locales/de.ts"], "file", true],
      [["ui/src/i18n/.i18n/de.json"], "file", true],
      [["apps/.i18n/native/de.json"], "file", true],
      [["docs/reference/templates/AGENTS.md"], "file", false],
      [["docs/reference/templates/AGENTS.md"], "missing", false],
      [["src/runtime.md"], "file", false],
      [["test/fixtures/payload.md"], "file", false],
      [["test/fixtures/AGENTS.md"], "file", false],
      [["docs/script.ts"], "file", true],
      [["src/deleted.ts", "docs/new.md"], "rename", false],
      [["docs/reference/templates/old.md", "docs/new.md"], "rename", false],
      [["docs/old.md", "docs/reference/templates/new.md"], "rename", false],
      [["docs/guide.md"], "directory", false],
      [["docs/guide.md"], "symlink", false],
      [["docs/guide.md"], "dangling", false],
      [["docs/../guide.md"], "file", false],
    ] as const)("preserves Node ownership for %j (%s): %s", (paths, kind, precise) => {
      const cwd = mkdtempSync(path.join(tmpdir(), "openclaw-docs-targeting-"));
      const target = "src/channels/plugins/unowned.test.ts";
      try {
        mkdirSync(path.dirname(path.join(cwd, target)), { recursive: true });
        writeFileSync(path.join(cwd, target), "export {};\n");
        for (const file of kind === "missing" ? [] : kind === "rename" ? paths.slice(1) : paths) {
          const absolute = path.join(cwd, file);
          mkdirSync(path.dirname(absolute), { recursive: true });
          if (kind === "directory") {
            mkdirSync(absolute);
          } else if (kind === "symlink" || kind === "dangling") {
            if (kind === "symlink") {
              writeFileSync(path.join(path.dirname(absolute), "target.md"), "# Guide\n");
            }
            symlinkSync("target.md", absolute);
          } else {
            writeFileSync(absolute, "# Guide\n");
          }
        }
        const before = createChangedNodeTestShards([target], { cwd });
        expect(before?.flatMap((shard) => shard.targets ?? [])).toEqual([target]);
        expect(createChangedNodeTestShards([target, ...paths], { cwd })).toEqual(
          precise ? before : null,
        );
        if (precise) {
          expect(createChangedNodeTestShards([...paths], { cwd })).toEqual([]);
        }
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    it("retains the mapped prompt Markdown owner beside documentation", () => {
      const fixture =
        "test/fixtures/agents/prompt-snapshots/codex-runtime-happy-path/telegram-direct-codex-message-tool.md";
      const before = createChangedNodeTestShards([fixture]);
      expect(before).not.toBeNull();
      const ownedTargets = before?.flatMap((shard) => [
        ...(shard.targets ?? []),
        ...(shard.includePatterns ?? []),
        ...(shard.groups?.flatMap((group) => group.includePatterns ?? []) ?? []),
      ]);
      expect(ownedTargets).toContain("test/scripts/prompt-snapshots.test.ts");
      expect(createChangedNodeTestShards([fixture, "docs/ci/pipeline.md"])).toEqual(before);
    });
  });

  it("selects helper importers transitively through tests without selecting unrelated tests", () => {
    const cwd = argvTempDirs.make("changed-helper-consumers-");
    const helper = "test/helpers/local-fixture.ts";
    const direct = "src/example/direct-consumer.test.ts";
    const indirect = "src/example/indirect-consumer.test.ts";
    const e2e = "extensions/example/proof.e2e.test.ts";
    for (const [file, source] of [
      [helper, "export const fixture = 1;\n"],
      [direct, 'import "../../test/helpers/local-fixture.js";\n'],
      [indirect, 'import "./direct-consumer.test.js";\n'],
      [e2e, 'import "../../test/helpers/local-fixture.js";\n'],
      ["src/example/unrelated.test.ts", "export {};\n"],
    ] as const) {
      mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
      writeFileSync(path.join(cwd, file), source);
    }
    for (const changedPath of [helper, direct]) {
      const shards = createChangedNodeTestShards([changedPath], { cwd });
      expect(shards).not.toBeNull();
      expect(selectedFiles(shards).toSorted()).toEqual([direct, indirect]);
    }
    const explicit = createChangedNodeTestShards([helper, e2e], { cwd });
    expect(explicit).not.toBeNull();
    expect(selectedFiles(explicit).toSorted()).toEqual([e2e, direct, indirect].toSorted());
  });

  it("keeps task boundary scanning beside ordinary importers without claiming unowned sources", () => {
    const source = "src/example/runtime.ts";
    const consumer = "src/example/runtime.test.ts";
    const unowned = "src/example/unowned.ts";
    const createFixture = () => {
      const cwd = argvTempDirs.make("changed-task-scanner-");
      for (const [file, content] of [
        [source, "export const value = 1;\n"],
        [consumer, 'import "./runtime.js";\n'],
        [unowned, "export {};\n"],
      ] as const) {
        mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
        writeFileSync(path.join(cwd, file), content);
      }
      return cwd;
    };
    const cwd = createFixture();
    materializeSourcePolicyFixtures(cwd);
    const shards = createChangedNodeTestShards([source], { cwd });
    expect(shards).not.toBeNull();
    expect(selectedFiles(shards).toSorted()).toEqual(
      [consumer, gatewayCallsitesGuard, taskBoundaryTest].toSorted(),
    );
    expect(createChangedNodeTestShards([unowned], { cwd })).toBeNull();
    expect(createChangedNodeTestShards([source, unowned], { cwd })).toBeNull();
    expect(createChangedNodeTestShards([source], { cwd: createFixture() })).toBeNull();

    for (const [file, selected] of [
      ["src/tasks/task-flow-restore-store.ts", true],
      ["src/gateway/new-task-access.ts", true],
      ["src/test-utils/task-registry-store.ts", true],
      ["src/example/runtime.test-support.ts", true],
      ["src/example/runtime.test-helpers.ts", true],
      ["src/example/runtime.d.ts", true],
      ["src/example/runtime.test.ts", false],
      ["src/example/runtime.test-harness.ts", false],
      ["src/example/runtime.test-utils.ts", false],
      ["src/example/runtime.e2e-harness.ts", false],
      ["src/example/runtime.tsx", false],
      ["src/example/runtime.mts", false],
      ["extensions/example/runtime.ts", false],
      ["test/helpers/runtime.ts", false],
    ] as const) {
      expect(resolvePolicyTestTargets([file]).includes(taskBoundaryTest), file).toBe(selected);
    }
  });

  it("admits exact-base erased core sources while retaining concrete test owners", () => {
    const fixture = createErasedCoreSourceFixture();
    const reasons: string[] = [];
    const options = {
      ...fixture,
      dedicatedCoreTypeChecks: true,
      onFallback: (reason: string) => reasons.push(reason),
    };
    for (const source of ["src/example/entry.ts", "src/example/new-entry.ts"]) {
      const shards = createChangedNodeTestShards([source], options);
      expect(shards, source).not.toBeNull();
      expect(selectedFiles(shards), source).toEqual([gatewayCallsitesGuard, taskBoundaryTest]);
    }
    const shards = createChangedNodeTestShards(
      [
        "src/example/entry.ts",
        "src/example/entry-sibling.ts",
        "src/example/entry-imported.ts",
        "src/example/entry-read.ts",
        "src/example/runtime.ts",
      ],
      options,
    );
    expect(shards, reasons.join("\n")).not.toBeNull();
    expect(selectedFiles(shards).toSorted()).toEqual(
      [
        "src/example/entry-sibling.test.ts",
        "src/example/import-consumer.test.ts",
        "src/example/runtime-consumer.test.ts",
        "src/example/source-reader.test.ts",
        gatewayCallsitesGuard,
        taskBoundaryTest,
      ].toSorted(),
    );
  });

  it("refuses erased-source admission without exact history and full type owners", () => {
    const fixture = createErasedCoreSourceFixture();
    const options = { ...fixture, dedicatedCoreTypeChecks: true };
    for (const [label, paths, overrides] of [
      ["missing gate", ["src/example/entry.ts"], { dedicatedCoreTypeChecks: undefined }],
      ["disabled gate", ["src/example/entry.ts"], { dedicatedCoreTypeChecks: false }],
      ["missing base", ["src/example/entry.ts"], { baseRef: undefined }],
      ["moving base", ["src/example/entry.ts"], { baseRef: "HEAD" }],
      ["missing history", ["src/example/entry.ts"], { baseRef: "a".repeat(40) }],
      ["runtime before", ["src/example/runtime-before.ts"], {}],
      ["retained import", ["src/example/import-retained.ts"], {}],
      ["ambient declarations", ["src/example/ambient.ts"], {}],
      ["parse uncertainty", ["src/example/incomplete.ts"], {}],
      ["untracked source", ["src/example/untracked.ts"], {}],
      ["declaration file", ["src/example/entry.d.ts"], {}],
      ["deleted source", ["src/example/retired.ts"], {}],
      ["unknown companion", ["src/example/entry.ts", "src/example/unknown.ts"], {}],
    ] as const) {
      expect(
        createChangedNodeTestShards([...paths], { ...options, ...overrides }),
        label,
      ).toBeNull();
    }
  });

  it("keeps actionlint external without dropping source or config consumers", () => {
    for (const withConfigConsumer of [false, true]) {
      const cwd = argvTempDirs.make("changed-actionlint-consumers-");
      const files = {
        ".github/actionlint.yaml": "self-hosted-runner: {}\n",
        "src/example/runtime.ts": "export const value = 1;\n",
        "src/example/runtime-consumer.test.ts": 'import "./runtime.js";\n',
        "src/example/unknown.ts": "export const value = 1;\n",
        ...(withConfigConsumer
          ? {
              "scripts/actionlint-reader.mts":
                'export const config = new URL("../.github/actionlint.yaml", import.meta.url);\n',
              "src/example/actionlint-reader.test.ts":
                'import "../../scripts/actionlint-reader.mts";\n',
            }
          : {}),
      };
      for (const [file, source] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
        writeFileSync(path.join(cwd, file), source);
      }
      materializeSourcePolicyFixtures(cwd);
      const reasons: string[] = [];
      const shards = createChangedNodeTestShards(
        [".github/actionlint.yaml", "src/example/runtime.ts"],
        { cwd, onFallback: (reason) => reasons.push(reason) },
      );
      expect(shards, reasons.join("\n")).not.toBeNull();
      expect(selectedFiles(shards).toSorted()).toEqual(
        [
          "src/example/runtime-consumer.test.ts",
          gatewayCallsitesGuard,
          taskBoundaryTest,
          ...(withConfigConsumer ? ["src/example/actionlint-reader.test.ts"] : []),
        ].toSorted(),
      );
      expect(
        createChangedNodeTestShards([".github/actionlint.yaml", "src/example/unknown.ts"], { cwd }),
      ).toBeNull();
    }
  });

  it("keeps mixed native changes precise only with their checks or concrete source readers", () => {
    const swift = "apps/shared/OpenClawKit/Sources/OpenClawKit/Example.swift";
    const android = "apps/android/app/src/main/java/Example.kt";
    const runtime = "src/example/runtime.ts";
    const runtimeConsumer = "src/example/runtime-consumer.test.ts";
    const sourceReader = "src/example/native-source-reader.test.ts";
    for (const withSourceReader of [false, true]) {
      const cwd = argvTempDirs.make("changed-native-consumers-");
      const files = {
        [swift]: "struct Example {}\n",
        [android]: "class Example\n",
        [runtime]: "export const value = 1;\n",
        [runtimeConsumer]: 'import "./runtime.js";\n',
        "apps/unknown/Example.swift": "struct Example {}\n",
        ...(withSourceReader
          ? {
              [sourceReader]: `import { readFileSync } from "node:fs";\nreadFileSync(new URL("../../${swift}", import.meta.url), "utf8");\n`,
            }
          : {}),
      };
      for (const [file, source] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
        writeFileSync(path.join(cwd, file), source);
      }
      materializeSourcePolicyFixtures(cwd);
      const dedicatedNativeChecks = { macos: true, ios: true, android: true };
      const reasons: string[] = [];
      const options = {
        cwd,
        dedicatedNativeChecks,
        onFallback: (reason: string) => reasons.push(reason),
      };
      const expected = [
        runtimeConsumer,
        gatewayCallsitesGuard,
        taskBoundaryTest,
        ...(withSourceReader ? [sourceReader] : []),
      ].toSorted();
      const shards = createChangedNodeTestShards([swift, android, runtime], options);
      expect(shards, reasons.join("\n")).not.toBeNull();
      expect(selectedFiles(shards).toSorted()).toEqual(expected);
      expect(createChangedNodeTestShards([swift, android, runtime], { cwd })).toBeNull();
      expect(
        createChangedNodeTestShards(
          [swift, android, runtime, "apps/unknown/Example.swift"],
          options,
        ),
      ).toBeNull();
      if (withSourceReader) {
        const readerOwned = createChangedNodeTestShards([swift, runtime], { cwd });
        expect(readerOwned).not.toBeNull();
        expect(selectedFiles(readerOwned).toSorted()).toEqual(expected);
      } else {
        for (const missing of ["macos", "ios", "android"] as const) {
          expect(
            createChangedNodeTestShards([swift, android, runtime], {
              cwd,
              dedicatedNativeChecks: { ...dedicatedNativeChecks, [missing]: false },
            }),
            missing,
          ).toBeNull();
        }
      }
    }
  });

  it("routes the native source inventory to both readers in a mixed Android PR", () => {
    const changedPaths = [
      "apps/.i18n/native-source.json",
      "apps/android/README.md",
      "apps/android/app/src/main/java/ai/openclaw/app/MainViewModel.kt",
      "apps/android/app/src/main/java/ai/openclaw/app/NodeRuntime.kt",
      "apps/android/app/src/main/java/ai/openclaw/app/ui/chat/ChatRealtimeTalk.kt",
      "apps/android/app/src/main/java/ai/openclaw/app/ui/chat/ChatScreen.kt",
      "apps/android/app/src/main/java/ai/openclaw/app/voice/TalkModeManager.kt",
      "apps/android/app/src/test/java/ai/openclaw/app/ui/chat/ChatComposerLayoutTest.kt",
      "apps/android/app/src/test/java/ai/openclaw/app/voice/TalkModeManagerTest.kt",
    ];
    const onFallback = vi.fn();
    const dedicatedNativeChecks = { macos: false, ios: false, android: true };
    const shards = createChangedNodeTestShards(changedPaths, {
      dedicatedNativeChecks,
      includeReleaseOnlyToolingShards: false,
      onFallback,
    });
    expect(onFallback).not.toHaveBeenCalled();
    expect(shards).not.toBeNull();
    const files = selectedFiles(shards);
    expect(files.filter((file) => file === "test/scripts/android-app-i18n.test.ts")).toHaveLength(
      1,
    );
    expect(files.filter((file) => file === "test/scripts/apple-app-i18n.test.ts")).toHaveLength(1);
    expect(files).toHaveLength(2);
    expect(
      createChangedNodeTestShards([...changedPaths, "apps/.i18n/unowned.json"], {
        dedicatedNativeChecks,
      }),
    ).toBeNull();
    expect(
      createChangedNodeTestShards(changedPaths, {
        dedicatedNativeChecks: { ...dedicatedNativeChecks, android: false },
      }),
    ).toBeNull();
  });

  it.each([
    {
      changedPath: "src/auto-reply/reply/abort.test.ts",
      expected: ["test/scripts/tsgo-core-test-shards.test.ts"],
    },
    {
      changedPath: "src/plugins/plugin-instance.ts",
      expected: [
        "test/scripts/eager-import-closure.test.ts",
        "test/scripts/pr-worktree-provision.test.ts",
      ],
    },
    {
      changedPath: "scripts/e2e/lib/upgrade-survivor/run.sh",
      expected: [
        "test/scripts/package-acceptance-workflow.test.ts",
        "test/scripts/upgrade-survivor-missing-load-path.test.ts",
      ],
    },
  ])(
    "retains explicit policy guards for $changedPath in automatic CI",
    ({ changedPath, expected }) => {
      const importer = "src/agents/live-model-filter.test.ts";
      const deferred = "src/state/openclaw-database-preflight.lifecycle.test.ts";
      const consumers = [importer, deferred];
      // Bound graph discovery while retaining the real watch inventory and execution owners.
      vi.spyOn(testProjects, "resolveAffectedTestsFromImportGraph").mockImplementation((paths) =>
        paths.length ? consumers : [],
      );
      vi.spyOn(testProjects, "resolveChangedTestTargetPlan").mockReturnValue({
        mode: "targets",
        targets: consumers,
      });
      vi.spyOn(testProjects, "hasImportGraphImpactOnTargets").mockReturnValue(false);
      vi.spyOn(testProjects, "hasImportGraphConsumers").mockReturnValue(false);
      try {
        const reasons: string[] = [];
        const shards = createChangedNodeTestShards([changedPath], {
          runnerBackend: "github",
          includeReleaseOnlyToolingShards: false,
          includeReleaseOnlyRuntimeTests: false,
          onFallback: (reason) => reasons.push(reason),
        });
        expect(shards, reasons.join("\n")).not.toBeNull();
        const files = selectedFiles(shards);
        for (const guard of expected) {
          expect(files.filter((file) => file === guard)).toHaveLength(1);
        }
        expect(files).toContain(importer);
        expect(files).not.toContain(deferred);
        expect(files).not.toContain("test/scripts/mobile-release-ci.test.ts");
        expect(files.some(isCiProofTestFile)).toBe(false);
      } finally {
        vi.restoreAllMocks();
      }
    },
  );

  it("keeps the Gateway callsite scanner beside extension source importers", () => {
    const cwd = argvTempDirs.make("changed-extension-scanner-");
    const source = "extensions/example/src/runtime.ts";
    const importer = "src/infra/extension-consumer.test.ts";
    for (const [file, content] of [
      [source, "export {};\n"],
      [importer, `import "../../${source}";\n`],
      [gatewayCallsitesGuard, "export {};\n"],
    ] as const) {
      mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
      writeFileSync(path.join(cwd, file), content);
    }
    const shards = createChangedNodeTestShards([source], { cwd });
    expect(shards).not.toBeNull();
    expect(selectedFiles(shards).toSorted()).toEqual([gatewayCallsitesGuard, importer].toSorted());
  });

  it.each([
    {
      source: "packages/example/src/value.ts",
      specifier: "@openclaw/example/value",
      manifest: "packages/example/package.json",
      document: { name: "@openclaw/example", exports: { "./value": "./src/value.ts" } },
    },
    {
      source: "src/plugin-sdk/example.ts",
      specifier: "openclaw/plugin-sdk/example",
      manifest: "tsconfig.json",
      document: {
        compilerOptions: { paths: { "openclaw/plugin-sdk/*": ["src/plugin-sdk/*.ts"] } },
      },
    },
  ])("selects consumers of $specifier without a package-wide fallback", (fixture) => {
    const cwd = argvTempDirs.make("changed-alias-consumers-");
    const target = "src/infra/alias-consumer.test.ts";
    for (const [file, source] of [
      [fixture.source, "export const value = 1;\n"],
      [fixture.manifest, JSON.stringify(fixture.document)],
      [target, `import "${fixture.specifier}";\n`],
      ["src/infra/unrelated.test.ts", "export {};\n"],
    ] as const) {
      mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
      writeFileSync(path.join(cwd, file), source);
    }
    materializeSourcePolicyFixtures(cwd);
    const shards = createChangedNodeTestShards([fixture.source], { cwd });
    expect(shards).not.toBeNull();
    expect(selectedFiles(shards)).toEqual(
      fixture.source.startsWith("src/")
        ? [target, gatewayCallsitesGuard, taskBoundaryTest]
        : [target],
    );
  });

  it("fails safe whenever a diff deletes source files", () => {
    expect(createChangedNodeTestShards(["src/infra/format-time/deleted-helper.ts"])).toBeNull();
    expect(
      createChangedNodeTestShards([
        "src/infra/format-time/deleted-helper.ts",
        "src/agents/live-provider-owner.ts",
      ]),
    ).toBeNull();
  });

  it("keeps targeting when a diff only deletes test files alongside live source", () => {
    const shards = createChangedNodeTestShards([
      "src/agents/deleted-obsolete.test.ts",
      "src/agents/live-provider-owner.ts",
    ]);
    expect(shards).not.toBeNull();
    const targets = shards?.flatMap((shard) => shard.targets ?? []) ?? [];
    expect(targets).toContain("src/agents/live-model-filter.test.ts");
  });

  it.each([
    "src/gone.test.ts",
    "src/plugin-sdk/gone.test.ts",
    "src/plugins/contracts/gone.test.ts",
    "src/channels/plugins/gone.test.ts",
  ])("runs only the boundary shard when a diff deletes %s", (target) => {
    const cwd = mkdtempSync(path.join(tmpdir(), "openclaw-ci-deleted-test-"));
    try {
      expect(createChangedExtensionFallbackShards([target], { cwd })).toEqual([]);
      expect(createChangedNodeTestShards([target], { cwd })).toEqual([
        {
          checkName: "checks-node-changed-boundary",
          configs: ["test/vitest/vitest.boundary.config.ts"],
          requiresDist: false,
          runner: "blacksmith-8vcpu-ubuntu-2404",
          shardName: "changed-boundary",
        },
      ]);
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });

  it.each([
    "tsconfig.json",
    "pnpm-workspace.yaml",
    ".npmrc",
    "node-version.mjs",
    "test/setup.ts",
    "vitest.config.ts",
    "patches/runtime.patch",
  ])("retains global execution coverage for %s beside a precise source change", (globalInput) => {
    const onFallback = vi.fn();
    expect(
      createChangedNodeTestShards(["src/agents/live-provider-owner.ts", globalInput], {
        onFallback,
      }),
    ).toBeNull();
    expect(onFallback).toHaveBeenCalledWith(`global execution or resolution input: ${globalInput}`);
  });

  it.each(["package.json", "pnpm-lock.yaml"])(
    "requires exact base resolution before narrowing dependency changes in %s",
    (changedPath) => {
      const onFallback = vi.fn();
      expect(createChangedNodeTestShards([changedPath], { onFallback })).toBeNull();
      expect(onFallback).toHaveBeenCalledWith(
        "dependency resolution requires an exact base revision",
      );
    },
  );

  it("retains broad fallback when no changed paths were supplied", () => {
    const onFallback = vi.fn();
    expect(createChangedNodeTestShards([], { onFallback })).toBeNull();
    expect(onFallback).toHaveBeenCalledWith("missing changed paths");
  });

  it("covers every extension config when core changes can impact extension consumers", () => {
    const shards = createChangedExtensionFallbackShards([
      "src/gateway/tool-resolution.ts",
      "src/agents/openclaw-tools.ts",
      "extensions/discord/src/channel.ts",
    ]);

    expectAllExtensionConfigs(shards);
  });

  it("covers every extension config when the fallback planner itself changes", () => {
    expectAllExtensionConfigs(
      createChangedExtensionFallbackShards(["scripts/lib/ci-changed-node-test-plan.mts"]),
    );
  });

  it("keeps fallback config processes serial while filling independent job budgets", () => {
    const shards = createChangedExtensionFallbackShards([
      "scripts/lib/ci-changed-node-test-plan.mts",
    ]);
    const groups = fallbackGroups(shards);
    const bundles = shards.filter((shard) => shard.groups);
    expectAllExtensionConfigs(shards);
    const appServerJob = expectDefined(
      shards.find((job) =>
        fallbackGroups([job]).some((group) =>
          group.includePatterns?.includes("extensions/codex/src/app-server/run-attempt.test.ts"),
        ),
      ),
      "measured app-server envelope",
    );
    // After fixture reuse, run 35537743091 measured 190.394s for 11 app-server
    // files. Preserve that per-file floor as the inventory changes chunk sizes.
    const appServerGroup = expectDefined(
      fallbackGroups([appServerJob]).find((group) =>
        group.includePatterns?.includes("extensions/codex/src/app-server/run-attempt.test.ts"),
      ),
      "measured app-server process",
    );
    const files = expectDefined(appServerGroup.includePatterns, "app-server files");
    const config = expectDefined(appServerGroup.configs[0], "app-server config");
    const appServerFileCount = files.filter((file) =>
      file.startsWith("extensions/codex/src/app-server/"),
    ).length;
    expect(
      extensionTestPlan.estimateExtensionTestCost(config, files.length, files),
    ).toBeGreaterThanOrEqual(Math.ceil((190.394 / 11) * appServerFileCount));
    expect(appServerJob.runner).toBe("blacksmith-8vcpu-ubuntu-2404");
    expect(shards.length).toBeGreaterThan(1);
    expect(shards.length).toBeLessThanOrEqual(50);
    for (const runnerBackend of ["blacksmith", "hybrid", "github"]) {
      const compact = createNodeTestShardBundles({
        compactMode: "pull-request",
        runnerBackend,
        includeReleaseOnlyPluginShards: false,
        compactNodeJobCap: 130 - shards.filter((job) => !job.requiresDist).length,
        changedPaths: ["scripts/lib/ci-changed-node-test-plan.mts"],
      });
      expect(compact.length).toBeLessThanOrEqual(90);
      expect(
        compact.filter((job) => !job.requiresDist).length + shards.length,
        `${runnerBackend} final PR matrix`,
      ).toBeLessThanOrEqual(130);
    }
    expect(shards.every((shard) => !shard.targets)).toBe(true);
    expect(groups.every((group) => group.configs.length === 1)).toBe(true);
    expect(shards.every((shard) => shard.planConcurrency === 1)).toBe(true);
    expect(shards.every((shard) => Number.isInteger(shard.predictedSeconds))).toBe(true);
    expect(new Set(groups.map((group) => group.shard_name)).size).toBe(groups.length);
    expect(bundles.length).toBeGreaterThan(0);
    for (const bundle of bundles) {
      expect(bundle.groups!.length).toBeGreaterThan(1);
      expect(bundle.predictedSeconds).toBeLessThanOrEqual(300);
      expect(bundle.configs).toEqual([]);
      expect(bundle.pretestBuildMode).toBeUndefined();
      expect(bundle.groups!.every((group) => !group.pretestBuildMode)).toBe(true);
      expect(bundle.groups!.every((group) => group.runner === bundle.runner)).toBe(true);
      expect(bundle.groups!.every((group) => group.requiresDist === bundle.requiresDist)).toBe(
        true,
      );
    }
    for (const [index, shard] of shards.entries()) {
      for (const other of shards.slice(index + 1)) {
        const combinedWorkerFiles = fallbackGroups([shard, other])
          .filter((group) =>
            group.configs.includes("test/vitest/vitest.extension-database-workers.config.ts"),
          )
          .flatMap((group) => group.includePatterns ?? []);
        const canShareJob =
          !shard.pretestBuildMode &&
          !other.pretestBuildMode &&
          shard.runner === other.runner &&
          shard.requiresDist === other.requiresDist &&
          shard.predictedSeconds! + other.predictedSeconds! <= 300 &&
          combinedWorkerFiles.length <= 20;
        expect(canShareJob, `${shard.shardName} and ${other.shardName} fit one job`).toBe(false);
      }
    }
  });

  it.each([
    { worker: false, ordinaryFiles: 5 },
    { worker: false, ordinaryFiles: 24 },
    { worker: true, ordinaryFiles: 5 },
    { worker: true, ordinaryFiles: 24 },
  ])(
    "groups explicit runtime consumers for worker=$worker with $ordinaryFiles ordinary files",
    ({ worker, ordinaryFiles }) => {
      const codexConfig = "test/vitest/vitest.extension-codex.config.ts";
      const workerConfig = "test/vitest/vitest.extension-database-workers.config.ts";
      const config = worker ? workerConfig : codexConfig;
      // These consumers are registered under the app-server-support config.
      // Explicit-file prerequisite authority must survive a config migration.
      const runtimeFiles = [
        "extensions/codex/src/app-server/event-projector.verbose-hooks.test.ts",
        "extensions/codex/src/app-server/transcript-mirror.test.ts",
      ];
      const files = [
        ...runtimeFiles,
        ...Array.from(
          { length: ordinaryFiles },
          (_, index) => `extensions/codex/src/app-server/middle-${index}.test.ts`,
        ),
      ];
      const ordinarySibling = "extensions/codex/src/ordinary.test.ts";
      const inventory = worker ? [...files, ordinarySibling] : files;
      try {
        vi.spyOn(changedExtensions, "listAvailableExtensionIds").mockReturnValue(["codex"]);
        vi.spyOn(extensionTestPlan, "listExtensionTestFilesForRoots").mockReturnValue(inventory);
        vi.spyOn(extensionTestPlan, "resolveExtensionTestConfig").mockImplementation((target) =>
          target.endsWith(".test.ts") && target !== ordinarySibling ? config : codexConfig,
        );
        const jobs = createChangedExtensionFallbackShards([
          "scripts/lib/ci-changed-node-test-plan.mts",
        ]);
        const groups = fallbackGroups(jobs);
        expect(groups.flatMap((group) => group.includePatterns ?? []).toSorted()).toEqual(
          inventory.toSorted(),
        );
        const prepared = jobs.filter((job) => job.pretestBuildMode);
        expect(prepared).toHaveLength(1);
        expect(prepared[0]).toMatchObject({
          configs: [config],
          pretestBuildMode: "runtime",
          planConcurrency: 1,
        });
        expect(prepared[0]?.includePatterns).toEqual(
          (ordinaryFiles === 5 ? files : runtimeFiles).toSorted(),
        );
        const preparedFiles = ordinaryFiles === 5 ? files.length : runtimeFiles.length;
        expect(prepared[0]?.predictedSeconds).toBe(
          100 + Math.ceil(preparedFiles * (worker ? 17.31 : 2.49)),
        );
        for (const group of groups) {
          expect(group.includePatterns!.length).toBeLessThanOrEqual(
            worker ? 12 : CODEX_TEST_PROCESS_FILE_LIMIT,
          );
        }
        for (const job of jobs) {
          const workerFiles = fallbackGroups([job])
            .filter((group) => group.configs.includes(workerConfig))
            .flatMap((group) => group.includePatterns ?? []);
          expect(workerFiles.length).toBeLessThanOrEqual(20);
          if (job.predictedSeconds! > 300 || job.pretestBuildMode) {
            expect(fallbackGroups([job])).toHaveLength(1);
          }
        }
      } finally {
        vi.restoreAllMocks();
      }
    },
  );

  it.each([60, 61])("exchanges extension groups within the 300-second budget, tail %s", (tail) => {
    const costs = [180, 150, 90, tail, 120];
    const ids = costs.map((_, index) => `packing-fixture-${index}`);
    const configs = ids.map((id) => `test/vitest/vitest.${id}.config.ts`);
    const files = ids.map((id) => `extensions/${id}/index.test.ts`);
    try {
      vi.spyOn(changedExtensions, "listAvailableExtensionIds").mockReturnValue(ids);
      vi.spyOn(extensionTestPlan, "listExtensionTestFilesForRoots").mockReturnValue(files);
      vi.spyOn(extensionTestPlan, "resolveExtensionTestConfig").mockImplementation((target) => {
        return expectDefined(configs[ids.indexOf(target.split("/")[1] ?? "")], "fixture config");
      });
      vi.spyOn(extensionTestPlan, "estimateExtensionTestCost").mockImplementation((config) => {
        return expectDefined(costs[configs.indexOf(config)], "fixture cost");
      });
      vi.spyOn(extensionTestPlan, "shouldSplitExtensionTestProcesses").mockReturnValue(false);
      vi.spyOn(extensionTestPlan, "splitExtensionTestJobTargets").mockImplementation((config) => {
        const file = expectDefined(files[configs.indexOf(config)], "fixture file");
        return config === configs[4] ? [[file], [file]] : [[file]];
      });

      const shards = createChangedExtensionFallbackShards([
        "scripts/lib/ci-changed-node-test-plan.mts",
      ]);
      const groups = fallbackGroups(shards);
      // First-fit strands a third row for 180, 150, 90, 60, 60, 60.
      // One extra second makes two rows impossible without exceeding the budget.
      expect(shards).toHaveLength(tail === 60 ? 2 : 3);
      expect(groups).toHaveLength(6);
      expect(
        groups
          .map((group) => expectDefined(group.configs[0], "group config"))
          .toSorted((a, b) => a.localeCompare(b)),
      ).toEqual(
        [...configs, expectDefined(configs[4], "sharded config")].toSorted((a, b) =>
          a.localeCompare(b),
        ),
      );
      expect(
        groups.filter((group) => group.configs[0] === configs[4]).map((group) => group.env),
      ).toEqual([
        { OPENCLAW_NODE_TEST_VITEST_ARGS_JSON: '["--shard=1/2"]' },
        { OPENCLAW_NODE_TEST_VITEST_ARGS_JSON: '["--shard=2/2"]' },
      ]);
      expect(groups.every((group) => !group.includePatterns && !group.pretestBuildMode)).toBe(true);
      expect(new Set(groups.map((group) => group.shard_name)).size).toBe(6);
      expect(shards.every((shard) => shard.planConcurrency === 1)).toBe(true);
      expect(shards.every((shard) => shard.predictedSeconds! <= 300)).toBe(true);
      expect(shards.reduce((seconds, shard) => seconds + shard.predictedSeconds!, 0)).toBe(
        costs.reduce((sum, cost) => sum + cost, 0),
      );
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("covers every extension config when the extension inventory changes", () => {
    expectAllExtensionConfigs(
      createChangedExtensionFallbackShards(["scripts/lib/changed-extensions.mts"]),
    );
  });

  it("classifies core and fallback-gate extension impact", () => {
    expect(hasCoreExtensionImpact(["src/agents/openclaw-tools.ts"])).toBe(true);
    expect(hasCoreExtensionImpact(["scripts/lib/changed-extensions.mts"])).toBe(true);
    expect(hasCoreExtensionImpact(["scripts/lib/ci-changed-node-test-plan.mts"])).toBe(true);
    expect(hasCoreExtensionImpact(["scripts/lib/extension-test-plan.mts"])).toBe(true);
    expect(hasCoreExtensionImpact(["extensions/discord/src/channel.ts"])).toBe(false);
    expect(hasCoreExtensionImpact(["docs/ci.md"])).toBe(false);
  });

  it("keeps extension-only fallbacks scoped to the changed extension config", () => {
    const shards = createChangedExtensionFallbackShards(["extensions/discord/src/channel.ts"]);
    for (const shard of shards) {
      expect(shard).toMatchObject({ planConcurrency: 1, predictedSeconds: expect.any(Number) });
    }
    const groups = fallbackGroups(shards);
    expect(groups).toHaveLength(2);
    expect(groups).toContainEqual(
      expect.objectContaining({
        configs: ["test/vitest/vitest.extension-discord.config.ts"],
        requiresDist: false,
        runner: "blacksmith-8vcpu-ubuntu-2404",
      }),
    );
    expect(groups).toContainEqual(
      expect.objectContaining({
        configs: ["test/vitest/vitest.extension-database-workers.config.ts"],
        includePatterns: databaseWorkerExtensionTestFiles
          .filter((file) => file.startsWith("extensions/discord/"))
          .toSorted(),
      }),
    );
  });

  it("partitions every database-worker file exactly once in a broad fallback", () => {
    const shards = createChangedExtensionFallbackShards([
      "scripts/lib/ci-changed-node-test-plan.mts",
    ]);
    const groups = fallbackGroups(shards);
    const workerGroups = groups.filter((group) =>
      group.configs.includes("test/vitest/vitest.extension-database-workers.config.ts"),
    );
    const expectedFiles = listExecutableExtensionFiles([
      ...databaseWorkerExtensionTestRoots,
      ...databaseWorkerExtensionTestFiles,
    ]);
    for (const group of workerGroups) {
      expect(group.includePatterns?.length).toBeLessThanOrEqual(20);
    }
    for (const shard of shards) {
      const files = fallbackGroups([shard])
        .filter((group) =>
          group.configs.includes("test/vitest/vitest.extension-database-workers.config.ts"),
        )
        .flatMap((group) => group.includePatterns ?? []);
      expect(files.length, shard.shardName).toBeLessThanOrEqual(20);
    }
    expect(workerGroups.length).toBeGreaterThan(1);
    expect(workerGroups.flatMap((group) => group.includePatterns ?? []).toSorted()).toEqual(
      expectedFiles.toSorted(),
    );
    expect(
      groups
        .filter((group) => !workerGroups.includes(group))
        .flatMap((group) => group.includePatterns ?? [])
        .filter((file) => expectedFiles.includes(file)),
    ).toEqual([]);
  });

  it("does not create extension fallback shards for docs-only diffs", () => {
    expect(createChangedExtensionFallbackShards(["docs/ci.md"])).toEqual([]);
  });

  it.each([
    { name: "helper alone", changedPaths: [githubActivityHelper] },
    {
      name: "helper trio",
      changedPaths: [
        githubActivityHelper,
        ".agents/skills/openclaw-pr-maintainer/SKILL.md",
        "test/scripts/github-activity-helper.test.ts",
      ],
    },
  ])(
    "keeps hidden maintainer helper targets with canonical tooling metadata for $name",
    ({ changedPaths }) => {
      expect(hasCoreExtensionImpact(changedPaths)).toBe(false);
      expect(createChangedExtensionFallbackShards(changedPaths)).toEqual([]);
      expect(resolveChangedTestTargetPlan(changedPaths, { broad: true })).toMatchObject({
        mode: "targets",
        targets: expect.arrayContaining(["test/scripts/github-activity-helper.test.ts"]),
      });
      const shards = createChangedNodeTestShards(changedPaths);
      expect(shards).not.toBeNull();
      expect(
        fallbackGroups(shards ?? []).flatMap((group) => group.includePatterns ?? []),
      ).toContain("test/scripts/github-activity-helper.test.ts");
      expect(
        shards?.filter((shard) => shard.groups).every((shard) => shard.planConcurrency === 1),
      ).toBe(true);
    },
  );

  it("keeps hidden maintainer and explicit SDK test owners together in a mixed diff", () => {
    const sdkTarget = "src/plugin-sdk/thread-aware-outbound-session-route.test.ts";
    const shards = createChangedNodeTestShards([githubActivityHelper, sdkTarget]);
    expect(shards).not.toBeNull();
    expect(selectedFiles(shards)).toEqual(
      expect.arrayContaining(["test/scripts/github-activity-helper.test.ts", sdkTarget]),
    );
  });

  it("retains broad fallback for an unknown hidden maintainer helper", () => {
    const paths = [
      githubActivityHelper,
      ".agents/skills/openclaw-pr-maintainer/scripts/unknown-helper.sh",
    ];
    expect(hasCoreExtensionImpact(paths)).toBe(true);
    expect(createChangedNodeTestShards(paths)).toBeNull();
    expectAllExtensionConfigs(createChangedExtensionFallbackShards(paths));
  });

  it.each([
    {
      changedPath: "extensions/browser/src/browser/cdp.helpers.test.ts",
      target: "extensions/browser/src/browser/cdp.helpers.test.ts",
      config: "test/vitest/vitest.extension-browser.config.ts",
    },
    {
      changedPath: "extensions/codex/src/session-upstream-marker.ts",
      target: "extensions/codex/src/session-upstream-marker.test.ts",
      config: "test/vitest/vitest.extension-codex.config.ts",
    },
  ])("selects affected extension files for $changedPath", ({ changedPath, target, config }) => {
    const shards = createChangedNodeTestShards([changedPath]);

    expect(shards).not.toBeNull();
    const groups = fallbackGroups(shards ?? []).filter((group) => group.configs.includes(config));
    expect(groups.length).toBeGreaterThan(0);
    expect(groups.every((group) => (group.includePatterns?.length ?? 0) > 0)).toBe(true);
    expect(groups.flatMap((group) => group.includePatterns ?? [])).toContain(target);
    expect(groups.flatMap((group) => group.includePatterns ?? []).length).toBeLessThan(
      listExecutableExtensionFiles([changedPath.split("/").slice(0, 2).join("/")]).length,
    );
  });

  it("packs separate Telegram envelopes into serial fallback jobs without merging file scopes", () => {
    const result = createChangedExtensionFallbackShards(["extensions/telegram/src/channel.ts"]);
    expect(result).not.toBeNull();
    const shards = result ?? [];
    const groups = fallbackGroups(shards);
    const targets = groups.flatMap((group) => group.includePatterns ?? []);

    expect(shards.length).toBeLessThan(groups.length);
    expect(shards.every((shard) => shard.planConcurrency === 1)).toBe(true);
    expect(shards.every((shard) => shard.predictedSeconds! <= 300)).toBe(true);
    expect(
      groups.every(
        (group) =>
          group.configs[0] ===
            (group.includePatterns?.every((file) => databaseWorkerExtensionTestFiles.includes(file))
              ? "test/vitest/vitest.extension-database-workers.config.ts"
              : "test/vitest/vitest.extension-telegram.config.ts") &&
          (group.includePatterns?.length ?? 0) > 0 &&
          (group.includePatterns?.length ?? 0) <= 10,
      ),
    ).toBe(true);
    expect(targets.toSorted()).toEqual(
      listExecutableExtensionFiles(["extensions/telegram"]).toSorted(),
    );
    const workerCount = targets.filter((file) =>
      databaseWorkerExtensionTestFiles.includes(file),
    ).length;
    const telegramConfig = "test/vitest/vitest.extension-telegram.config.ts";
    const runtimeFiles = listVitestRuntimeConsumerFiles([telegramConfig]).filter((file) =>
      targets.includes(file),
    );
    expect(
      shards
        .filter((shard) => shard.pretestBuildMode && shard.configs.includes(telegramConfig))
        .flatMap((shard) => shard.includePatterns ?? [])
        .toSorted(),
    ).toEqual(runtimeFiles.toSorted());
    expect(groups).toHaveLength(
      Math.ceil(workerCount / 10) +
        Math.ceil(runtimeFiles.length / 10) +
        Math.ceil((targets.length - workerCount - runtimeFiles.length) / 10),
    );
  });

  it.each([
    "test/vitest/vitest.extensions.config.ts",
    "test/vitest/vitest.extension-qa.config.ts",
    "test/vitest/vitest.extension-providers.config.ts",
  ])("partitions the whole %s for global plugin fallbacks", (config) => {
    const sortArgs = (args: Array<Record<string, string> | undefined>) =>
      args.toSorted((left, right) =>
        JSON.stringify(left ?? {}).localeCompare(JSON.stringify(right ?? {})),
      );
    const shards = createChangedExtensionFallbackShards([
      "scripts/lib/ci-changed-node-test-plan.mts",
    ]);
    expect(shards).not.toBeNull();
    const groups = fallbackGroups(shards ?? []).filter((group) => group.configs.includes(config));
    expect(groups.length).toBeGreaterThan(1);
    expect(groups.every((group) => group.configs.length === 1)).toBe(true);
    expect(groups.every((group) => !group.includePatterns)).toBe(true);
    // Every native partition must survive packing exactly once, with no argument changes.
    expect(sortArgs(groups.map((group) => group.env))).toEqual(
      sortArgs(
        groups.map((_, index) => ({
          OPENCLAW_NODE_TEST_VITEST_ARGS_JSON: JSON.stringify([
            `--shard=${index + 1}/${groups.length}`,
          ]),
        })),
      ),
    );
  });

  it("preserves Matrix process bounds in mixed package fallbacks", () => {
    const shards = createChangedExtensionFallbackShards([
      "packages/gateway-protocol/src/frame-guards.ts",
      "extensions/matrix/src/channel.ts",
    ]);
    const groups = fallbackGroups(shards);
    const targets = groups.flatMap((group) => group.includePatterns ?? []);

    expect(groups.length).toBeGreaterThan(1);
    expect(
      groups.every(
        (shard) =>
          shard.configs[0] ===
            (shard.includePatterns?.every((file) => databaseWorkerExtensionTestFiles.includes(file))
              ? "test/vitest/vitest.extension-database-workers.config.ts"
              : "test/vitest/vitest.extension-matrix.config.ts") &&
          (shard.includePatterns?.length ?? 0) > 0 &&
          (shard.includePatterns?.length ?? 0) <= 40,
      ),
    ).toBe(true);
    expect(targets.toSorted()).toEqual(
      listExtensionTestFilesForRoots(["extensions/matrix"]).toSorted(),
    );
  });

  it("skips extension fallback when the core-impact predicate does not fire", () => {
    expect(createChangedExtensionFallbackShards(["src/agents/live-provider-owner.ts"])).toEqual([]);
  });

  it("falls back to bounded Codex config shards for deleted sources", () => {
    expectBoundedCodexFallback(
      createChangedExtensionFallbackShards(["extensions/codex/src/deleted-session-runtime.ts"]),
    );
    expect(
      createChangedExtensionFallbackShards([
        "extensions/codex/src/deleted-session-runtime.test.ts",
      ]),
    ).toEqual([]);
  });

  it.each([
    { name: "fallback", createShards: createChangedExtensionFallbackShards },
    { name: "direct", createShards: createChangedNodeTestShards },
  ])("serializes bounded Memory Core jobs for $name changes", ({ createShards }) => {
    const shards = createShards([
      "extensions/memory-core/src/memory/mmr.ts",
      "extensions/memory-core/src/memory/mmr.test.ts",
    ]);
    expect(shards).not.toBeNull();
    const memoryShards =
      shards?.filter((shard) =>
        fallbackGroups([shard]).some((group) =>
          group.includePatterns?.some((file) => file.startsWith("extensions/memory-core/")),
        ),
      ) ?? [];
    expect(memoryShards.length).toBeGreaterThan(0);
    for (const shard of memoryShards) {
      expect(shard).toMatchObject({
        planConcurrency: 1,
        predictedSeconds: expect.any(Number),
        requiresDist: false,
        runner: "blacksmith-8vcpu-ubuntu-2404",
      });
      expect(
        fallbackGroups([shard])
          .filter((group) =>
            group.configs.includes("test/vitest/vitest.extension-database-workers.config.ts"),
          )
          .flatMap((group) => group.includePatterns ?? []).length,
      ).toBeLessThanOrEqual(20);
    }
    const groups = fallbackGroups(memoryShards).filter((group) =>
      group.includePatterns?.some((file) => file.startsWith("extensions/memory-core/")),
    );
    expect(
      groups.every(
        (group) =>
          group.configs.length === 1 &&
          group.configs[0] === "test/vitest/vitest.extension-database-workers.config.ts",
      ),
    ).toBe(true);
    const targets = groups
      .flatMap((group) => group.includePatterns ?? [])
      .filter((file) => file.startsWith("extensions/memory-core/"));
    if (createShards === createChangedExtensionFallbackShards) {
      expect(targets.toSorted()).toEqual(listExecutableExtensionFiles(["extensions/memory-core"]));
    } else {
      expect(targets).toContain("extensions/memory-core/src/memory/mmr.test.ts");
      expect(targets.length).toBeLessThan(
        listExecutableExtensionFiles(["extensions/memory-core"]).length,
      );
    }
  });

  it.each([
    "src/agents/simple-completion-runtime.plugin-scope.test.ts",
    "src/plugins/plugin-module-generation.sdk.test.ts",
    "src/plugin-sdk/channel-entry-contract.lifecycle.test.ts",
    "src/gateway/server-sidecar-retention.test.ts",
    "src/infra/update-candidate-canary.integration.test.ts",
    "src/cli/update-cli/update-command-migrated.test.ts",
  ])("prepares runtime artifacts for changed fixture %s", (target) => {
    const shards = createChangedNodeTestShards([target]);
    expect(shards).not.toBeNull();
    const owners = shards?.filter((shard) => selectedFiles([shard]).includes(target));
    expect(owners).toHaveLength(1);
    const owner = expectDefined(owners?.[0], "runtime-prepared target owner");
    expect(selectedFiles([owner])).toEqual([target]);
    expect(owner).toMatchObject({
      configs: [],
      requiresDist: false,
      pretestBuildMode: "runtime",
    });
  });

  it.each([1, 13])("prepares generic E2E targets across %s files", (fileCount) => {
    const cwd = argvTempDirs.make("changed-e2e-preparation-");
    const targets = Array.from(
      { length: fileCount },
      (_, index) => `src/example/case-${String(index).padStart(2, "0")}.e2e.test.ts`,
    );
    for (const target of targets) {
      mkdirSync(path.dirname(path.join(cwd, target)), { recursive: true });
      writeFileSync(path.join(cwd, target), "export {};\n");
    }
    const gitOptions = { cwd, env: createNestedGitEnv() };
    execFileSync("git", ["init", "-q"], gitOptions);
    execFileSync("git", ["add", "--", ...targets], gitOptions);
    const shards = createChangedNodeTestShards(targets, { cwd })?.filter((shard) => shard.targets);
    expect(shards).toHaveLength(Math.ceil(fileCount / 12));
    expect(shards?.flatMap((shard) => shard.targets ?? [])).toEqual(targets);
    for (const shard of shards ?? []) {
      expect(shard).toMatchObject({
        configs: [],
        requiresDist: false,
        runner: "blacksmith-8vcpu-ubuntu-2404",
        pretestBuildMode: "private-qa",
      });
      expect(shard.targets!.length).toBeLessThanOrEqual(12);
      expect(shard.planConcurrency).toBeUndefined();
    }
  });

  it("retains delivery-cache coverage and private QA preparation", () => {
    const target = "test/e2e/qa-lab/runtime/gateway-codex-delivery-cache.test.ts";
    expect(resolveChangedTestTargetPlan([target]).targets).toEqual([
      target,
      "test/scripts/ci-changed-node-test-plan.test.ts",
      "test/scripts/ci-node-test-plan.test.ts",
      "test/scripts/test-projects-build-admission.test.ts",
    ]);
    const shards = createChangedNodeTestShards([target]);
    expect(shards).not.toBeNull();
    const groups = fallbackGroups(shards ?? []);
    expect(groups.flatMap((group) => group.includePatterns ?? []).toSorted()).toEqual([
      target,
      "test/scripts/ci-changed-node-test-plan.test.ts",
      "test/scripts/ci-node-test-plan.test.ts",
    ]);
    const qaOwners = shards?.filter((shard) =>
      shard.groups?.some((group) => group.includePatterns?.includes(target)),
    );
    expect(qaOwners).toHaveLength(1);
    expect(qaOwners?.[0]).toMatchObject({
      pretestBuildMode: "private-qa",
      planConcurrency: 1,
    });
    expect(groups.find((group) => group.includePatterns?.includes(target))).toMatchObject({
      configs: ["test/vitest/vitest.tooling.config.ts"],
      pretestBuildMode: "private-qa",
    });
    // The third tooling consumer keeps its complete paired-config owner.
    const paired = groups.filter((group) => group.shard_name === "core-tooling-isolated");
    expect(paired).toHaveLength(1);
    expect(paired[0]?.configs).toEqual([
      "test/vitest/vitest.tooling-docker.config.ts",
      "test/vitest/vitest.tooling-isolated.config.ts",
    ]);
    expect(paired[0]?.includePatterns).toBeUndefined();
    expect(
      buildVitestRunPlans(["test/scripts/test-projects-build-admission.test.ts"])[0]?.config,
    ).toBe("test/vitest/vitest.tooling-isolated.config.ts");
    expect(shards?.some((shard) => shard.requiresDist)).toBe(false);
    expect(shards).toContainEqual(
      expect.objectContaining({ configs: ["test/vitest/vitest.boundary.config.ts"] }),
    );
    expect(buildVitestRunPlans([target])).toEqual([
      expect.objectContaining({
        config: "test/vitest/vitest.tooling.config.ts",
        includePatterns: [target],
      }),
    ]);
  });

  it("prebuilds private QA dist before the QA Lab extension fallback", () => {
    const shards = createChangedExtensionFallbackShards(["extensions/qa-lab/src/cli.runtime.ts"]);
    const groups = fallbackGroups(shards);
    const qaGroups = groups.filter((group) =>
      group.configs.includes("test/vitest/vitest.extension-qa.config.ts"),
    );
    expect(qaGroups.length).toBeGreaterThan(0);
    for (const group of qaGroups) {
      expect(group).toMatchObject({
        configs: ["test/vitest/vitest.extension-qa.config.ts"],
      });
      expect(group.includePatterns?.length).toBeGreaterThan(0);
      expect(group.includePatterns?.length).toBeLessThanOrEqual(90);
    }
    expect(qaGroups.flatMap((group) => group.includePatterns ?? []).toSorted()).toEqual(
      listExecutableExtensionFiles(["extensions/qa-lab"])
        .filter(
          (file) =>
            resolveExtensionTestConfig(file) === "test/vitest/vitest.extension-qa.config.ts" &&
            !isCiProofTestFile(file),
        )
        .toSorted(),
    );
    const lifecycle = "extensions/qa-lab/src/suite-process-lifecycle.test.ts";
    const lifecycleJob = shards.find((job) =>
      fallbackGroups([job]).some((group) => group.includePatterns?.includes(lifecycle)),
    );
    expect(lifecycleJob).toMatchObject({ pretestBuildMode: "private-qa", planConcurrency: 1 });
    const workerGroups = groups.filter((group) =>
      group.configs.includes("test/vitest/vitest.extension-database-workers.config.ts"),
    );
    expect(workerGroups).toEqual([
      expect.objectContaining({
        configs: ["test/vitest/vitest.extension-database-workers.config.ts"],
        includePatterns: [
          "extensions/qa-lab/src/execution-identity-storage-inspection.test.ts",
          "extensions/qa-lab/src/live-transports/matrix/scenarios/scenario-runtime-state-files.test.ts",
        ],
        requiresDist: false,
      }),
    ]);
    expect(workerGroups[0]).not.toHaveProperty("pretestBuildMode");
  });

  it("routes lifecycle edits to the prepared QA config without losing boundary coverage", () => {
    const target = "extensions/qa-lab/src/suite-process-lifecycle.test.ts";
    const shards = createChangedNodeTestShards([target]);
    expect(shards).not.toBeNull();
    const qaShards = shards?.filter((shard) => shard.pretestBuildMode === "private-qa") ?? [];
    expect(qaShards).toHaveLength(1);
    for (const shard of qaShards) {
      expect(shard).toMatchObject({
        configs: ["test/vitest/vitest.extension-qa.config.ts"],
        includePatterns: [target],
        pretestBuildMode: "private-qa",
      });
    }
    expect(shards?.filter((shard) => !qaShards.includes(shard))).toEqual([
      expect.objectContaining({ configs: ["test/vitest/vitest.boundary.config.ts"] }),
    ]);
  });

  it("retains complete tooling setup without unrelated built-artifact jobs", () => {
    for (const changedPath of ["scripts/docs-i18n/main.go", "test/scripts/docs-i18n.test.ts"]) {
      const shards = createChangedNodeTestShards([changedPath]);
      expect(shards).not.toBeNull();
      expect(
        fallbackGroups(shards ?? []).flatMap((group) => group.includePatterns ?? []),
      ).toContain("test/scripts/docs-i18n.test.ts");
      expect(
        shards?.filter((shard) => shard.groups).every((shard) => shard.planConcurrency === 1),
      ).toBe(true);
      expect(shards?.some((shard) => shard.requiresDist)).toBe(false);
      expect(shards).toContainEqual(
        expect.objectContaining({ configs: ["test/vitest/vitest.boundary.config.ts"] }),
      );
    }
  });

  it("fails safe when an unresolved source only finds an unrelated directory test", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "openclaw-ci-target-"));
    try {
      mkdirSync(path.join(cwd, "src"));
      writeFileSync(path.join(cwd, "src/value.ts"), "export const value = 1;\n");
      writeFileSync(path.join(cwd, "src/unrelated.test.ts"), "export const unrelated = true;\n");
      materializeSourcePolicyFixtures(cwd);
      expect(createChangedNodeTestShards(["src/value.ts"], { cwd })).toBeNull();
      writeFileSync(path.join(cwd, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      const dependencies = vi
        .spyOn(changedDependencies, "resolveChangedDependencies")
        .mockReturnValue({
          importers: [{ root: ".", dependencies: ["covered-dependency", "unowned-dependency"] }],
        });
      const consumers = vi.spyOn(testProjects, "resolveDependencyTestConsumers").mockReturnValue({
        sources: ["src/value.ts", "src/unrelated.test.ts"],
        tests: ["src/unrelated.test.ts"],
        unresolved: [],
      });
      try {
        const onFallback = vi.fn();
        expect(createChangedNodeTestShards(["pnpm-lock.yaml"], { cwd, onFallback })).toBeNull();
        expect(onFallback).toHaveBeenCalledWith('unresolved changed-path owner: "src/value.ts"');
      } finally {
        consumers.mockRestore();
        dependencies.mockRestore();
      }
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });

  it("fails safe for aggregate full-suite configs", () => {
    expect(
      createChangedNodeTestShards(["test/vitest/vitest.full-core-support-boundary.config.ts"]),
    ).toBeNull();
  });

  it("retains every canonical process when a leaf suite config or its dependency changes", () => {
    const config = "test/vitest/vitest.commands.config.ts";
    const full = createNodeTestShardBundles({
      compactMode: "pull-request",
      includeReleaseOnlyPluginShards: false,
      includeReleaseOnlyToolingShards: true,
    });
    const owners = full.flatMap((job) =>
      job.groups.filter((group) => group.configs.includes(config)),
    );
    expect(owners.length).toBeGreaterThan(1);
    const expectCanonicalCommands = (shards: ReturnType<typeof createChangedNodeTestShards>) => {
      expect(shards).not.toBeNull();
      const groups = fallbackGroups(shards ?? []);
      expect(groups.filter((group) => group.configs.includes(config))).toEqual(owners);
      for (const owner of owners) {
        const fullJob = expectDefined(
          full.find((job) => job.groups.includes(owner)),
          "canonical commands job",
        );
        const selectedJob = expectDefined(
          shards?.find((job) => job.groups?.some((group) => group.shard_name === owner.shard_name)),
          "selected commands job",
        );
        expect(selectedJob.runner).toBe(fullJob.runner);
        expect(selectedJob.env).toEqual(fullJob.env);
        expect(selectedJob.planConcurrency).toBe(fullJob.planConcurrency);
        expect(selectedJob.pretestBuildMode).toBe(fullJob.pretestBuildMode);
        expect(selectedJob.timeoutMinutes).toBe(fullJob.timeoutMinutes);
      }
      const configs = groups.flatMap((group) => group.configs);
      expect(configs).not.toContain("test/vitest/vitest.cron.config.ts");
      expect(configs).not.toContain("test/vitest/vitest.ui.config.ts");
    };
    const shards = createChangedNodeTestShards([config]);
    expectCanonicalCommands(shards);
    expect(selectedFiles(shards)).toEqual(
      expect.arrayContaining([
        "test/vitest-projects-config.test.ts",
        "test/vitest-scoped-config.test.ts",
        "test/scripts/ci-node-test-plan.commands.test.ts",
      ]),
    );
    const dependencies = vi
      .spyOn(changedDependencies, "resolveChangedDependencies")
      .mockReturnValue({
        importers: [{ root: ".", dependencies: ["config-only-dependency"] }],
      });
    const consumers = vi.spyOn(testProjects, "resolveDependencyTestConsumers").mockReturnValue({
      sources: [config],
      tests: [],
      unresolved: [],
    });
    try {
      expectCanonicalCommands(createChangedNodeTestShards(["pnpm-lock.yaml"]));
      dependencies.mockReturnValue({
        importers: [{ root: ".", dependencies: ["config-only-dependency", "opaque-dependency"] }],
      });
      consumers.mockReturnValue({
        sources: [config],
        tests: [],
        unresolved: [{ root: ".", dependency: "opaque-dependency" }],
      });
      const onFallback = vi.fn();
      expect(createChangedNodeTestShards(["pnpm-lock.yaml"], { onFallback })).toBeNull();
      expect(onFallback).toHaveBeenCalledWith("unresolved dependency usage: .:opaque-dependency");
    } finally {
      consumers.mockRestore();
      dependencies.mockRestore();
    }
    expect(createChangedNodeTestShards(["test/vitest/vitest.unknown-owner.config.ts"])).toBeNull();
  });

  it("selects UI source consumers through exact canonical rows", () => {
    const shards = createChangedNodeTestShards([
      "ui/src/app-routes.ts",
      "ui/src/app-navigation.ts",
    ]);
    expect(shards).not.toBeNull();
    expect(selectedFiles(shards)).toEqual(
      expect.arrayContaining(["ui/src/app-routes.test.ts", "ui/src/app-navigation.test.ts"]),
    );
    const uiGroups = fallbackGroups(shards ?? []).filter((group) =>
      group.configs.some((config) => config.startsWith("test/vitest/vitest.ui")),
    );
    expect(uiGroups.length).toBeGreaterThan(0);
    expect(uiGroups.every((group) => (group.includePatterns?.length ?? 0) > 0)).toBe(true);
    expect(selectedFiles(shards)).not.toContain("test/scripts/mobile-release-ci.test.ts");
  });

  it("keeps more than 96 changed tests and a direct plugin test precise with canonical worker budgets", () => {
    const cronTests = listGitTrackedFiles({ pathspecs: "src/cron" })
      ?.filter((file) => file.endsWith(".test.ts") && !/\.(?:e2e|live)\.test\.ts$/u.test(file))
      .slice(0, 97);
    expect(cronTests?.length).toBe(97);
    const changedTests = [...(cronTests ?? []), "src/plugins/tools.optional.test.ts"];
    const shards = createChangedNodeTestShards(changedTests);
    expect(shards).not.toBeNull();
    const targets = selectedFiles(shards);
    expect(targets.toSorted()).toEqual(changedTests?.toSorted());
    expect(new Set(targets).size).toBe(targets.length);
    const full = createNodeTestShardBundles({
      changedPaths: changedTests,
      compactMode: "pull-request",
      includeReleaseOnlyPluginShards: false,
    });
    const selectedJobs = shards?.filter((shard) => shard.groups?.length) ?? [];
    expect(selectedJobs.length).toBeGreaterThan(0);
    for (const job of selectedJobs) {
      for (const group of job.groups ?? []) {
        const ownerJob = expectDefined(
          full.find((candidate) =>
            candidate.groups.some((owner) => owner.shard_name === group.shard_name),
          ),
          `canonical job for ${group.shard_name}`,
        );
        const owner = expectDefined(
          ownerJob.groups.find((candidate) => candidate.shard_name === group.shard_name),
          `canonical group for ${group.shard_name}`,
        );
        expect(group.configs).toEqual(owner.configs);
        expect(group.env).toEqual(owner.env);
        expect(group.fallbackMaxWorkers).toBe(owner.fallbackMaxWorkers);
        expect(group.minTotalMemoryBytes).toBe(owner.minTotalMemoryBytes);
        expect(job.env).toEqual(ownerJob.env);
        expect(job.runner).toBe(ownerJob.runner);
        expect(job.planConcurrency).toBe(ownerJob.planConcurrency);
      }
    }
  });
});
