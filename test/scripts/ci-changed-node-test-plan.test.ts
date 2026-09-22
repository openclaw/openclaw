import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveTestGitCommits } from "../../.github/actions/git-owner/test-prerequisites.mjs";
import { resolveShardPlans, runShardPlans } from "../../scripts/ci-run-node-test-shard.mts";
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
} from "../../scripts/lib/ci-changed-node-test-plan.mts";
import { encodeNodeTestGroups } from "../../scripts/lib/ci-node-test-groups-codec.mts";
import {
  createNodeTestShardBundles,
  createSelectedNodeTestShardBundles,
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
  hasImportGraphImpactOnTargets,
  resolveChangedTestTargetPlan,
} from "../../scripts/test-projects.test-support.mts";
import { listGitTrackedFiles } from "../../src/test-utils/repo-files.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  databaseWorkerExtensionTestFiles,
  databaseWorkerExtensionTestRoots,
} from "../vitest/vitest.extension-database-workers-paths.mjs";
import { isGatewayServerTestFile } from "../vitest/vitest.gateway-server-paths.mjs";
import { startupCorpusTestFiles } from "../vitest/vitest.startup-corpus-paths.mjs";
import { boundaryTestFiles } from "../vitest/vitest.unit-paths.mjs";

const CODEX_TEST_PROCESS_FILE_LIMIT = 24;
const argvTempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each([
  ["test/vitest/vitest.extensions.config.ts", "extensions/copilot/index.ts"],
  ["test/vitest/vitest.extension-qa.config.ts", "extensions/qa-lab/src/cli.runtime.ts"],
  ["test/vitest/vitest.extension-providers.config.ts", "extensions/anthropic/index.ts"],
])("emits the changed-extension partition exactly once for %s", async (config, changedPath) => {
  const partitions = fallbackGroups(createChangedExtensionFallbackShards([changedPath])).filter(
    (group) => group.configs.includes(config),
  );
  expect(partitions.length).toBeGreaterThan(1);
  const env = {
    OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: encodeNodeTestGroups(partitions),
    OPENCLAW_NODE_TEST_PLAN_CONCURRENCY: "1",
    OPENCLAW_NODE_TEST_VITEST_ARGS_JSON: '["--hookTimeout=600000"]',
  };
  const argv: string[][] = [];
  expect(
    await runShardPlans(resolveShardPlans(env), {
      env,
      scratchDir: argvTempDirs.make("changed-extension-argv-"),
      runChild: async (args) => {
        argv.push(args);
        return 0;
      },
    }),
  ).toBe(0);
  const prefix = [config, "--", "--hookTimeout=600000"];
  expect(argv).toHaveLength(partitions.length);
  for (const [index] of partitions.entries()) {
    expect(argv).toContainEqual([...prefix, `--shard=${index + 1}/${partitions.length}`]);
  }
});

it("keeps precise first-signin targets under exclusive Gateway admission", () => {
  const target = "src/gateway/setup-inference.first-signin.integration.test.ts";
  const jobs = createChangedNodeTestShards([target], { runnerBackend: "hybrid" });
  expect(jobs).not.toBeNull();
  const owner = jobs?.find((job) =>
    job.groups?.some((group) => group.includePatterns?.includes(target)),
  );
  expect(owner).toMatchObject({ planConcurrency: 1 });
  expect(jobs?.flatMap((job) => job.targets ?? [])).not.toContain(target);
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
  expect(targets.toSorted()).toEqual(
    listExtensionTestFilesForRoots(["extensions/codex"]).toSorted(),
  );
}

function fallbackGroups(shards: ReturnType<typeof createChangedExtensionFallbackShards>) {
  return shards.flatMap((shard) => shard.groups ?? [{ ...shard, shard_name: shard.shardName }]);
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

  it("keeps boundary coverage when only a deferred proof helper changes", () => {
    const helper = "test/helpers/sqlite-sessions-transcripts-flip-proof-assertions.ts";
    const shards = createChangedNodeTestShards([helper]);
    expect(shards).toEqual([
      expect.objectContaining({
        checkName: "checks-node-changed-boundary",
        configs: ["test/vitest/vitest.boundary.config.ts"],
      }),
    ]);
    expect(createChangedNodeTestShards([helper, "src/deleted-unowned-source.ts"])).toBeNull();
  });

  it.each(["blacksmith", "github", "hybrid"])(
    "defers owner-changing automatic PRs to complete tooling coverage (%s)",
    (runnerBackend) => {
      for (const changedPath of [
        "test/scripts/vitest-report-owner.test.ts",
        "scripts/lib/vitest-report-owner.mts",
        "package.json",
      ]) {
        expect(
          createChangedNodeTestShards([changedPath], {
            runnerBackend,
            includeReleaseOnlyToolingShards: false,
          }),
        ).toBeNull();
      }
    },
  );

  it("keeps product-only precise selections free of maintainer tooling", () => {
    const shards = createChangedNodeTestShards(["src/infra/retry.test.ts"], {
      includeReleaseOnlyToolingShards: false,
    });
    expect(shards).not.toBeNull();
    expect(
      shards?.flatMap((shard) => [
        ...(shard.targets ?? shard.includePatterns ?? []),
        ...(shard.groups?.flatMap((group) => group.includePatterns ?? []) ?? []),
      ]),
    ).toContain("src/infra/retry.test.ts");
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
    "retains precise embedded files with their canonical owners (%s)",
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
      expect(shards?.every((shard) => shard.planConcurrency === 1)).toBe(true);
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
      expect(
        groups
          .filter((group) => group.requiresDist)
          .map((group) => group.shard_name)
          .toSorted(),
      ).toEqual(["core-runtime-tui-pty", "core-support-boundary"]);
      expect(groups.filter((group) => group.requiresDist)).toEqual(
        canonical.filter((group) => group.requiresDist),
      );
      for (const shard of shards ?? []) {
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
        new Set([
          ...expectedTargets.flatMap((target) => resolveTestGitCommits({ targets: [target] })),
          ...full.filter((shard) => shard.requiresDist).flatMap(resolveTestGitCommits),
        ]),
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
    expect(shards?.flatMap((shard) => shard.targets ?? [])).toEqual([ordinary]);
    expect(
      fallbackGroups(shards ?? [])
        .flatMap((group) => group.includePatterns ?? [])
        .toSorted(),
    ).toEqual([...gitToolingTargets, embedded].toSorted());
    expect(shards?.some((shard) => shard.requiresDist)).toBe(true);
    for (const other of [
      "src/deleted.ts",
      "tsconfig.json",
      "src/tui/tui-pty-harness.e2e.test.ts",
    ]) {
      expect(createChangedNodeTestShards(["test/scripts/ci-linux-git.test.ts", other])).toBeNull();
    }
  });

  it.each(
    [
      [],
      ["test/scripts/unknown-tooling.test.ts"],
      ["src/agents/embedded-agent-runner/run/unknown-owner.test.ts"],
      ["src/tui/tui-pty-harness.e2e.test.ts"],
      ["test/vitest/vitest.tooling.config.ts"],
      ["test/vitest/vitest.tooling-isolated.config.ts"],
      ["test/scripts/docker-build-helper.test.ts", "test/scripts/unknown-tooling.test.ts"],
      ["test/scripts/docker-build-helper.test.ts", "src/tui/tui-pty-harness.e2e.test.ts"],
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
    // Core E2E still requires full-suite metadata; UI ownership cannot absorb it.
    for (const paths of [["src/gateway/gateway.test.ts"], [...changedPaths, "src/deleted.ts"]]) {
      expect(createChangedNodeTestShards(paths)).toBeNull();
      expect(createChangedNodeTestShards(paths, { dedicatedUiE2e: true })).toBeNull();
    }
  });
  it.each([
    "extensions/copilot/index.ts",
    "extensions/copilot/harness.ts",
    "extensions/copilot/openclaw.plugin.json",
  ])("keeps host discovery proof when only %s changes", (changedPath) => {
    const hostTest = "src/agents/prepared-model-runtime.copilot.integration.test.ts";
    const shards = createChangedNodeTestShards([changedPath]);
    expect(shards).not.toBeNull();
    expect(shards?.filter((shard) => shard.targets)).toHaveLength(1);
    expect(shards?.flatMap((shard) => shard.targets ?? [])).toEqual([hostTest]);
    expect(new Set(fallbackGroups(shards ?? []).flatMap((group) => group.configs))).toEqual(
      new Set([
        "test/vitest/vitest.extensions.config.ts",
        "test/vitest/vitest.extension-database-workers.config.ts",
      ]),
    );
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
      targets: ["src/agents/model-ref-shared.test.ts"],
    },
    {
      source: "src/test-utils/symlink-rebind-race.ts",
      targets: expect.arrayContaining(["src/infra/fs-safe-import-boundary.test.ts"]),
    },
  ])("routes $source through source-scanning policy tests", ({ source, targets: expected }) => {
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
    const targets = shards?.flatMap((shard) => shard.targets ?? []) ?? [];

    expect(targets).toEqual([
      "src/cron/service.stream-trigger.test.ts",
      "src/cron/service.stream-validation.test.ts",
      "src/cron/service/timer.timeout-watchdog.test.ts",
    ]);
  });

  it("routes a focused source change into one targeted job", () => {
    expect(createChangedNodeTestShards(["src/agents/live-provider-owner.ts"])).toEqual([
      {
        checkName: "checks-node-changed",
        configs: [],
        requiresDist: false,
        runner: "blacksmith-8vcpu-ubuntu-2404",
        shardName: "changed",
        targets: [
          "src/agents/live-model-dynamic-candidates.test.ts",
          "src/agents/live-model-filter.test.ts",
          "src/agents/live-target-matcher.test.ts",
          "src/agents/model-compat.test.ts",
        ],
      },
    ]);
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

  it("requires dedicated config ownership and preserves an empty precise build plan", () => {
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
      for (const file of unrelated) {
        const before = createChangedNodeTestShards([file], { cwd });
        // E2E configs require full-suite metadata; an unknown channel pattern
        // keeps its exact target rather than claiming dedicated coverage.
        expect(before?.flatMap((shard) => shard.targets ?? []) ?? null).toEqual(
          file.endsWith(".e2e.test.ts") ? null : [file],
        );
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
      ).toEqual([target]);
      expect(createChangedNodeTestShards([source], { cwd, dedicatedContractShards })).toEqual([]);
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
    expect(configs).toEqual(
      expect.arrayContaining([
        "test/vitest/vitest.boundary.config.ts",
        "test/vitest/vitest.tui-pty.config.ts",
      ]),
    );
  });

  it("retains fallback for max-lines baseline mixed with its planner", () => {
    expect(
      createChangedNodeTestShards(
        ["config/max-lines-baseline.txt", "scripts/lib/ci-changed-node-test-plan.mts"],
        { dedicatedMaxLinesRatchet: true },
      ),
    ).toBeNull();
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
  ])("retains the other test owner alongside a boundary target: %s", (companion) => {
    expect(
      createChangedNodeTestShards(["test/extension-import-boundaries.test.ts", companion]),
    ).toEqual(createChangedNodeTestShards([companion]));
  });

  it.each(["src/agents/live-provider-owner.ts", "test/scripts/ci-linux-git.test.ts"])(
    "keeps an explicit boundary target when no local full owner is emitted: %s",
    (companion) => {
      const target = "test/extension-import-boundaries.test.ts";
      const shards = createChangedNodeTestShards([target, companion]);
      expect(shards).not.toBeNull();
      expect(shards?.flatMap((shard) => shard.targets ?? [])).toContain(target);
      expect(shards?.map((shard) => shard.checkName)).not.toContain("checks-node-changed-boundary");
      if (companion.endsWith(".test.ts")) {
        expect(shards?.some((shard) => shard.requiresDist)).toBe(true);
        expect(shards?.filter((shard) => shard.groups)).toEqual(
          createChangedNodeTestShards([companion])?.filter((shard) => shard.groups),
        );
      }
    },
  );

  it.each(["docs/help/index.md", "src/infra/deleted-boundary.test.ts"])(
    "retains the local boundary owner with an ignored companion: %s",
    (companion) => {
      const target = "test/extension-import-boundaries.test.ts";
      expect(createChangedNodeTestShards([target, companion])).toEqual(
        createChangedNodeTestShards([target]),
      );
    },
  );

  it.each([
    "src/infra/deleted-boundary.ts",
    "tsconfig.json",
    "test/vitest/vitest.boundary.config.ts",
    "scripts/lib/ci-changed-node-test-plan.mts",
  ])("validates an unresolved companion before crediting boundary coverage: %s", (companion) => {
    expect(
      createChangedNodeTestShards(["test/extension-import-boundaries.test.ts", companion]),
    ).toBeNull();
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
    ["patches/@awesome.me__webawesome@3.12.0.patch", true],
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
      [["AGENTS.md"], "file", true],
      [["src/agents/AGENTS.md"], "file", true],
      [["src/agents/AGENTS.md"], "missing", true],
      [[".agents/skills/example/SKILL.md"], "file", true],
      [["skills/example/SKILL.md"], "file", true],
      [["docs/deleted.md"], "missing", true],
      [["docs/old.md", "docs/new.md"], "rename", true],
      [["docs/reference/templates/AGENTS.md"], "file", false],
      [["docs/reference/templates/AGENTS.md"], "missing", false],
      [["src/runtime.md"], "file", false],
      [["test/fixtures/payload.md"], "file", false],
      [["test/fixtures/AGENTS.md"], "file", false],
      [["docs/script.ts"], "file", false],
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

  it("fails safe when an unresolved path is mixed with a precise source change", () => {
    expect(
      createChangedNodeTestShards(["src/agents/live-provider-owner.ts", "tsconfig.json"]),
    ).toBeNull();
  });

  it.each([
    { changedPaths: ["src/plugin-sdk/core.ts"] },
    { changedPaths: ["src/plugin-sdk/core.ts", "src/plugin-sdk/config-runtime.test.ts"] },
    {
      changedPaths: [
        "src/plugins/contracts/registry.ts",
        "src/plugins/contracts/registry.retry.test.ts",
      ],
    },
    {
      changedPaths: [
        "src/channels/plugins/config-schema.ts",
        "src/channels/plugins/config-schema.test.ts",
      ],
    },
  ])(
    "fails safe when public contracts affect extension imports: $changedPaths",
    ({ changedPaths }) => {
      expect(createChangedNodeTestShards(changedPaths)).toBeNull();
      expectAllExtensionConfigs(createChangedExtensionFallbackShards(changedPaths));
    },
  );

  it("fails safe when a core change reaches package consumers through the public SDK", () => {
    expect(createChangedNodeTestShards(["src/shared/text/strip-markdown.ts"])).toBeNull();
  });

  it("fails safe when a core change reaches a public SDK wrapper through an import", () => {
    expect(createChangedNodeTestShards(["src/channels/chat-meta-shared.ts"])).toBeNull();
  });

  it("fails safe when workspace package consumers use package imports", () => {
    expect(
      createChangedNodeTestShards(["packages/gateway-protocol/src/frame-guards.ts"]),
    ).toBeNull();
  });

  it("supplements mixed package diffs with the affected extension config", () => {
    const changedPaths = [
      "packages/gateway-protocol/src/frame-guards.ts",
      "extensions/codex/src/session-upstream-marker.ts",
    ];

    expect(createChangedNodeTestShards(changedPaths)).toBeNull();
    expectBoundedCodexFallback(createChangedExtensionFallbackShards(changedPaths));
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
    const precise = createChangedNodeTestShards(
      listAvailableExtensionIds().map((id) => `extensions/${id}/package.json`),
    );
    expect(precise).not.toBeNull();
    expectAllExtensionConfigs(precise ?? []);
    expectAllExtensionConfigs(shards);
    for (const plan of [shards, precise ?? []]) {
      const appServerJob = expectDefined(
        plan.find((job) =>
          fallbackGroups([job]).some((group) =>
            group.includePatterns?.includes("extensions/codex/src/app-server/run-attempt.test.ts"),
          ),
        ),
        "measured app-server envelope",
      );
      // After fixture reuse, run 35537743091 measured 190.394s for 11 app-server
      // files. The mixed config median must still not hide that native-worker tail.
      const appServerGroup = expectDefined(
        fallbackGroups([appServerJob]).find((group) =>
          group.includePatterns?.includes("extensions/codex/src/app-server/run-attempt.test.ts"),
        ),
        "measured app-server process",
      );
      const files = expectDefined(appServerGroup.includePatterns, "app-server files");
      const config = expectDefined(appServerGroup.configs[0], "app-server config");
      expect(
        extensionTestPlan.estimateExtensionTestCost(config, files.length, files),
      ).toBeGreaterThanOrEqual(191);
      expect(appServerJob.runner).toBe("blacksmith-8vcpu-ubuntu-2404");
    }
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
      expect(bundle.predictedSeconds).toBeLessThanOrEqual(240);
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
          shard.predictedSeconds! + other.predictedSeconds! <= 240 &&
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
          if (job.predictedSeconds! > 240 || job.pretestBuildMode) {
            expect(fallbackGroups([job])).toHaveLength(1);
          }
        }
      } finally {
        vi.restoreAllMocks();
      }
    },
  );

  it.each([48, 49])("exchanges extension groups within the 240-second budget, tail %s", (tail) => {
    const costs = [144, 120, 72, tail, 96];
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
      // First-fit strands a third row for 144, 120, 72, 48, 48, 48.
      // One extra second makes two rows impossible without exceeding the budget.
      expect(shards).toHaveLength(tail === 48 ? 2 : 3);
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
      expect(shards.every((shard) => shard.predictedSeconds! <= 240)).toBe(true);
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
    const expectedFiles = listExtensionTestFilesForRoots([
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

  it.each([
    "src/plugin-sdk/core.ts",
    ".agents/skills/openclaw-pr-maintainer/scripts/unknown-helper.sh",
  ])(
    "retains all extension configs for the hidden maintainer helper mixed with %s",
    (changedPath) => {
      const paths = [githubActivityHelper, changedPath];
      expect(hasCoreExtensionImpact(paths)).toBe(true);
      expect(createChangedNodeTestShards(paths)).toBeNull();
      expectAllExtensionConfigs(createChangedExtensionFallbackShards(paths));
    },
  );

  it.each([
    {
      changedPath: "extensions/browser/src/browser/cdp.helpers.test.ts",
      config: "test/vitest/vitest.extension-browser.config.ts",
    },
    {
      changedPath: "extensions/codex/src/session-upstream-marker.ts",
      config: "test/vitest/vitest.extension-codex.config.ts",
    },
  ])("runs the whole owning extension config for $changedPath", ({ changedPath, config }) => {
    const shards = createChangedNodeTestShards([changedPath]);

    expect(shards).not.toBeNull();
    expect(fallbackGroups(shards ?? []).flatMap((group) => group.configs)).toContain(config);
  });

  it.each([
    { name: "precise", createShards: createChangedNodeTestShards },
    { name: "fallback", createShards: createChangedExtensionFallbackShards },
  ])(
    "packs separate Telegram envelopes into serial $name jobs without merging their file scopes",
    ({ createShards }) => {
      const result = createShards(["extensions/telegram/src/channel.ts"]);
      expect(result).not.toBeNull();
      const shards = result ?? [];
      const groups = fallbackGroups(shards);
      const targets = groups.flatMap((group) => group.includePatterns ?? []);

      expect(shards.length).toBeLessThan(groups.length);
      expect(shards.every((shard) => shard.planConcurrency === 1)).toBe(true);
      expect(shards.every((shard) => shard.predictedSeconds! <= 240)).toBe(true);
      expect(
        groups.every(
          (group) =>
            group.configs[0] ===
              (group.includePatterns?.every((file) =>
                databaseWorkerExtensionTestFiles.includes(file),
              )
                ? "test/vitest/vitest.extension-database-workers.config.ts"
                : "test/vitest/vitest.extension-telegram.config.ts") &&
            (group.includePatterns?.length ?? 0) > 0 &&
            (group.includePatterns?.length ?? 0) <= 10,
        ),
      ).toBe(true);
      expect(targets.toSorted()).toEqual(
        listExtensionTestFilesForRoots(["extensions/telegram"]).toSorted(),
      );
      const workerCount = targets.filter((file) =>
        databaseWorkerExtensionTestFiles.includes(file),
      ).length;
      const runtimeFiles = listVitestRuntimeConsumerFiles([
        "test/vitest/vitest.extension-telegram.config.ts",
      ]).filter((file) => targets.includes(file));
      expect(
        shards
          .filter((shard) => shard.pretestBuildMode)
          .flatMap((shard) => shard.includePatterns ?? [])
          .toSorted(),
      ).toEqual(runtimeFiles.toSorted());
      expect(groups).toHaveLength(
        Math.ceil(workerCount / 10) +
          Math.ceil(runtimeFiles.length / 10) +
          Math.ceil((targets.length - workerCount - runtimeFiles.length) / 10),
      );
    },
  );

  it.each([
    ["test/vitest/vitest.extensions.config.ts", "extensions/copilot/index.ts"],
    ["test/vitest/vitest.extension-qa.config.ts", "extensions/qa-lab/src/cli.runtime.ts"],
    ["test/vitest/vitest.extension-providers.config.ts", "extensions/anthropic/index.ts"],
  ])("partitions the whole %s for direct and core-driven plugin changes", (config, changedPath) => {
    const sortArgs = (args: Array<Record<string, string> | undefined>) =>
      args.toSorted((left, right) =>
        JSON.stringify(left ?? {}).localeCompare(JSON.stringify(right ?? {})),
      );
    for (const shards of [
      createChangedNodeTestShards([changedPath]),
      createChangedExtensionFallbackShards([changedPath]),
      createChangedExtensionFallbackShards(["scripts/lib/ci-changed-node-test-plan.mts"]),
    ]) {
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
    }
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
    const cwd = mkdtempSync(path.join(tmpdir(), "openclaw-ci-extension-fallback-"));
    try {
      expectBoundedCodexFallback(
        createChangedExtensionFallbackShards(["extensions/codex/src/deleted-session-runtime.ts"], {
          cwd,
        }),
      );
      expect(
        createChangedExtensionFallbackShards(
          ["extensions/codex/src/deleted-session-runtime.test.ts"],
          { cwd },
        ),
      ).toEqual([]);
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
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
    expect(shards!.length).toBeGreaterThan(1);
    for (const shard of shards!) {
      expect(shard).toMatchObject({
        planConcurrency: 1,
        predictedSeconds: expect.any(Number),
        requiresDist: false,
        runner: "blacksmith-8vcpu-ubuntu-2404",
      });
      expect(
        fallbackGroups([shard]).flatMap((group) => group.includePatterns ?? []).length,
      ).toBeLessThanOrEqual(20);
    }
    const groups = fallbackGroups(shards!);
    expect(
      groups.every(
        (group) =>
          group.configs.length === 1 &&
          group.configs[0] === "test/vitest/vitest.extension-database-workers.config.ts",
      ),
    ).toBe(true);
    expect(groups.flatMap((group) => group.includePatterns ?? []).toSorted()).toEqual(
      listExtensionTestFilesForRoots(["extensions/memory-core"]),
    );
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
    const owners = shards?.filter((shard) => shard.targets?.includes(target));
    expect(owners).toHaveLength(1);
    expect(owners?.[0]).toMatchObject({
      configs: [],
      targets: [target],
      pretestBuildMode: "runtime",
    });
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
    expect(
      groups
        .filter((group) => group.requiresDist)
        .map((group) => group.shard_name)
        .toSorted(),
    ).toEqual(["core-runtime-tui-pty", "core-support-boundary"]);
    expect(buildVitestRunPlans([target])).toEqual([
      expect.objectContaining({
        config: "test/vitest/vitest.tooling.config.ts",
        includePatterns: [target],
      }),
    ]);
  });

  it("prebuilds private QA dist before the QA Lab extension fallback", () => {
    const shards = createChangedExtensionFallbackShards(["extensions/qa-lab/src/cli.runtime.ts"]);
    const qaShards = shards.filter((shard) =>
      shard.configs?.includes("test/vitest/vitest.extension-qa.config.ts"),
    );
    expect(qaShards.length).toBeGreaterThan(1);
    for (const shard of qaShards) {
      expect(shard).toMatchObject({
        configs: ["test/vitest/vitest.extension-qa.config.ts"],
        pretestBuildMode: "private-qa",
      });
    }
    const workerShards = shards.filter((shard) => !qaShards.includes(shard));
    expect(workerShards).toEqual([
      expect.objectContaining({
        configs: ["test/vitest/vitest.extension-database-workers.config.ts"],
        includePatterns: [
          "extensions/qa-lab/src/execution-identity-storage-inspection.test.ts",
          "extensions/qa-lab/src/live-transports/matrix/scenarios/scenario-runtime-state-files.test.ts",
        ],
        requiresDist: false,
      }),
    ]);
    expect(workerShards[0]).not.toHaveProperty("pretestBuildMode");
  });

  it("routes lifecycle edits to the prepared QA config without losing boundary coverage", () => {
    const target = "extensions/qa-lab/src/suite-process-lifecycle.test.ts";
    const shards = createChangedNodeTestShards([target]);
    expect(shards).not.toBeNull();
    const qaShards = shards?.filter((shard) => shard.pretestBuildMode === "private-qa") ?? [];
    expect(qaShards.length).toBeGreaterThan(1);
    for (const shard of qaShards) {
      expect(shard).toMatchObject({
        configs: ["test/vitest/vitest.extension-qa.config.ts"],
        pretestBuildMode: "private-qa",
      });
    }
    expect(shards?.filter((shard) => !qaShards.includes(shard))).toEqual([
      expect.objectContaining({
        configs: ["test/vitest/vitest.extension-database-workers.config.ts"],
        includePatterns: [
          "extensions/qa-lab/src/execution-identity-storage-inspection.test.ts",
          "extensions/qa-lab/src/live-transports/matrix/scenarios/scenario-runtime-state-files.test.ts",
        ],
        requiresDist: false,
      }),
      expect.objectContaining({ configs: ["test/vitest/vitest.boundary.config.ts"] }),
    ]);
  });

  it("retains complete tooling setup and rejects unsupported whole-config setup", () => {
    for (const changedPath of ["scripts/docs-i18n/main.go", "test/scripts/docs-i18n.test.ts"]) {
      const shards = createChangedNodeTestShards([changedPath]);
      expect(shards).not.toBeNull();
      expect(
        fallbackGroups(shards ?? []).flatMap((group) => group.includePatterns ?? []),
      ).toContain("test/scripts/docs-i18n.test.ts");
      expect(shards?.every((shard) => shard.planConcurrency === 1)).toBe(true);
    }
    expect(createChangedNodeTestShards(["src/tui/tui-pty-harness.e2e.test.ts"])).toBeNull();
  });

  it("fails safe when an unresolved source only finds an unrelated directory test", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "openclaw-ci-target-"));
    try {
      mkdirSync(path.join(cwd, "src"));
      writeFileSync(path.join(cwd, "src/value.ts"), "export const value = 1;\n");
      writeFileSync(path.join(cwd, "src/unrelated.test.ts"), "export const unrelated = true;\n");
      expect(createChangedNodeTestShards(["src/value.ts"], { cwd })).toBeNull();
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });

  it("fails safe for aggregate full-suite configs", () => {
    expect(
      createChangedNodeTestShards(["test/vitest/vitest.full-core-support-boundary.config.ts"]),
    ).toBeNull();
  });

  it("fails safe for leaf configs split across full-suite processes", () => {
    expect(createChangedNodeTestShards(["test/vitest/vitest.commands.config.ts"])).toBeNull();
  });

  it("fails safe when source targets expand to a whole config", () => {
    expect(
      createChangedNodeTestShards(["ui/src/app-routes.ts", "ui/src/app-navigation.ts"]),
    ).toBeNull();
  });

  it("keeps UI fallback with its complete canonical owners beside precise core changes", () => {
    const paths = [
      "ui/src/components/markdown-file-links.ts",
      "src/agents/live-provider-owner.ts",
      "ui/config/control-ui-boot-modules.json",
    ];
    const options = {
      runnerBackend: "hybrid",
      dedicatedUiE2e: true,
      includeReleaseOnlyToolingShards: false,
    };
    const shards = createChangedNodeTestShards(paths, options);
    expect(shards).not.toBeNull();
    expect(hasControlUiPerformanceAffectingChange([paths[2]!])).toBe(true);
    const full = createNodeTestShardBundles({
      compactMode: "pull-request",
      runnerBackend: "hybrid",
    });
    const uiOwners = full.filter((shard) =>
      shard.groups?.some((group) =>
        group.configs.some((config) =>
          /^test\/vitest\/vitest\.ui(?:-isolated|-timing)?\.config\.ts$/u.test(config),
        ),
      ),
    );
    expect(uiOwners.length).toBeGreaterThan(0);
    for (const owner of uiOwners) {
      expect(shards).toContainEqual({
        ...owner,
        configs: [],
        checkName: `checks-node-changed-ui-${owner.shardName}`,
        shardName: `changed-ui-${owner.shardName}`,
      });
    }
    expect(shards!.length).toBeLessThan(full.length);
    expect(new Set(shards?.map((shard) => shard.checkName)).size).toBe(shards?.length);
    const selectedGroups = fallbackGroups(shards ?? []);
    for (const consumer of [
      "src/agents/live-model-filter.test.ts",
      "test/ui.presenter-next-run.test.ts",
      "test/talk-browser-defaults.test.ts",
    ]) {
      const consumerConfig = buildVitestRunPlans([consumer])[0]!.config;
      expect(
        shards?.some((shard) => shard.targets?.includes(consumer)) ||
          selectedGroups.some(
            (group) =>
              group.configs.includes(consumerConfig) &&
              (!group.includePatterns ||
                group.includePatterns.some((pattern) => path.matchesGlob(consumer, pattern))),
          ),
        consumer,
      ).toBe(true);
    }
    expect(createChangedNodeTestShards(paths)).toBeNull();
    expect(createChangedNodeTestShards([paths[1]!, "ui/src/AGENTS.md"], options)).toEqual(
      createChangedNodeTestShards([paths[1]!], options),
    );
    const onFallback = vi.fn();
    expect(
      createChangedNodeTestShards([...paths, "package.json"], { ...options, onFallback }),
    ).toBeNull();
    expect(onFallback).toHaveBeenCalledWith("tooling owner change requires full-family coverage");
  });

  it("chunks many targets into bounded parallel jobs", () => {
    // A wide test-file diff exercises the multi-chunk path against the real
    // tree; the cron suite has well over one chunk's worth of test files.
    const changedTests = listGitTrackedFiles({ pathspecs: "src/cron" })
      ?.filter((file) => file.endsWith(".test.ts") && !/\.(?:e2e|live)\.test\.ts$/u.test(file))
      .slice(0, 15);
    expect(changedTests?.length).toBe(15);
    const shards = createChangedNodeTestShards(changedTests ?? []);
    expect(shards).not.toBeNull();
    const targetShards = shards?.filter((shard) => shard.targets) ?? [];
    expect(targetShards.length).toBeGreaterThan(1);
    expect(
      targetShards.every((shard, index) => shard.checkName === `checks-node-changed-${index + 1}`),
    ).toBe(true);
    expect(targetShards.every((shard) => (shard.targets?.length ?? 0) <= 12)).toBe(true);
    const targets = targetShards.flatMap((shard) => shard.targets ?? []);
    expect(new Set(targets).size).toBe(targets.length);
  });
});
