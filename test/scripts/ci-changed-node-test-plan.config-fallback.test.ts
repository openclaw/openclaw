import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createNestedGitEnv } from "../helpers/temp-repo.js";
import { isSharedVitestExcludedPath } from "../vitest/vitest.pattern-file.ts";
import {
  gatewayCallsitesGuard,
  createChangedNodeTestShards,
  materializeGatewayCallsitesFixture,
  fallbackGroups,
  selectedFiles,
} from "./ci-changed-node-test-plan.test-support.js";

const argvTempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

const CODEX_TEST_PROCESS_FILE_LIMIT = 24;
const workerConfig = "test/vitest/vitest.extension-database-workers.config.ts";

function mockNativeInventory(files: string[], ordinary: string) {
  vi.spyOn(extensionTestPlan, "listExtensionTestFilesForRoots").mockReturnValue([
    ...files,
    ordinary,
  ]);
  const resolveConfig = extensionTestPlan.resolveExtensionTestConfig;
  vi.spyOn(extensionTestPlan, "resolveExtensionTestConfig").mockImplementation((target) =>
    files.includes(target) ? workerConfig : resolveConfig(target),
  );
  vi.spyOn(buildPrerequisites, "resolveVitestPretestBuildMode").mockReturnValue(undefined);
  return vi.spyOn(testTimings, "readCompactGroupTimings").mockReturnValue({});
}

function expectInventory(shards: ReturnType<typeof planExtensionTargets>, files: string[]) {
  expect(
    fallbackGroups(shards)
      .flatMap((group) => group.includePatterns ?? [])
      .toSorted(),
  ).toEqual(files.toSorted());
}

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
])("emits each affected-package file once through %s", (config, changedPath) => {
  const root = changedPath.split("/").slice(0, 2).join("/");
  const shards = planExtensionTargets(listExecutableExtensionFiles([root]));
  const groups = fallbackGroups(shards);
  const partitions = groups.filter((group) => group.configs.includes(config));
  const expectedFiles = listExecutableExtensionFiles([root]).filter(
    (file) => resolveExtensionTestConfig(file) === config && !isCiProofTestFile(file),
  );
  expect(partitions.length).toBeGreaterThan(0);
  expect(partitions.flatMap((group) => group.includePatterns ?? []).toSorted()).toEqual(
    expectedFiles.toSorted(),
  );
  expect(partitions.every((group) => (group.includePatterns?.length ?? 0) <= 90)).toBe(true);
  if (root === "extensions/qa-lab") {
    for (const group of partitions) {
      expect(group).toMatchObject({ configs: [config] });
      expect(group.includePatterns?.length).toBeGreaterThan(0);
    }
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
          "extensions/qa-lab/src/codex-plugin-lifecycle.test.ts",
          "extensions/qa-lab/src/execution-identity-storage-inspection.test.ts",
          "extensions/qa-lab/src/gateway-child-artifacts.test.ts",
          "extensions/qa-lab/src/gateway-child-auth-handoff.test.ts",
          "extensions/qa-lab/src/gateway-child-auth-profiles.test.ts",
          "extensions/qa-lab/src/gateway-child-lifecycle.test.ts",
          "extensions/qa-lab/src/gateway-child.test.ts",
          "extensions/qa-lab/src/live-transports/matrix/scenarios/scenario-runtime-state-files.test.ts",
          "extensions/qa-lab/src/providers/shared/auth-store.test.ts",
          "extensions/qa-lab/src/suite-runtime-agent-session.test.ts",
        ],
        requiresDist: false,
      }),
    ]);
    expect(workerGroups[0]).not.toHaveProperty("pretestBuildMode");
  }
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
    },
  );

  it("packs measured native plugin envelopes without changing their one-file process lifetime", () => {
    const config = workerConfig;
    const files = Array.from(
      { length: 18 },
      (_, index) => `extensions/telegram/src/native-fixture-${index}.test.ts`,
    );
    const ordinary = "extensions/telegram/src/ordinary-fixture.test.ts";
    const inventory = [...files, ordinary];
    const costs = mockNativeInventory(files, ordinary);
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
    expectInventory(after, inventory);
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
  });

  it("fills native file budgets without subdividing exact measured envelopes", () => {
    const config = workerConfig;
    const files = Array.from(
      { length: 36 },
      (_, index) => `extensions/codex/src/native-fixture-${String(index).padStart(2, "0")}.test.ts`,
    );
    const ordinary = "extensions/codex/src/ordinary-fixture.test.ts";
    const inventory = [...files, ordinary];
    const costs = mockNativeInventory(files, ordinary);
    const create = () => planExtensionTargets(inventory);
    const unmeasured = create();
    expect(unmeasured).toHaveLength(2);
    expectInventory(unmeasured, inventory);

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
    expectInventory(measured, inventory);
    for (const job of [...unmeasured, ...measured]) {
      expect(job.planConcurrency).toBe(1);
      expect(job.predictedSeconds).toBeLessThanOrEqual(300);
      expect(
        fallbackGroups([job])
          .filter((group) => group.configs.includes(config))
          .flatMap((group) => group.includePatterns ?? []).length,
      ).toBeLessThanOrEqual(20);
    }
  });

  it.each([13])("prepares generic E2E targets across %s files", (fileCount) => {
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
});
