import { spawnSync } from "node:child_process";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import {
  createChangedNodeTestShards,
  hasControlUiPerformanceAffectingChange,
} from "../../scripts/lib/ci-changed-node-test-plan.mts";
import {
  createNodeTestShardBundles,
  createSelectedNodeTestShardBundles,
  createUiTestShardGroups,
  resolveCanonicalNodeTestConfig,
  type CompactNodeTestShard,
} from "../../scripts/lib/ci-node-test-plan.mts";
import {
  isReleaseOnlyRuntimeTestFile,
  listPrExemptRuntimeTestFiles,
  PR_PROTECTED_RUNTIME_TEST_FILES,
} from "../../scripts/lib/ci-proof-test-inventory.mts";
import * as testTimings from "../../scripts/lib/ci-test-timings.mts";
import {
  createExtensionTestShards,
  DEFAULT_EXTENSION_TEST_SHARD_COUNT,
} from "../../scripts/lib/extension-test-plan.mts";
import { buildVitestRunPlans } from "../../scripts/test-projects.test-support.mts";
import { intersectIncludePatterns } from "../vitest/vitest.include-patterns.js";
import { isUiTestTarget } from "../vitest/vitest.ui-paths.mjs";

type PlannedTestOwner = {
  configs: readonly string[];
  includePatterns?: readonly string[];
};

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

it("retains every PR-exempt file in hourly and release plans with its canonical owner", () => {
  const prExemptFiles = listPrExemptRuntimeTestFiles();
  expect(prExemptFiles.length).toBeGreaterThan(0);
  const common = {
    runnerBackend: "github",
    includeReleaseOnlyPluginShards: false,
    includeReleaseOnlyRuntimeTests: false,
  };
  const pr = expectDefined(
    createChangedNodeTestShards(["src/infra/retry.test.ts"], {
      ...common,
      includePrExemptRuntimeTests: false,
      includeReleaseOnlyToolingShards: false,
    }),
    "unrelated PR owner plan",
  );
  // Plugin Prerelease owns the same full extension inventory on its hourly
  // schedule and as Full Release Validation's exact-target child, including
  // manifest-only plugins through the same discovery owner.
  const extensionGroups = createExtensionTestShards({
    shardCount: DEFAULT_EXTENSION_TEST_SHARD_COUNT,
  }).flatMap((shard) => shard.planGroups);
  // Discover in the same Node context as the prerelease planner, without the
  // parent Vitest invocation's file filter or transformed config module graph.
  const discovery = spawnSync(
    process.execPath,
    [
      "--import",
      "./scripts/tsx.mjs",
      "--input-type=module",
      "-e",
      `
      import { globSync } from "node:fs";
      import path from "node:path";
      import { pathToFileURL } from "node:url";
      const files = {};
      const projects = {};
      for (const config of JSON.parse(process.argv[1])) {
        const module = await import(pathToFileURL(path.resolve(config)).href);
        const root = config === "test/vitest/vitest.ui-e2e.config.ts"
          ? module.createUiE2eVitestConfig({ ...process.env, OPENCLAW_UI_E2E_SKIP_REAL_GATEWAY: "1" }, [])
          : module.default;
        projects[config] = (root.test.projects ?? [root]).map(project => {
          if (!project || typeof project !== "object" || !project.test) {
            throw new Error("Unsupported inline test project in " + config);
          }
          const test = project.test;
          const cwd = test.dir ?? test.root ?? project.root ?? root.test.dir ?? root.test.root ?? root.root ?? process.cwd();
          const exclude = (test.exclude ?? []).map(pattern => path.isAbsolute(pattern) ? path.relative(cwd, pattern).split(path.sep).join("/") : pattern);
          return {
            name: test.name,
            files: globSync(test.include ?? [], { cwd, exclude }).map(file => path.relative(process.cwd(), path.resolve(cwd, file)).split(path.sep).join("/")),
          };
        });
        files[config] = [...new Set(projects[config].flatMap(project => project.files))];
      }
      process.stdout.write(JSON.stringify({ files, projects }));
    `,
      JSON.stringify([
        ...new Set([
          ...extensionGroups.map((group) => group.config),
          "ui/vitest.config.ts",
          "test/vitest/vitest.ui-browser.config.ts",
          "test/vitest/vitest.ui-e2e.config.ts",
        ]),
      ]),
    ],
    {
      encoding: "utf8",
      env: { ...process.env, OPENCLAW_VITEST_INCLUDE_FILE: undefined },
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  expect(discovery.status, discovery.stderr).toBe(0);
  const discovered: {
    files: Record<string, string[]>;
    projects: Record<string, Array<{ name: string; files: string[] }>>;
  } = JSON.parse(discovery.stdout);
  const configFiles = discovered.files;
  const retainedExtensionGroups = extensionGroups.map((group) => ({
    configs: [group.config],
    includePatterns: expectDefined(configFiles[group.config], group.config).filter((file) =>
      group.roots.some((root) => file === root || file.startsWith(`${root}/`)),
    ),
  }));
  const hourly = createNodeTestShardBundles({
    ...common,
    compactMode: "pull-request",
    includePrExemptRuntimeTests: true,
    includeReleaseOnlyToolingShards: true,
    includeProofTests: true,
    compactNodeJobCap: 77,
  });
  const release = createNodeTestShardBundles({
    ...common,
    includeReleaseOnlyRuntimeTests: true,
    includePrExemptRuntimeTests: true,
    includeReleaseOnlyToolingShards: true,
  });
  const uiPr = createUiTestShardGroups({ includePrExemptRuntimeTests: false });
  const uiHourly = createUiTestShardGroups({ includeReleaseOnlyTests: false });
  const uiRelease = createUiTestShardGroups();
  const uiProjects = expectDefined(
    discovered.projects["ui/vitest.config.ts"],
    "UI package projects",
  );
  const browserFiles = expectDefined(
    configFiles["test/vitest/vitest.ui-browser.config.ts"],
    "native Chromium config inventory",
  );
  expect(uiProjects.find((project) => project.name === "browser")?.files.toSorted()).toEqual(
    browserFiles.toSorted(),
  );
  const dedicatedGroups = (plan: ReturnType<typeof createUiTestShardGroups>) => {
    const projectGroups = (config: string, groups: typeof plan.ui) =>
      expectDefined(discovered.projects[config], config).map((project) => ({
        configs: [config],
        includePatterns: project.files.filter((file) =>
          groups.some((group) => !group.includePatterns || group.includePatterns.includes(file)),
        ),
      }));
    const ui = projectGroups("ui/vitest.config.ts", plan.ui);
    const e2e = projectGroups("test/vitest/vitest.ui-e2e.config.ts", plan.e2e);
    const browser = {
      configs: ["test/vitest/vitest.ui-browser.config.ts"],
      includePatterns: browserFiles.filter((file) =>
        plan.ui.some((group) => !group.includePatterns || group.includePatterns.includes(file)),
      ),
    };
    return { ui, e2e, canonical: [browser, ...e2e] };
  };
  const prUiOwners = dedicatedGroups(uiPr);
  const hourlyUiOwners = dedicatedGroups(uiHourly);
  const releaseUiOwners = dedicatedGroups(uiRelease);
  expect(hourly.filter((job) => !job.requiresDist).length).toBeLessThanOrEqual(77);
  // Node retains canonical jsdom ownership. The UI package independently runs
  // those projects; native Chromium and mocked E2E have dedicated owners only.
  const projectNodeOwners = (jobs: NonNullable<ReturnType<typeof createChangedNodeTestShards>>) =>
    jobs.flatMap<PlannedTestOwner>((shard) =>
      shard.targets
        ? shard.targets.flatMap((file) =>
            buildVitestRunPlans([file]).map((plan) => ({
              configs: [resolveCanonicalNodeTestConfig(file, plan.config) ?? plan.config],
              includePatterns: [file],
            })),
          )
        : fallbackGroups([shard]),
    );
  const prGroups = [...projectNodeOwners(pr), ...prUiOwners.canonical];
  const changedPr = expectDefined(
    createChangedNodeTestShards(prExemptFiles, {
      ...common,
      includePrExemptRuntimeTests: false,
      includeReleaseOnlyToolingShards: false,
      dedicatedUiTests: true,
      dedicatedUiE2e: true,
    }),
    "directly edited PR-exempt owner plan",
  );
  const changedUiOwners = dedicatedGroups(
    createUiTestShardGroups({
      includeReleaseOnlyTests: false,
      includePrExemptRuntimeTests: false,
      changedPaths: prExemptFiles,
    }),
  );

  const hourlyGroups = [
    ...hourly.flatMap((job) => job.groups),
    ...retainedExtensionGroups,
    ...hourlyUiOwners.canonical,
  ];
  const releaseGroups = [
    ...fallbackGroups(release),
    ...retainedExtensionGroups,
    ...releaseUiOwners.canonical,
  ];
  const configsByFile = new Map(
    prExemptFiles.map((file) => {
      const rawConfig = expectDefined(buildVitestRunPlans([file])[0]?.config, file);
      return [file, resolveCanonicalNodeTestConfig(file, rawConfig) ?? rawConfig];
    }),
  );
  const indexOwners = (groups: readonly PlannedTestOwner[]) => {
    const owners = new Map<string, PlannedTestOwner[]>();
    for (const group of groups) {
      const candidates = prExemptFiles.filter((file) =>
        group.configs.includes(expectDefined(configsByFile.get(file), file)),
      );
      const files = group.includePatterns
        ? expectDefined(
            intersectIncludePatterns([...group.includePatterns], candidates, path.matchesGlob),
            group.configs.join(", "),
          )
        : candidates;
      for (const file of files) {
        const entries = owners.get(file) ?? [];
        entries.push(group);
        owners.set(file, entries);
      }
    }
    return owners;
  };
  const prOwners = indexOwners(prGroups);
  const changedPrOwners = indexOwners(projectNodeOwners(changedPr));
  // Dedicated UI executes its inline projects; preserve that handoff rather
  // than assigning its ordinary package projects to generic Node rows.
  for (const group of [...changedUiOwners.ui, ...changedUiOwners.e2e]) {
    for (const file of group.includePatterns) {
      if (!configsByFile.has(file)) {
        continue;
      }
      const entries = changedPrOwners.get(file) ?? [];
      entries.push(group);
      changedPrOwners.set(file, entries);
    }
  }
  const hourlyOwners = indexOwners(hourlyGroups);
  const releaseOwners = indexOwners(releaseGroups);
  for (const file of prExemptFiles) {
    const fixedSmokeOptIn = file === "src/config/utility-model-separation-migration.io.test.ts";
    expect(
      selectedFiles(pr).filter((target) => target === file),
      file,
    ).toHaveLength(fixedSmokeOptIn ? 1 : 0);
    expect(prOwners.get(file) ?? [], file).toHaveLength(fixedSmokeOptIn ? 1 : 0);
    expect(changedPrOwners.get(file)?.length ?? 0, file).toBeGreaterThan(0);
    expect(hourlyOwners.get(file) ?? [], file).toHaveLength(1);
    expect(releaseOwners.get(file) ?? [], file).toHaveLength(1);
    if (file.startsWith("ui/")) {
      const kind = isUiTestTarget(file) ? "ui" : "e2e";
      const selectedProjects = (groups: readonly { includePatterns: readonly string[] }[]) =>
        groups.filter((group) => group.includePatterns.includes(file));
      expect(selectedProjects(prUiOwners[kind]), file).toHaveLength(0);
      expect(selectedProjects(hourlyUiOwners[kind]), file).toHaveLength(1);
      expect(selectedProjects(releaseUiOwners[kind]), file).toHaveLength(1);
    }
  }
});

it("opts in a PR-exempt process proof for test and opaque subject edits beside hub inputs", () => {
  const target = "test/scripts/bench-gateway-installed.test.ts";
  const source = "scripts/bench-gateway-startup.ts";
  expect(listPrExemptRuntimeTestFiles()).toContain(target);
  const options = {
    runnerBackend: "github",
    includeReleaseOnlyRuntimeTests: false,
    includePrExemptRuntimeTests: false,
    includeReleaseOnlyToolingShards: false,
  };
  for (const changedPath of [target, source]) {
    const precise = createChangedNodeTestShards([changedPath], options);
    expect(precise, changedPath).not.toBeNull();
    expect(selectedFiles(precise), changedPath).toContain(target);
    const withHub = createChangedNodeTestShards(["tsconfig.json", changedPath], options);
    expect(withHub, changedPath).not.toBeNull();
    expect(selectedFiles(withHub), changedPath).toContain(target);
    expect(selectedFiles(withHub)).not.toContain(
      "extensions/acpx/src/runtime-advertised-model.process.test.ts",
    );
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
    ]),
  );
  // These whole-UI and transitive consumers belonged to the old broad fallback.
  for (const unrelated of [
    "test/ui.presenter-next-run.test.ts",
    "test/talk-browser-defaults.test.ts",
    "src/audit/execution-decision-facts.test.ts",
    "src/auto-reply/reply/commands-export-session.test.ts",
    "src/gateway/server-methods/session-change-event.fallback.test.ts",
    "test/scripts/pr-worktree-provision.test.ts",
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
      const ownerJob = expectDefined(
        owners.find((candidate) =>
          candidate.groups.some((owner) => owner.shard_name === group.shard_name),
        ),
        `canonical UI consumer job for ${group.shard_name}`,
      );
      const owner = expectDefined(
        ownerJob.groups.find((candidate) => candidate.shard_name === group.shard_name),
        "canonical UI consumer group",
      );
      if (group.includePatterns) {
        expect(group.includePatterns.length).toBeGreaterThan(0);
      } else {
        expect(group).toEqual(owner);
      }
      expect(group.configs.every((config) => owner.configs.includes(config))).toBe(true);
      // Tooling capacity follows selected files; an excluded compiler can require a larger full job.
      const selectedJob = expectDefined(
        selectedCanonical.find((candidate) =>
          candidate.groups.some((selected) => selected.shard_name === group.shard_name),
        ),
        `selected UI consumer job for ${group.shard_name}`,
      );
      const selectedGroup = expectDefined(
        selectedJob.groups.find((selected) => selected.shard_name === group.shard_name),
        "selected UI consumer group",
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
  expect(files).toContain("src/plugins/bundled-plugin-metadata.test.ts");
  expect(files).toContain("test/scripts/bundled-plugin-build-entries.test.ts");
  expect(shards.some((shard) => shard.checkName.startsWith("checks-node-changed-extensions"))).toBe(
    true,
  );
  expect(
    shards.some((shard) => shard.configs.includes("test/vitest/vitest.boundary.config.ts")),
  ).toBe(true);
});
