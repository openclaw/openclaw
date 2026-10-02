import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import {
  createChangedNodeTestShards,
  hasControlUiPerformanceAffectingChange,
  resolveChangedNodeTestTargets,
} from "../../scripts/lib/ci-changed-node-test-plan.mts";
import {
  createNodeTestShardBundles,
  createSelectedNodeTestShardBundles,
  type CompactNodeTestShard,
} from "../../scripts/lib/ci-node-test-plan.mts";
import {
  isReleaseOnlyRuntimeTestFile,
  listPrExemptRuntimeTestFiles,
  PR_PROTECTED_RUNTIME_TEST_FILES,
} from "../../scripts/lib/ci-proof-test-inventory.mts";
import * as testTimings from "../../scripts/lib/ci-test-timings.mts";

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

function canonicalOwner(jobs: CompactNodeTestShard[], shardName: string) {
  const job = expectDefined(
    jobs.find((candidate) => candidate.groups.some((group) => group.shard_name === shardName)),
    `canonical job for ${shardName}`,
  );
  const group = expectDefined(
    job.groups.find((candidate) => candidate.shard_name === shardName),
    `canonical group for ${shardName}`,
  );
  return { job, group };
}

it("keeps the aggressive fixed smoke within two Node rows", () => {
  let smoke: string[] = [];
  resolveChangedNodeTestTargets(["src/infra/new-unlisted-module.ts"], {
    selectionMode: "aggressive",
    onSelection: ({ rule, targets }) => {
      if (rule === "fixed-smoke") {
        smoke = targets;
      }
    },
  });
  expect(smoke).toEqual([
    "src/config/io.load-async.test.ts",
    "src/plugins/loader.runtime-registry.test.ts",
  ]);
  const rows = createChangedNodeTestShards(["src/infra/new-unlisted-module.ts"], {
    selectedTestTargets: smoke,
    selectionMode: "aggressive",
    runnerBackend: "hybrid",
    dedicatedBuildArtifacts: false,
    dedicatedUiTests: true,
    dedicatedUiE2e: true,
  });
  expect(selectedFiles(rows).toSorted()).toEqual(smoke.toSorted());
  expect(rows?.filter((row) => !row.requiresDist).length).toBeLessThanOrEqual(2);
});

it("keeps the hybrid hourly plan within the main-tier cap", () => {
  const hourly = createNodeTestShardBundles({
    runnerBackend: "hybrid",
    compactMode: "pull-request",
    compactNodeJobCap: 77,
    includeProofTests: true,
    includeReleaseOnlyToolingShards: true,
    includePrExemptRuntimeTests: true,
    includeReleaseOnlyRuntimeTests: false,
    includeReleaseOnlyPluginShards: false,
  });
  expect(hourly.filter((job) => !job.requiresDist).length).toBeLessThanOrEqual(77);
  expect(hourly.length).toBeLessThanOrEqual(79);
});

it.each(
  [
    {
      target: "test/scripts/bench-gateway-installed.test.ts",
      sources: ["scripts/bench-gateway-startup.ts"],
      preciseSubjects: true,
    },
    {
      target: "src/commands/doctor-lint.native-capture.test.ts",
      sources: [
        "src/commands/doctor-lint.native-capture.test-support.ts",
        "src/cli/run-main-plugin-cache.ts",
      ],
      preciseSubjects: false,
    },
  ].flatMap(({ target, sources, preciseSubjects }) =>
    [target, ...sources].map((changedPath) => ({ target, changedPath, preciseSubjects })),
  ),
)(
  "opts in $target for $changedPath beside hub inputs",
  ({ target, changedPath, preciseSubjects }) => {
    expect(listPrExemptRuntimeTestFiles()).toContain(target);
    const options = {
      runnerBackend: "github",
      includeReleaseOnlyRuntimeTests: false,
      includePrExemptRuntimeTests: false,
      includeReleaseOnlyToolingShards: false,
    };
    const fallbackFiles = (changedPaths: string[]) =>
      createNodeTestShardBundles({
        ...options,
        compactMode: "pull-request",
        changedPaths,
      }).flatMap((job) => job.groups.flatMap((group) => group.includePatterns ?? []));
    const precise = createChangedNodeTestShards([changedPath], options);
    if (preciseSubjects || changedPath === target) {
      expect(precise, changedPath).not.toBeNull();
    }
    expect(precise ? selectedFiles(precise) : fallbackFiles([changedPath]), changedPath).toContain(
      target,
    );
    const withHub = createChangedNodeTestShards(["tsconfig.json", changedPath], options);
    if (preciseSubjects) {
      expect(withHub, changedPath).not.toBeNull();
    }
    const withHubFiles = withHub
      ? selectedFiles(withHub)
      : fallbackFiles(["tsconfig.json", changedPath]);
    expect(withHubFiles, changedPath).toContain(target);
    expect(withHubFiles).not.toContain(
      "extensions/acpx/src/runtime-advertised-model.process.test.ts",
    );
  },
);

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
  expect(shards).toContainEqual(
    expect.objectContaining({
      checkName: "checks-node-changed-boundary",
      configs: ["test/vitest/vitest.boundary.config.ts"],
    }),
  );
  const withDeleted = createChangedNodeTestShards([helper, "src/deleted-unowned-source.ts"]);
  expect(withDeleted).not.toBeNull();
  expect(selectedFiles(withDeleted)).toEqual(
    expect.arrayContaining(["src/gateway/client-callsites.guard.test.ts"]),
  );
  expect(selectedFiles(withDeleted)).not.toContain(
    "extensions/acpx/src/runtime-advertised-model.process.test.ts",
  );
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

it("keeps UI and core changes with exact owners and direct consumers", () => {
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
  const targets = selectedFiles(shards);
  expect(targets).toEqual(
    expect.arrayContaining([
      "ui/src/components/markdown-file-links.test.ts",
      "ui/src/app/control-ui-chunking.test.ts",
      "ui/src/app/vite-config.node.test.ts",
      "src/agents/live-model-filter.test.ts",
      "src/agents/live-model-dynamic-candidates.test.ts",
      "src/agents/live-target-matcher.test.ts",
      "src/agents/model-compat.test.ts",
      "test/scripts/pr-worktree-provision.test.ts",
    ]),
  );
  // These whole-UI and transitive consumers belonged to the old broad fallback.
  for (const unrelated of [
    "test/ui.presenter-next-run.test.ts",
    "test/talk-browser-defaults.test.ts",
    "src/audit/execution-decision-facts.test.ts",
    "src/auto-reply/reply/commands-export-session.test.ts",
    "src/gateway/server-methods/session-change-event.fallback.test.ts",
    "test/scripts/pr-merge-recovery.test.ts",
    "test/scripts/mobile-release-ci.test.ts",
  ]) {
    expect(targets, unrelated).not.toContain(unrelated);
  }
  expect(new Set(targets).size).toBe(targets.length);
  expect(new Set(shards?.map((shard) => shard.checkName)).size).toBe(shards?.length);
  expect(
    targets
      .filter(isReleaseOnlyRuntimeTestFile)
      .every((file) => PR_PROTECTED_RUNTIME_TEST_FILES.includes(file)),
  ).toBe(true);
  expect(shards?.some((shard) => shard.requiresDist)).toBe(false);
  const placement = vi.spyOn(testTimings, "readRuntimePlacementTimings").mockReturnValue([]);
  let canonical: CompactNodeTestShard[];
  let selectedCanonical: CompactNodeTestShard[];
  try {
    canonical = createNodeTestShardBundles({
      compactMode: "pull-request",
      runnerBackend: "hybrid",
      includeReleaseOnlyPluginShards: false,
      includeReleaseOnlyToolingShards: true,
      includeProofTests: false,
      includeReleaseOnlyRuntimeTests: true,
      // Match the focused selector's admitted owner inventory before comparing resources.
      includePrExemptRuntimeTests: true,
    });
    selectedCanonical = expectDefined(
      createSelectedNodeTestShardBundles(
        (shards ?? []).flatMap(
          (job) => job.groups?.flatMap((group) => group.includePatterns ?? []) ?? [],
        ),
        {
          runnerBackend: options.runnerBackend,
          includeReleaseOnlyRuntimeTests: true,
          includePrExemptRuntimeTests: true,
        },
      ),
      "canonical selected UI consumer owners",
    );
  } finally {
    placement.mockRestore();
  }
  // Precise tooling is repacked without unrelated compiler fixtures whose full
  // inventory promotes their shared job. Compare against the same selected owner.
  const toolingTargets = (shards ?? []).flatMap((job) =>
    (job.groups ?? []).flatMap((group) =>
      group.configs.includes("test/vitest/vitest.tooling.config.ts")
        ? (group.includePatterns ?? [])
        : [],
    ),
  );
  const canonicalTooling = expectDefined(
    createSelectedNodeTestShardBundles(toolingTargets, {
      runnerBackend: "hybrid",
      includeReleaseOnlyRuntimeTests: true,
      includePrExemptRuntimeTests: true,
    }),
    "canonical selected tooling owners",
  );
  for (const job of shards ?? []) {
    for (const group of job.groups ?? []) {
      const owners = group.configs.includes("test/vitest/vitest.tooling.config.ts")
        ? canonicalTooling
        : canonical;
      const { group: owner } = canonicalOwner(owners, group.shard_name);
      if (group.includePatterns) {
        expect(group.includePatterns.length).toBeGreaterThan(0);
      } else {
        expect(group).toEqual(owner);
      }
      expect(group.configs.every((config) => owner.configs.includes(config))).toBe(true);
      // Tooling capacity follows selected files; an excluded compiler can require a larger full job.
      const { job: selectedJob, group: selectedGroup } = canonicalOwner(
        selectedCanonical,
        group.shard_name,
      );
      for (const key of [
        "configs",
        "env",
        "runner",
        "fallbackMaxWorkers",
        "minTotalMemoryBytes",
        "pretestBuildMode",
        "requiresDist",
      ] as const) {
        expect(group[key], `${group.shard_name} group ${key}`).toEqual(selectedGroup[key]);
      }
      for (const key of [
        "env",
        "runner",
        "planConcurrency",
        "pretestBuildMode",
        "requiresDist",
        "timeoutMinutes",
      ] as const) {
        expect(job[key], `${group.shard_name} job ${key}`).toEqual(selectedJob[key]);
      }
    }
  }
  expect(createChangedNodeTestShards([paths[1]!, "ui/src/AGENTS.md"], options)).toEqual(
    createChangedNodeTestShards([paths[1]!], options),
  );
  for (const hub of ["package.json", "tsconfig.json"]) {
    const withHub = createChangedNodeTestShards([...paths, hub], options);
    expect(withHub).not.toBeNull();
    expect(selectedFiles(withHub)).toEqual(expect.arrayContaining(targets));
    expect(selectedFiles(withHub)).not.toContain(
      "extensions/acpx/src/runtime-advertised-model.process.test.ts",
    );
  }
});

it("adds the fixed smoke once to narrow, hub, and directly edited smoke plans", () => {
  const smoke = [
    "test/gateway-rpc-exporters.test.ts",
    "src/config/io.load-async.test.ts",
    "src/config/io.compat.test.ts",
    "src/config/utility-model-separation-migration.io.test.ts",
    "src/plugins/loader.runtime-registry.test.ts",
    "test/qa-channel-message-tool-delivery.test.ts",
  ];
  for (const changedPaths of [
    ["src/infra/retry.test.ts"],
    ["tsconfig.json"],
    ["test/gateway-rpc-exporters.test.ts"],
  ]) {
    const shards = createChangedNodeTestShards(changedPaths, {
      includePrExemptRuntimeTests: false,
      includeReleaseOnlyRuntimeTests: false,
      dedicatedBuildArtifacts: false,
    });
    expect(shards).not.toBeNull();
    const files = selectedFiles(shards);
    for (const target of smoke) {
      expect(
        files.filter((file) => file === target),
        target,
      ).toHaveLength(1);
    }
    expect(files).not.toContain("extensions/acpx/src/runtime-advertised-model.process.test.ts");
    expect(shards?.every((shard) => (shard.predictedSeconds ?? 0) <= 300)).toBe(true);
  }
});

it("keeps new-plugin, core, and manifest changes within the complete PR matrix cap", () => {
  // Exact changed set from PR #159879, whose preflight originally emitted 134 rows.
  const changedPaths = [
    ".github/labeler.yml",
    "docs/.generated/config-baseline.counts.json",
    "docs/.generated/config-baseline.sha256",
    "docs/.i18n/glossary.zh-CN.json",
    "docs/channels/slack.md",
    "docs/cli/transcripts.md",
    "docs/docs.json",
    "docs/plugins/meeting-plugins.md",
    "docs/plugins/plugin-inventory.md",
    "docs/plugins/reference.md",
    "docs/plugins/reference/slack-huddles.md",
    "docs/plugins/sdk-runtime.md",
    "docs/plugins/slack-huddles.md",
    "extensions/slack-huddles/README.md",
    "extensions/slack-huddles/cli-metadata.ts",
    "extensions/slack-huddles/index.ts",
    "extensions/slack-huddles/openclaw.plugin.json",
    "extensions/slack-huddles/package.json",
    "extensions/slack-huddles/src/cli-output-mode.ts",
    "extensions/slack-huddles/src/cli.ts",
    "extensions/slack-huddles/src/config.test.ts",
    "extensions/slack-huddles/src/config.ts",
    "extensions/slack-huddles/src/errors.ts",
    "extensions/slack-huddles/src/node-host.ts",
    "extensions/slack-huddles/src/node-invoke-policy.test.ts",
    "extensions/slack-huddles/src/node-invoke-policy.ts",
    "extensions/slack-huddles/src/runtime-probes.ts",
    "extensions/slack-huddles/src/runtime-setup.ts",
    "extensions/slack-huddles/src/runtime.ts",
    "extensions/slack-huddles/src/transports/chrome.ts",
    "extensions/slack-huddles/src/transports/slack-huddles-page-scripts.ts",
    "extensions/slack-huddles/src/transports/slack-huddles-platform-adapter.audio.test.ts",
    "extensions/slack-huddles/src/transports/slack-huddles-platform-adapter.test-helpers.ts",
    "extensions/slack-huddles/src/transports/slack-huddles-platform-adapter.test.ts",
    "extensions/slack-huddles/src/transports/slack-huddles-platform-adapter.ts",
    "extensions/slack-huddles/src/transports/slack-huddles-selectors.ts",
    "extensions/slack-huddles/src/transports/slack-huddles-status-call-source.ts",
    "extensions/slack-huddles/src/transports/slack-huddles-status-prejoin-source.ts",
    "extensions/slack-huddles/src/transports/slack-huddles-urls.test.ts",
    "extensions/slack-huddles/src/transports/slack-huddles-urls.ts",
    "extensions/slack-huddles/src/transports/types.ts",
    "extensions/slack-huddles/tsconfig.json",
    "package.json",
    "pnpm-lock.yaml",
    "scripts/generate-plugin-inventory-doc.mts",
    "scripts/lib/official-external-plugin-catalog.json",
    "src/meeting-bot/status-call-ownership-source.ts",
    "src/meeting-bot/status-call-source.test.ts",
    "src/meeting-bot/status-call-source.ts",
    "src/plugins/bundled-plugin-metadata.test.ts",
    "src/plugins/official-external-meeting-catalog.test.ts",
    "src/plugins/official-external-plugin-catalog.test.ts",
    "test/scripts/bundled-plugin-build-entries.test.ts",
  ];
  const shards = expectDefined(
    createChangedNodeTestShards(changedPaths, {
      runnerBackend: "hybrid",
      compactNodeJobCap: 130,
      dedicatedCoreTypeChecks: true,
      dedicatedBuildArtifacts: false,
      includeReleaseOnlyToolingShards: false,
      includeReleaseOnlyRuntimeTests: false,
      includePrExemptRuntimeTests: false,
      dedicatedUiE2e: true,
      dedicatedUiTests: true,
    }),
    "new plugin and global-input owner plan",
  );
  expect(shards.filter((shard) => !shard.requiresDist).length).toBeLessThanOrEqual(130);
  expect(new Set(shards.map((shard) => shard.checkName)).size).toBe(shards.length);
  const files = selectedFiles(shards);
  expect(files).toContain("src/plugins/official-external-plugin-catalog.test.ts");
  // Global inputs keep protection for suites split out of protected owners.
  for (const split of [
    "src/cli/run-main.bare-root.test.ts",
    "src/cli/run-main.command-dispatch.test.ts",
    "src/cli/run-main.gateway-startup.test.ts",
    "src/plugins/official-external-plugin-catalog.hosted.test.ts",
  ]) {
    expect(files, split).toContain(split);
  }
  expect(files).toContain("src/plugins/bundled-plugin-metadata.test.ts");
  expect(files).toContain("test/scripts/bundled-plugin-build-entries.test.ts");
  expect(shards.some((shard) => shard.checkName.startsWith("checks-node-changed-extensions"))).toBe(
    true,
  );
  expect(
    shards.some((shard) => shard.configs.includes("test/vitest/vitest.boundary.config.ts")),
  ).toBe(true);
});
