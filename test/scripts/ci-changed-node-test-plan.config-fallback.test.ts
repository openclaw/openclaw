import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveShardPlans, runShardPlans } from "../../scripts/ci-run-node-test-shard.mts";
import {
  createChangedExtensionConfigShards,
  packChangedExtensionConfigShards,
  resolveChangedExtensionRoots,
} from "../../scripts/lib/ci-extension-test-shards.mts";
import { encodeNodeTestGroups } from "../../scripts/lib/ci-node-test-groups-codec.mts";
import { isCiProofTestFile } from "../../scripts/lib/ci-proof-test-inventory.mts";
import { refitTestTimings } from "../../scripts/lib/ci-test-timings-refit.mts";
import * as testTimings from "../../scripts/lib/ci-test-timings.mts";
import {
  listExtensionTestFilesForRoots,
  resolveExtensionTestConfig,
} from "../../scripts/lib/extension-test-plan.mts";
import * as extensionTestPlan from "../../scripts/lib/extension-test-plan.mts";
import * as buildPrerequisites from "../../scripts/lib/vitest-build-prerequisites.mts";
import {
  buildVitestRunPlans,
  resolveChangedTestTargetPlan,
} from "../../scripts/test-projects.test-support.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createNestedGitEnv } from "../helpers/temp-repo.js";
import { isSharedVitestExcludedPath } from "../vitest/vitest.pattern-file.ts";
import {
  gatewayCallsitesGuard,
  createChangedNodeTestShards,
  materializeGatewayCallsitesFixture,
  fallbackGroups,
  selectedFiles,
  expectCanonicalGroupedConcurrency,
} from "./ci-changed-node-test-plan.test-support.js";

const argvTempDirs = useAutoCleanupTempDirTracker(afterEach);

const CODEX_TEST_PROCESS_FILE_LIMIT = 24;

const githubActivityHelper = ".agents/skills/openclaw-pr-maintainer/scripts/github-activity.sh";

function planExtensionTargets(files: string[]) {
  return packChangedExtensionConfigShards(
    createChangedExtensionConfigShards(resolveChangedExtensionRoots(files), {
      targets: new Set(files),
    }),
  );
}

function listExecutableExtensionFiles(roots: string[]) {
  return listExtensionTestFilesForRoots(roots).filter(
    (file) => !isSharedVitestExcludedPath(file, "extensions"),
  );
}

it.each([
  ["test/vitest/vitest.extensions.config.ts", "extensions/copilot/index.ts"],
  ["test/vitest/vitest.extension-qa.config.ts", "extensions/qa-lab/src/cli.runtime.ts"],
  ["test/vitest/vitest.extension-providers.config.ts", "extensions/anthropic/index.ts"],
])("emits each affected-package file once through %s", async (config, changedPath) => {
  const root = changedPath.split("/").slice(0, 2).join("/");
  const partitions = fallbackGroups(
    planExtensionTargets(listExecutableExtensionFiles([root])),
  ).filter((group) => group.configs.includes(config));
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

describe("CI changed Node test plan", () => {
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
        vi.spyOn(extensionTestPlan, "listExtensionTestFilesForRoots").mockReturnValue(inventory);
        vi.spyOn(extensionTestPlan, "resolveExtensionTestConfig").mockImplementation((target) =>
          target.endsWith(".test.ts") && target !== ordinarySibling ? config : codexConfig,
        );
        const jobs = planExtensionTargets(inventory);
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
          60 + Math.ceil(preparedFiles * (worker ? 17.31 : 2.49)),
        );
        expect(prepared[0]?.predictedTestSeconds).toBe(
          Math.ceil(preparedFiles * (worker ? 17.31 : 2.49)),
        );
        for (const group of groups) {
          expect(group.includePatterns!.length).toBeLessThanOrEqual(
            worker ? 12 : CODEX_TEST_PROCESS_FILE_LIMIT,
          );
        }
        for (const job of jobs) {
          expect(job.predictedTestSeconds).toBe(
            job.predictedSeconds! - (job.pretestBuildMode ? 60 : 0),
          );
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

  it("packs measured native plugin envelopes without changing their one-file process lifetime", () => {
    const config = "test/vitest/vitest.extension-database-workers.config.ts";
    const files = Array.from(
      { length: 18 },
      (_, index) => `extensions/telegram/src/native-fixture-${index}.test.ts`,
    );
    expect(files).toHaveLength(18);
    const ordinary = "extensions/telegram/src/ordinary-fixture.test.ts";
    const inventory = [...files, ordinary];
    try {
      vi.spyOn(extensionTestPlan, "listExtensionTestFilesForRoots").mockReturnValue(inventory);
      const resolveConfig = extensionTestPlan.resolveExtensionTestConfig;
      vi.spyOn(extensionTestPlan, "resolveExtensionTestConfig").mockImplementation((target) =>
        files.includes(target) ? config : resolveConfig(target),
      );
      vi.spyOn(buildPrerequisites, "resolveVitestPretestBuildMode").mockReturnValue(undefined);
      const costs = vi.spyOn(testTimings, "readCompactGroupTimings").mockReturnValue({});
      const before = planExtensionTargets(inventory);
      expect(before).toHaveLength(1);
      const groups = fallbackGroups(before).filter((group) => group.configs.includes(config));
      expect(groups).toHaveLength(2);
      const runs = [1, 2].map((id) => ({
        id,
        createdAt: "2026-09-26T00:00:00Z",
        completeInventory: false,
        pullRequestMergeRef: true,
        logs: [
          {
            kind: "compact" as const,
            labels: ["blacksmith-8vcpu-ubuntu-2404"],
            text: [
              "2026-09-26T00:00:00Z OPENCLAW_VITEST_MAX_WORKERS: 2",
              `2026-09-26T00:00:00Z OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: ${encodeNodeTestGroups(groups)}`,
              ...groups.flatMap((group, index) => [
                `2026-09-26T00:0${index * 4}:00Z [shard:${group.shard_name}] begin`,
                `2026-09-26T00:0${index * 4}:01Z [shard:${group.shard_name}] [test] inner parallelism 2`,
                `2026-09-26T00:0${index * 4 + 3}:12Z [shard:${group.shard_name}] end (exit 0)`,
              ]),
            ].join("\n"),
          },
        ],
      }));
      const measured = refitTestTimings(runs).timings.compactGroupSeconds.blacksmith;
      expect(Object.values(measured)).toEqual([192, 192]);
      costs.mockReturnValue(measured);
      const after = planExtensionTargets(inventory);
      expect(after).toHaveLength(2);
      expect(
        after.every(
          (job) =>
            job.predictedSeconds! <= 300 &&
            job.planConcurrency === 1 &&
            job.runner === "blacksmith-8vcpu-ubuntu-2404",
        ),
      ).toBe(true);
      expect(
        fallbackGroups(after)
          .flatMap((group) => group.includePatterns ?? [])
          .toSorted(),
      ).toEqual(inventory.toSorted());
      expect(
        fallbackGroups(after)
          .filter((group) => group.configs.includes(config))
          .map((group) => group.includePatterns),
      ).toEqual(groups.map((group) => group.includePatterns));
      expect(extensionTestPlan.splitExtensionTestProcessTargets(config, files)).toEqual(
        files.toSorted().map((file) => [file]),
      );
      // Exact measurements cannot price a different selection, config, or worker policy.
      const selected = groups[0]!.includePatterns!;
      expect(
        extensionTestPlan.estimateExtensionTestCost(config, selected.length - 1, selected.slice(1)),
      ).toBeLessThan(192);
      expect(
        extensionTestPlan.estimateExtensionTestCost(
          "test/vitest/vitest.extension-telegram.config.ts",
          selected.length,
          selected,
        ),
      ).toBeLessThan(192);
      const otherWorkerKey = extensionTestPlan.createExtensionTestTimingKey(config, selected, {
        OPENCLAW_VITEST_MAX_WORKERS: "8",
      })!;
      costs.mockReturnValue({ [otherWorkerKey]: 500 });
      expect(
        extensionTestPlan.estimateExtensionTestCost(config, selected.length, selected),
      ).toBeLessThan(192);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("fills native file budgets without subdividing exact measured envelopes", () => {
    const config = "test/vitest/vitest.extension-database-workers.config.ts";
    const files = Array.from(
      { length: 36 },
      (_, index) => `extensions/codex/src/native-fixture-${String(index).padStart(2, "0")}.test.ts`,
    );
    const ordinary = "extensions/codex/src/ordinary-fixture.test.ts";
    const inventory = [...files, ordinary];
    try {
      vi.spyOn(extensionTestPlan, "listExtensionTestFilesForRoots").mockReturnValue(inventory);
      const resolveConfig = extensionTestPlan.resolveExtensionTestConfig;
      vi.spyOn(extensionTestPlan, "resolveExtensionTestConfig").mockImplementation((target) =>
        files.includes(target) ? config : resolveConfig(target),
      );
      vi.spyOn(buildPrerequisites, "resolveVitestPretestBuildMode").mockReturnValue(undefined);
      const costs = vi.spyOn(testTimings, "readCompactGroupTimings").mockReturnValue({});
      const create = () => planExtensionTargets(inventory);
      const unmeasured = create();
      expect(unmeasured).toHaveLength(2);
      expect(
        fallbackGroups(unmeasured)
          .flatMap((group) => group.includePatterns ?? [])
          .toSorted(),
      ).toEqual(inventory.toSorted());

      const measuredFiles = files.slice(0, 12);
      const measuredKey = extensionTestPlan.createExtensionTestTimingKey(config, measuredFiles)!;
      costs.mockReturnValue({ [measuredKey]: 300 });
      const measured = create();
      const measuredJob = expectDefined(
        measured.find((job) =>
          fallbackGroups([job]).some((group) => group.includePatterns?.includes(measuredFiles[0]!)),
        ),
        "complete measured native envelope",
      );
      expect(fallbackGroups([measuredJob])).toHaveLength(1);
      expect(measuredJob.includePatterns).toEqual(measuredFiles);
      expect(measuredJob.predictedSeconds).toBe(300);
      expect(measured).toHaveLength(3);
      expect(
        fallbackGroups(measured)
          .flatMap((group) => group.includePatterns ?? [])
          .toSorted(),
      ).toEqual(inventory.toSorted());
      for (const job of [...unmeasured, ...measured]) {
        expect(job.planConcurrency).toBe(1);
        expect(job.predictedSeconds).toBeLessThanOrEqual(300);
        expect(
          fallbackGroups([job])
            .filter((group) => group.configs.includes(config))
            .flatMap((group) => group.includePatterns ?? []).length,
        ).toBeLessThanOrEqual(20);
      }
    } finally {
      vi.restoreAllMocks();
    }
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
      expect(resolveChangedTestTargetPlan(changedPaths, { broad: true })).toMatchObject({
        mode: "targets",
        targets: expect.arrayContaining(["test/scripts/github-activity-helper.test.ts"]),
      });
      const shards = createChangedNodeTestShards(changedPaths);
      expect(shards).not.toBeNull();
      expect(
        fallbackGroups(shards ?? []).flatMap((group) => group.includePatterns ?? []),
      ).toContain("test/scripts/github-activity-helper.test.ts");
      expectCanonicalGroupedConcurrency(shards);
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

  it("keeps known maintainer owners bounded beside an unknown hidden helper", () => {
    const paths = [
      githubActivityHelper,
      ".agents/skills/openclaw-pr-maintainer/scripts/unknown-helper.sh",
    ];
    const shards = createChangedNodeTestShards(paths);
    expect(shards).not.toBeNull();
    expect(selectedFiles(shards)).toContain("test/scripts/github-activity-helper.test.ts");
    expect(selectedFiles(shards)).not.toContain("extensions/telegram/src/send.test.ts");
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

  it("serializes bounded Memory Core jobs for changed targets", () => {
    const shards = createChangedNodeTestShards([
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
    expect(targets).toContain("extensions/memory-core/src/memory/mmr.test.ts");
    expect(targets.length).toBeLessThan(
      listExecutableExtensionFiles(["extensions/memory-core"]).length,
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
      "test/scripts/ci-changed-node-test-plan.config-fallback.test.ts",
      "test/scripts/ci-node-test-plan.test.ts",
      "test/scripts/test-projects-build-admission.test.ts",
    ]);
    const shards = createChangedNodeTestShards([target]);
    expect(shards).not.toBeNull();
    const groups = fallbackGroups(shards ?? []);
    expect(groups.flatMap((group) => group.includePatterns ?? []).toSorted()).toEqual([
      target,
      "test/scripts/ci-changed-node-test-plan.config-fallback.test.ts",
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
    // Each config in the pair keeps its complete, separate include inventory.
    const paired = groups.filter((group) => group.shard_name === "core-tooling-isolated");
    expect(paired).toHaveLength(1);
    expect(paired[0]?.configs).toEqual([
      "test/vitest/vitest.tooling-docker.config.ts",
      "test/vitest/vitest.tooling-isolated.config.ts",
    ]);
    expect(paired[0]?.includePatterns).toBeUndefined();
    expect(paired[0]?.env?.OPENCLAW_VITEST_MAX_WORKERS).toBe("2");
    expect(shards?.find((job) => job.groups?.includes(paired[0]!))?.planConcurrency).toBe(1);
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

  it("prebuilds private QA dist before selected QA Lab targets", () => {
    const shards = planExtensionTargets(listExecutableExtensionFiles(["extensions/qa-lab"]));
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
      expectCanonicalGroupedConcurrency(shards);
      expect(shards?.some((shard) => shard.requiresDist)).toBe(false);
      expect(shards).toContainEqual(
        expect.objectContaining({ configs: ["test/vitest/vitest.boundary.config.ts"] }),
      );
    }
  });

  it("keeps unowned root sources and dependency hubs away from unrelated directory tests", () => {
    const cwd = argvTempDirs.make("openclaw-ci-target-");
    mkdirSync(path.join(cwd, "src"));
    writeFileSync(path.join(cwd, "src/value.ts"), "export const value = 1;\n");
    writeFileSync(path.join(cwd, "src/unrelated.test.ts"), "export const unrelated = true;\n");
    materializeGatewayCallsitesFixture(cwd);
    const source = createChangedNodeTestShards(["src/value.ts"], { cwd });
    expect(source).not.toBeNull();
    expect(selectedFiles(source)).toEqual([gatewayCallsitesGuard]);
    expect(selectedFiles(source)).not.toContain("src/unrelated.test.ts");
    writeFileSync(path.join(cwd, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const onFallback = vi.fn();
    const dependency = createChangedNodeTestShards(["pnpm-lock.yaml"], { cwd, onFallback });
    expect(dependency).not.toBeNull();
    expect(selectedFiles(dependency)).toEqual([gatewayCallsitesGuard]);
    expect(selectedFiles(dependency)).not.toContain("src/unrelated.test.ts");
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("keeps aggregate full-suite configs on their guard owners", () => {
    const shards = createChangedNodeTestShards([
      "test/vitest/vitest.full-core-support-boundary.config.ts",
    ]);
    expect(shards).not.toBeNull();
    expect(selectedFiles(shards)).toContain("test/vitest-projects-config.test.ts");
    expect(selectedFiles(shards)).not.toContain("src/cron/service.stream-trigger.test.ts");
  });
});
