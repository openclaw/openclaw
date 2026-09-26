import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import {
  createChangedNodeTestShards,
  hasControlUiPerformanceAffectingChange,
} from "../../scripts/lib/ci-changed-node-test-plan.mts";
import { createNodeTestShardBundles } from "../../scripts/lib/ci-node-test-plan.mts";
import { isReleaseOnlyRuntimeTestFile } from "../../scripts/lib/ci-proof-test-inventory.mts";
import { buildVitestRunPlans } from "../../scripts/test-projects.test-support.mts";
import * as testProjects from "../../scripts/test-projects.test-support.mts";

// Real-checkout compositions share the planner's process-scoped import-graph cache.
// Small synthetic graphs and canonical process selection remain in the unit file.
function fallbackGroups(shards: NonNullable<ReturnType<typeof createChangedNodeTestShards>>) {
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

it("retains package and plugin consumers together in a mixed diff", () => {
  const changedPaths = [
    "packages/gateway-protocol/src/frame-guards.ts",
    "extensions/codex/src/session-upstream-marker.ts",
  ];

  const fallbackReasons: string[] = [];
  const shards = createChangedNodeTestShards(changedPaths, {
    onFallback: (reason) => fallbackReasons.push(reason),
  });
  expect(shards, fallbackReasons.join("\n")).not.toBeNull();
  expect(selectedFiles(shards)).toEqual(
    expect.arrayContaining([
      "packages/gateway-protocol/src/frame-guards.test.ts",
      "extensions/codex/src/session-upstream-marker.test.ts",
    ]),
  );
  const extensionGroups = fallbackGroups(shards ?? []).filter((group) =>
    group.configs.some((config) => config.includes("vitest.extension")),
  );
  expect(extensionGroups.length).toBeGreaterThan(0);
  expect(extensionGroups.every((group) => (group.includePatterns?.length ?? 0) > 0)).toBe(true);
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
    includeReleaseOnlyRuntimeTests: false,
  };
  const shards = createChangedNodeTestShards(paths, options);
  expect(shards).not.toBeNull();
  expect(hasControlUiPerformanceAffectingChange([paths[2]!])).toBe(true);
  const full = createNodeTestShardBundles({
    changedPaths: paths,
    compactMode: "pull-request",
    runnerBackend: "hybrid",
    includeReleaseOnlyRuntimeTests: false,
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
      groups: owner.groups.filter((group) =>
        group.configs.some((config) =>
          /^test\/vitest\/vitest\.ui(?:-isolated|-timing)?\.config\.ts$/u.test(config),
        ),
      ),
      configs: [],
      checkName: `checks-node-changed-ui-${owner.shardName}`,
      shardName: `changed-ui-${owner.shardName}`,
    });
  }
  expect(shards!.length).toBeLessThan(full.length);
  expect(new Set(shards?.map((shard) => shard.checkName)).size).toBe(shards?.length);
  const selectedGroups = fallbackGroups(shards ?? []);
  expect(
    selectedGroups
      .flatMap((group) => group.includePatterns ?? [])
      .some(isReleaseOnlyRuntimeTestFile),
  ).toBe(false);
  for (const consumer of [
    "src/agents/live-model-filter.test.ts",
    "test/ui.presenter-next-run.test.ts",
    "test/talk-browser-defaults.test.ts",
    "test/vitest-ui-package-config.test.ts",
    "src/audit/execution-decision-facts.test.ts",
    "src/auto-reply/reply/commands-export-session.test.ts",
    "src/gateway/server-methods/session-change-event.fallback.test.ts",
  ]) {
    const consumerConfig = buildVitestRunPlans([consumer])[0]!.config;
    expect(
      selectedFiles(shards).includes(consumer) ||
        selectedGroups.some(
          (group) =>
            group.configs.includes(consumerConfig) &&
            (!group.includePatterns ||
              group.includePatterns.some((pattern) => path.matchesGlob(consumer, pattern))),
        ),
      consumer,
    ).toBe(true);
  }
  const toolingFiles = selectedGroups
    .filter((group) => group.configs.includes("test/vitest/vitest.tooling.config.ts"))
    .flatMap((group) => group.includePatterns ?? []);
  for (const unrelated of [
    "test/scripts/pr-worktree-provision.test.ts",
    "test/scripts/pr-merge-recovery.test.ts",
    "test/scripts/mobile-release-authority.test.ts",
  ]) {
    expect(toolingFiles, unrelated).not.toContain(unrelated);
  }
  expect(shards?.some((shard) => shard.requiresDist)).toBe(false);
  const precise = createChangedNodeTestShards(paths, { ...options, dedicatedUiE2e: false });
  expect(precise).not.toBeNull();
  const preciseFiles = selectedFiles(precise);
  expect(preciseFiles).toEqual(
    expect.arrayContaining([
      "ui/src/components/markdown-file-links.test.ts",
      "ui/src/app/control-ui-chunking.test.ts",
      "ui/src/app/vite-config.node.test.ts",
      "src/agents/live-model-filter.test.ts",
      "src/agents/live-model-dynamic-candidates.test.ts",
      "src/agents/live-target-matcher.test.ts",
      "src/agents/model-compat.test.ts",
    ]),
  );
  expect(new Set(preciseFiles).size).toBe(preciseFiles.length);
  expect(preciseFiles.some(isReleaseOnlyRuntimeTestFile)).toBe(false);
  expect(precise!.length).toBeLessThan(shards!.length);
  // Precise targets already passed deferral, so their canonical template retains runtime rows.
  const preciseOwners = createNodeTestShardBundles({
    compactMode: "pull-request",
    runnerBackend: "hybrid",
    includeReleaseOnlyRuntimeTests: true,
  });
  for (const job of precise ?? []) {
    for (const group of job.groups ?? []) {
      const ownerJob = expectDefined(
        preciseOwners.find((candidate) =>
          candidate.groups.some((owner) => owner.shard_name === group.shard_name),
        ),
        `canonical UI consumer job for ${group.shard_name}`,
      );
      const owner = expectDefined(
        ownerJob.groups.find((candidate) => candidate.shard_name === group.shard_name),
        "canonical UI consumer group",
      );
      expect(group.includePatterns?.length).toBeGreaterThan(0);
      expect(group.configs.every((config) => owner.configs.includes(config))).toBe(true);
      expect(group.env).toEqual(owner.env);
      expect(group.fallbackMaxWorkers).toBe(owner.fallbackMaxWorkers);
      expect(group.minTotalMemoryBytes).toBe(owner.minTotalMemoryBytes);
      expect(job.env).toEqual(ownerJob.env);
      expect(job.runner).toBe(ownerJob.runner);
      expect(job.planConcurrency).toBe(ownerJob.planConcurrency);
    }
  }
  expect(createChangedNodeTestShards([paths[1]!, "ui/src/AGENTS.md"], options)).toEqual(
    createChangedNodeTestShards([paths[1]!], options),
  );
  const onFallback = vi.fn();
  expect(
    createChangedNodeTestShards([...paths, "package.json"], { ...options, onFallback }),
  ).toBeNull();
  expect(onFallback).toHaveBeenCalledWith("dependency resolution requires an exact base revision");

  const consumers = testProjects.resolveControlUiTestConsumers([paths[0]!]);
  for (const missing of [
    "test/scripts/missing-ui-consumer.test.ts",
    "test/scripts/missing-ui-consumer.e2e.test.ts",
  ]) {
    const unresolvedConsumer = vi
      .spyOn(testProjects, "resolveControlUiTestConsumers")
      .mockReturnValue([...consumers, missing]);
    try {
      expect(createChangedNodeTestShards(paths, options), missing).toBeNull();
    } finally {
      unresolvedConsumer.mockRestore();
    }
  }
  const resolvePlans = testProjects.buildVitestRunPlans;
  const missingOwner = vi
    .spyOn(testProjects, "buildVitestRunPlans")
    .mockImplementation((targets, cwd) =>
      targets.includes("test/vitest-ui-package-config.test.ts") ? [] : resolvePlans(targets, cwd),
    );
  try {
    expect(createChangedNodeTestShards(paths, { ...options, onFallback })).toBeNull();
    expect(onFallback).toHaveBeenCalledWith("unresolved UI host consumer");
  } finally {
    missingOwner.mockRestore();
  }
});
