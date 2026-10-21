import childProcess, { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveTestGitCommits } from "../../.github/actions/git-owner/test-prerequisites.mjs";
import { buildChildEnv, resolveShardPlans } from "../../scripts/ci-run-node-test-shard.mts";
import {
  createChangedNodeTestShards as createChangedNodeTestShardsWithSmoke,
  hasUiE2eAffectingChange,
} from "../../scripts/lib/ci-changed-node-test-plan.mts";
import { encodeNodeTestGroups } from "../../scripts/lib/ci-node-test-groups-codec.mts";
import {
  createNodeTestShardBundles,
  createSelectedNodeTestShardBundles,
  isRuntimeTestFileIncluded,
  type CompactNodeTestShard,
} from "../../scripts/lib/ci-node-test-plan.mts";
import {
  CI_PROOF_TEST_FILES,
  PR_PROTECTED_RUNTIME_TEST_FILES,
  isCiProofTestFile,
} from "../../scripts/lib/ci-proof-test-inventory.mts";
import { refitTestTimings } from "../../scripts/lib/ci-test-timings-refit.mts";
import * as testTimings from "../../scripts/lib/ci-test-timings.mts";
import { listExtensionTestFilesForRoots } from "../../scripts/lib/extension-test-plan.mts";
import * as buildPrerequisites from "../../scripts/lib/vitest-build-prerequisites.mts";
import * as testProjects from "../../scripts/test-projects.test-support.mts";
import {
  buildVitestRunPlans,
  hasImportGraphConsumers,
  hasImportGraphImpactOnTargets,
  resolveAffectedTestsFromImportGraph,
  resolveChangedTestTargetPlan,
} from "../../scripts/test-projects.test-support.mts";
import { listGitTrackedFiles } from "../../src/test-utils/repo-files.js";
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
  expectProtectedOwnerExpansion,
} from "./ci-changed-node-test-plan.test-support.js";

const argvTempDirs = useAutoCleanupTempDirTracker(afterEach);

function writeFiles(cwd: string, files: Record<string, string>) {
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    writeFileSync(path.join(cwd, file), source);
  }
}

function canonicalOwner(jobs: CompactNodeTestShard[], shardName: string) {
  const job = expectDefined(
    jobs.find((candidate) => candidate.groups.some((group) => group.shard_name === shardName)),
    `canonical job for ${shardName}`,
  );
  return {
    job,
    group: expectDefined(
      job.groups.find((group) => group.shard_name === shardName),
      "canonical group",
    ),
  };
}

function expectSameFields<K extends PropertyKey>(
  actual: Partial<Record<K, unknown>>,
  expected: Partial<Record<K, unknown>>,
  keys: readonly K[],
) {
  for (const key of keys) {
    expect(actual[key], String(key)).toEqual(expected[key]);
  }
}

function targetOwner(shards: ReturnType<typeof createChangedNodeTestShards>, target: string) {
  const job = expectDefined(
    shards?.find((shard) => selectedFiles([shard]).includes(target)),
    `job for ${target}`,
  );
  const group = job.groups?.find((candidate) => candidate.includePatterns?.includes(target));
  const entry = group
    ? { kind: "group" as const, name: group.shard_name, plan: group }
    : { kind: "target" as const, name: target, target };
  return { job, group, owner: group ?? job, entry };
}

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

it("keeps activity unit changes narrow alongside root package metadata", () => {
  expect(hasUiE2eAffectingChange(["ui/src/pages/activity/activity-page.test.ts"])).toBe(false);
  expect(
    hasUiE2eAffectingChange(["ui/src/pages/activity/activity-page.test.ts", "package.json"]),
  ).toBe(false);
});

it.each([
  ["extensions/browser/chrome-extension/background.js", false],
  ["src/gateway/control-ui.ts", true],
  ["packages/gateway-protocol/src/schema/protocol-schemas.ts", true],
  ["src/gateway/cron-stream-matcher.worker.ts", false],
] as const)(
  "selects browser proof only for its owner or imported wire contract: %s",
  (file, expected) => {
    expect(hasUiE2eAffectingChange([file])).toBe(expected);
  },
);

it.each([
  ["src/gateway/control-ui.ts", true],
  ["packages/gateway-protocol/src/schema/protocol-schemas.ts", true],
  ["ui/src/e2e/control-ui-e2e-suite.test-support.ts", true],
  ["ui/src/e2e/settings-layout.e2e.test.ts", false],
] as const)(
  "selects real-Gateway tests through their source, fixture, and protocol owners: %s",
  (file, expected) => {
    expect(hasUiE2eAffectingChange([file], { family: "real-gateway" })).toBe(expected);
  },
);

it.each([
  ["ui/src/styles/chat.css", false],
  ["extensions/browser/chrome-extension/background.js", true],
  ["extensions/browser/src/browser/extension-install.ts", true],
  ["test/vitest/vitest.shared.config.ts", false],
] as const)(
  "selects the extension bootstrap through its source and shared owners: %s",
  (file, expected) => {
    expect(hasUiE2eAffectingChange([file], { family: "browser-extension" })).toBe(expected);
  },
);

it.each(
  [
    [],
    ["ui/src/pages/activity/deleted.test.ts"],
    ["ui/src/pages/activity/activity-page.test.ts", "ui/src/pages/activity/activity-page.ts"],
    ["ui/src/test-helpers/control-ui-e2e.test.ts"],
    ["ui/src/app/gateway-store.test-support.ts"],
    ["ui/src/styles/cursor-policy.browser.test.ts"],
    ["ui/src/pages/activity/../activity/activity-page.test.ts"],
  ].map((paths) => ({ paths })),
)("retains UI E2E for protected or unresolved inputs $paths", ({ paths }) => {
  expect(hasUiE2eAffectingChange(paths)).toBe(true);
});

it.each([
  ["ui/src/e2e/page.e2e.test.ts", true],
  ["ui/src/pages/page.ts", false],
  ["ui/.cache/vitest/generated.mjs", false],
] as const)("resolves UI E2E ownership for importer %s: %s", (consumer, expected) => {
  const cwd = argvTempDirs.make("openclaw-ui-unit-consumer-");
  const target = "ui/src/pages/unit.test.ts";

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
  ).toBe(!/\/(?:\.cache|\.artifacts|dist|node_modules)\//u.test(consumer));
  expect(hasUiE2eAffectingChange([target], { cwd })).toBe(expected);
});

it.each(["archive", "untracked", "symlink"])(
  "bounds UI E2E selection for %s unit inputs",
  (mode) => {
    const cwd = argvTempDirs.make("openclaw-ui-unit-inventory-");
    const target = "ui/src/unit.test.ts";

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
    expect(hasUiE2eAffectingChange([target], { cwd })).toBe(mode === "symlink");
  },
);

describe("CI changed Node test plan", () => {
  it("keeps the native warm cleanup proof in its extension release tier", () => {
    const source = "extensions/codex/src/app-server/thread-lifecycle-warm.ts";
    const native = "extensions/codex/src/app-server/thread-lifecycle.warm-cleanup.native.test.ts";
    const options = {
      includeReleaseOnlyRuntimeTests: false,
      selectionMode: "aggressive" as const,
    };
    // Explicit owner opt-ins remain intact; unselected automatic sweeps defer this tier.
    expect(isRuntimeTestFileIncluded(native, options)).toBe(false);
    expect(isRuntimeTestFileIncluded(native, { ...options, changedPaths: [native] })).toBe(true);

    for (const [changedPath, includeReleaseOnlyRuntimeTests] of [
      [native, false],
      [source, true],
    ] as const) {
      const admitted = createChangedNodeTestShards([changedPath], {
        ...options,
        includeReleaseOnlyRuntimeTests,
      });
      const owners = fallbackGroups(expectDefined(admitted, "native warm cleanup plan")).filter(
        (group) => group.includePatterns?.includes(native),
      );
      expect(owners, changedPath).toHaveLength(1);
      expect(owners[0]?.configs).toEqual([
        "test/vitest/vitest.extension-database-workers.config.ts",
      ]);
    }
  });

  it("retains changed-owner proof tiers and direct test opt-in without unrelated areas", () => {
    const cwd = argvTempDirs.make("changed-owner-proof-tiers-");
    const areaSource = "src/infra/owner-entry.ts";
    const ordinary = "src/infra/ordinary-owner.test.ts";
    const prExempt = "src/infra/device-bootstrap.test.ts";
    const releaseOnly = "src/infra/state-migrations.test.ts";
    const unrelated = "src/config/io.factory.test.ts";
    writeFiles(cwd, {
      [areaSource]: "export {};\n",
      [ordinary]: "export {};\n",
      [unrelated]: "export {};\n",
      [prExempt]: 'import "./exempt-subject.js";\n',
      [releaseOnly]: 'import "./release-subject.js";\n',
      "src/infra/exempt-subject.ts": "export {};\n",
      "src/infra/release-subject.ts": "export {};\n",
    });
    const options = {
      cwd,
      includePrExemptRuntimeTests: false,
      includeReleaseOnlyRuntimeTests: false,
    };
    const automatic = createChangedNodeTestShards([areaSource], options);
    expect(automatic).not.toBeNull();
    expect(selectedFiles(automatic).toSorted()).toEqual(
      [ordinary, prExempt, releaseOnly].toSorted(),
    );
    for (const [source, target] of [
      ["src/infra/exempt-subject.ts", prExempt],
      ["src/infra/release-subject.ts", releaseOnly],
    ] as const) {
      for (const changedPath of [source, target]) {
        const direct = createChangedNodeTestShards([changedPath], options);
        expect(direct, changedPath).not.toBeNull();
        expect(selectedFiles(direct).toSorted(), changedPath).toEqual(
          changedPath === target ? [target] : [ordinary, prExempt, releaseOnly].toSorted(),
        );
      }
    }
  });

  it.each(["pnpm-lock.yaml", "test/vitest/vitest.unknown-owner.config.ts"])(
    "keeps %s bounded to its direct consumers",
    (hub) => {
      const config = "test/vitest/vitest.commands.config.ts";
      const onFallback = vi.fn();
      const bounded = createChangedNodeTestShards([hub], { onFallback });
      expect(bounded).not.toBeNull();
      const configOwners = fallbackGroups(bounded ?? []).filter((group) =>
        group.configs.includes(config),
      );
      if (hub === "pnpm-lock.yaml") {
        expect(configOwners.length).toBeGreaterThan(0);
        expect(selectedFiles(bounded)).toContain(
          "src/commands/doctor-config-flow.session-store-owner.test.ts",
        );
        expect(
          configOwners
            .flatMap((group) => group.includePatterns ?? [])
            .every((file) => PR_PROTECTED_RUNTIME_TEST_FILES.includes(file)),
        ).toBe(true);
      } else {
        expect(configOwners).toHaveLength(0);
      }
      expect(selectedFiles(bounded)).not.toContain("src/infra/device-bootstrap.test.ts");
      expect(onFallback).not.toHaveBeenCalled();
    },
  );

  it("reuses a complete consumer graph until the tracked inventory changes", () => {
    const cwd = argvTempDirs.make("changed-cached-consumers-");
    const unshared = Array.from({ length: 40 }, (_, index) => `src/leaf-${index}.test.ts`);
    const files = {
      ...Object.fromEntries(unshared.map((file) => [file, "export {};\n"])),
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
    writeFiles(cwd, files);
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
        cwd,
        env: createNestedGitEnv(),
        stdio: "pipe",
      });
    git("init", "--quiet");
    git("add", ".");
    const options = { tooling: true, resolveAliases: true, runtimeOnly: true, forceFull: true };
    // A wide prefilter miss must not cache unrelated files as having no imports.
    expect(hasImportGraphConsumers(unshared, cwd, options)).toBe(false);
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
    const ordinary = "src/plugin-sdk/plugin-config-runtime.test.ts";
    const shards = createChangedNodeTestShards([...CI_PROOF_TEST_FILES, ordinary]);
    expect(shards).not.toBeNull();
    const files = selectedFiles(shards);
    expect(files).toContain(ordinary);
    expect(files.some(isCiProofTestFile)).toBe(false);
    const dedicatedProofs = [
      "src/gateway/gateway.sessions-send-recovery.test.ts",
      "test/scripts/doctor-config-preflight-plugin-index.built-cli.e2e.test.ts",
      "test/e2e/qa-lab/plugins/discord-show-widget-contextual-presenter.e2e.test.ts",
      "test/scripts/sqlite-sessions-transcripts-flip-proof.built-cli.e2e.test.ts",
    ];
    for (const changedPaths of [[...dedicatedProofs, ordinary], ["package.json"]]) {
      const protectedSelection = createChangedNodeTestShardsWithSmoke(changedPaths, {
        selectedTestTargets: [...dedicatedProofs, ordinary],
      });
      expect(protectedSelection).not.toBeNull();
      expect(selectedFiles(protectedSelection)).toContain(ordinary);
      for (const proof of dedicatedProofs) {
        expect(selectedFiles(protectedSelection), proof).not.toContain(proof);
      }
    }
  });

  it("keeps runtime proofs reached through the transitive helper graph", () => {
    const cwd = argvTempDirs.make("changed-runtime-proof-");
    const source = "src/infra/release-proof.ts";
    const helper = "src/infra/release-proof.test-support.ts";
    const deferred = "src/state/openclaw-database-preflight.lifecycle.test.ts";
    const ordinary = "src/plugin-sdk/plugin-config-runtime.test.ts";
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
    materializeGatewayCallsitesFixture(cwd);
    const options = { cwd, includeReleaseOnlyRuntimeTests: false };
    const helperPlan = createChangedNodeTestShards([helper], options);
    expect(helperPlan).not.toBeNull();
    expect(selectedFiles(helperPlan).toSorted()).toEqual([deferred].toSorted());
    expect(helperPlan).toContainEqual(
      expect.objectContaining({
        checkName: "checks-node-changed-boundary",
        configs: ["test/vitest/vitest.boundary.config.ts"],
      }),
    );
    const sourcePlan = createChangedNodeTestShards([source], options);
    expect(sourcePlan).not.toBeNull();
    expect(selectedFiles(sourcePlan).toSorted()).toEqual(
      [ordinary, deferred, gatewayCallsitesGuard].toSorted(),
    );
    for (const companion of [unknown, "src/infra/deleted.ts"]) {
      const mixed = createChangedNodeTestShards([helper, companion], options);
      expect(mixed).not.toBeNull();
      expect(selectedFiles(mixed)).toContain(gatewayCallsitesGuard);
      expect(selectedFiles(mixed)).not.toContain(companion);
    }
  });

  it.each(["blacksmith", "github", "hybrid"])(
    "retains runtime proof child policies when release-only proofs are disabled (%s)",
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
      expect(selectedFiles(selected).toSorted()).toEqual(
        [
          ...new Set([...targets, ...gitToolingTargets, "test/scripts/test-projects.test.ts"]),
        ].toSorted(),
      );
      for (const target of targets) {
        const original = targetOwner(before, target);
        const current = targetOwner(selected, target);
        expectSameFields(current.owner, original.owner, [
          "configs",
          "env",
          "requiresDist",
          "pretestBuildMode",
        ]);
        expect(current.group?.fallbackMaxWorkers).toBe(original.group?.fallbackMaxWorkers);
        expect(current.group?.minTotalMemoryBytes).toBe(original.group?.minTotalMemoryBytes);
        expect(buildChildEnv(current.entry, current.job.env ?? {}, envScratch, 0)).toEqual({
          ...buildChildEnv(original.entry, original.job.env ?? {}, envScratch, 0),
          // Repacking changes the label, but every execution policy stays fixed.
          ...(current.group ? { OPENCLAW_VITEST_SHARD_NAME: current.group.shard_name } : {}),
        });
        expectSameFields(current.job, original.job, [
          "runner",
          "requiresDist",
          "planConcurrency",
          "pretestBuildMode",
        ]);
      }
    },
  );

  it.each(["blacksmith", "github", "hybrid"])(
    "retains exact plugin selections in their canonical process owner without enabling the unrelated sweep (%s)",
    (runnerBackend) => {
      const pluginConfig = "test/vitest/vitest.plugins.config.ts";
      const targets = [
        "src/plugins/activation-planner.test.ts",
        "src/plugins/manifest-registry.test.ts",
        "src/infra/retry.test.ts",
      ];
      const selected = createSelectedNodeTestShardBundles(targets, {
        runnerBackend,
        preparedTestPlans: new Map(
          targets.map((target) => [target, buildVitestRunPlans([target])]),
        ),
      });
      expect(selected).not.toBeNull();
      const groups = selected?.flatMap((row) => row.groups) ?? [];
      expect(groups.flatMap((group) => group.includePatterns ?? []).toSorted()).toEqual(
        targets.toSorted(),
      );
      const pluginGroups = groups.filter((group) => group.configs.includes(pluginConfig));
      expect(pluginGroups.flatMap((group) => group.includePatterns ?? []).toSorted()).toEqual(
        targets.slice(0, 2).toSorted(),
      );
      for (const group of pluginGroups) {
        expect(group.requiresDist).toBe(false);
      }

      const unrelated = createNodeTestShardBundles({
        runnerBackend,
        compactMode: "pull-request",
        includeReleaseOnlyPluginShards: false,
        includeReleaseOnlyToolingShards: false,
      });
      expect(
        unrelated
          .flatMap((row) => row.groups ?? [row])
          .some((group) => group.configs.includes(pluginConfig)),
      ).toBe(false);
    },
  );

  it("routes each selected test once while retaining its canonical plugin coverage", () => {
    const targets = [
      "src/plugins/activation-planner.test.ts",
      "src/plugins/manifest-registry.test.ts",
      "src/infra/retry.test.ts",
    ];
    const routing = vi.spyOn(testProjects, "buildVitestRunPlans");
    try {
      const shards = createChangedNodeTestShardsWithSmoke(targets, {
        selectedTestTargets: targets,
        runnerBackend: "hybrid",
        includeReleaseOnlyRuntimeTests: true,
        includePrExemptRuntimeTests: true,
      });
      expect(shards).not.toBeNull();
      expect(selectedFiles(shards).toSorted()).toEqual(targets.toSorted());
      for (const target of targets) {
        expect(
          routing.mock.calls.filter(([args]) => args.length === 1 && args[0] === target),
          target,
        ).toHaveLength(1);
      }
    } finally {
      routing.mockRestore();
    }
  });

  it.each([
    "src/agents/model-fallback.reply-entry.e2e.test.ts",
    "src/auto-reply/reply/agent-runner.runreplyagent.e2e.test.ts",
    "src/agents/bash-tools.process.e2e.test.ts",
  ])("prepares the runtime for the executed E2E route of %s", (target) => {
    const shards = expectDefined(
      createChangedNodeTestShardsWithSmoke([target], { selectedTestTargets: [target] }),
      "changed E2E plan",
    );
    expect(selectedFiles(shards)).toEqual([target]);
    const row = expectDefined(
      shards.find((shard) => shard.targets?.includes(target)),
      "target row",
    );
    const plans = resolveShardPlans({
      OPENCLAW_NODE_TEST_TARGETS_JSON: JSON.stringify(row.targets),
    });
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ kind: "target", target });
    expect(buildVitestRunPlans([target]).map((plan) => plan.config)).toContain(
      "test/vitest/vitest.e2e.config.ts",
    );
    expect(row.pretestBuildMode).toBe("private-qa");
  });

  it("retains selected compact coverage when time splitting exceeds the non-dist matrix cap", async () => {
    const targets = [
      "test/scripts/ci-node-test-plan.test.ts",
      "test/scripts/ci-changed-node-test-plan.test.ts",
    ];
    const artifactTarget = "test/scripts/build-all.test.ts";
    const selectedTestTargets = [...targets, artifactTarget];
    const compact: CompactNodeTestShard = {
      checkName: "checks-node-changed-tooling",
      shardName: "changed-tooling",
      runner: "ubuntu-24.04",
      requiresDist: false,
      planConcurrency: 1,
      timeoutMinutes: 10,
      pretestBuildMode: "runtime",
      env: { OPENCLAW_VITEST_MAX_WORKERS: "2" },
      predictedSeconds: 200,
      predictedTestSeconds: 200,
      groups: [
        {
          shard_name: "core-tooling",
          configs: ["test/vitest/vitest.tooling.config.ts"],
          includePatterns: targets,
          runner: "ubuntu-24.04",
          env: { NODE_OPTIONS: "--max-old-space-size=4096" },
          fallbackMaxWorkers: 1,
          minTotalMemoryBytes: 8 * 1024 ** 3,
          requiresDist: false,
        },
      ],
    };
    const artifact: CompactNodeTestShard = {
      checkName: "checks-node-changed-build",
      shardName: "changed-build",
      runner: "ubuntu-24.04",
      requiresDist: true,
      predictedSeconds: 10,
      groups: [
        {
          shard_name: "core-build",
          configs: ["test/vitest/vitest.tooling.config.ts"],
          includePatterns: [artifactTarget],
          runner: "ubuntu-24.04",
          requiresDist: true,
        },
      ],
    };
    const selected = vi
      .spyOn(
        await import("../../scripts/lib/ci-node-test-plan.mts"),
        "createSelectedNodeTestShardBundles",
      )
      .mockReturnValue([compact, artifact]);
    const timing = vi
      .spyOn(testTimings, "readToolingFileTimings")
      .mockReturnValue(Object.fromEntries(targets.map((file) => [file, 100])));
    const groups = vi.spyOn(testTimings, "readCompactGroupTimings").mockReturnValue({});
    try {
      const split = createChangedNodeTestShardsWithSmoke(selectedTestTargets, {
        selectedTestTargets,
      });
      expect(split?.filter((shard) => !shard.requiresDist)).toHaveLength(2);
      expect(selectedFiles(split).toSorted()).toEqual(selectedTestTargets.toSorted());

      const capped = createChangedNodeTestShardsWithSmoke(selectedTestTargets, {
        selectedTestTargets,
        compactNodeJobCap: 1,
      });
      expect(capped?.filter((shard) => !shard.requiresDist)).toHaveLength(1);
      expect(capped).toEqual([
        { ...compact, configs: [] },
        { ...artifact, configs: [] },
      ]);
      expect(selectedFiles(capped).toSorted()).toEqual(selectedTestTargets.toSorted());

      // A dist descriptor does not consume the Node matrix budget.
      expect(
        createChangedNodeTestShardsWithSmoke(selectedTestTargets, {
          selectedTestTargets,
          compactNodeJobCap: 2,
        }),
      ).toEqual(split);
    } finally {
      groups.mockRestore();
      timing.mockRestore();
      selected.mockRestore();
    }
  });

  it("pays for heavy-row splits by merging compatible small rows before the matrix cap", async () => {
    const targets = [
      "test/scripts/ci-node-test-plan.test.ts",
      "test/scripts/ci-changed-node-test-plan.test.ts",
      "test/scripts/ci-run-timings.test.ts",
      "test/scripts/ci-test-timings.test.ts",
    ];
    const row = (name: string, files: string[], seconds: number): CompactNodeTestShard => ({
      checkName: `checks-node-changed-${name}`,
      shardName: `changed-${name}`,
      runner: "ubuntu-24.04",
      requiresDist: false,
      planConcurrency: 1,
      env: { OPENCLAW_VITEST_MAX_WORKERS: "2" },
      predictedSeconds: seconds,
      predictedTestSeconds: seconds,
      groups: [
        {
          shard_name: name,
          configs: ["test/vitest/vitest.tooling.config.ts"],
          includePatterns: files,
          runner: "ubuntu-24.04",
          requiresDist: false,
        },
      ],
    });
    const canonical = [
      row("core-tooling", targets.slice(0, 2), 200),
      row("core-tooling-small-a", [targets[2]!], 20),
      row("core-tooling-small-b", [targets[3]!], 20),
    ];
    const selected = vi
      .spyOn(
        await import("../../scripts/lib/ci-node-test-plan.mts"),
        "createSelectedNodeTestShardBundles",
      )
      .mockReturnValue(canonical);
    const timing = vi.spyOn(testTimings, "readToolingFileTimings").mockReturnValue({
      [targets[0]!]: 100,
      [targets[1]!]: 100,
      [targets[2]!]: 20,
      [targets[3]!]: 20,
    });
    const groups = vi.spyOn(testTimings, "readCompactGroupTimings").mockReturnValue({});
    try {
      const packed = expectDefined(
        createChangedNodeTestShardsWithSmoke(["src/index.ts"], {
          selectedTestTargets: targets,
          dedicatedBuildArtifacts: true,
          compactNodeJobCap: 3,
        }),
        "bounded changed plan",
      );
      expect(packed).toHaveLength(2);
      expect(packed.map((job) => job.predictedTestSeconds).toSorted((a, b) => a! - b!)).toEqual([
        100, 140,
      ]);
      expect(selectedFiles(packed).toSorted()).toEqual(targets.toSorted());
      expect(new Set(selectedFiles(packed)).size).toBe(targets.length);
      for (const target of targets) {
        expect(buildVitestRunPlans([target]).map((plan) => plan.config)).toEqual([
          "test/vitest/vitest.tooling.config.ts",
        ]);
      }
      expect(
        packed
          .flatMap((job) => job.groups ?? [])
          .filter((group) => group.shard_name.includes("small")),
      ).toEqual(canonical.slice(1).flatMap((job) => job.groups));
    } finally {
      groups.mockRestore();
      timing.mockRestore();
      selected.mockRestore();
    }
  });

  it.each([
    {},
    { env: { OPENCLAW_VITEST_MAX_WORKERS: "1" } },
    { runner: "blacksmith-8vcpu-ubuntu-2404" },
    { timeoutMinutes: 12 },
    { planConcurrency: 2 },
    { pretestBuildMode: "runtime" as const },
  ])("retains serial packing policy and complete child descriptors: %j", async (override) => {
    const targets = ["test/scripts/ci-run-timings.test.ts", "test/scripts/ci-test-timings.test.ts"];
    const canonical: CompactNodeTestShard[] = targets.map((target, index) => ({
      checkName: `checks-node-changed-tooling-${index}`,
      shardName: `changed-tooling-${index}`,
      runner: "ubuntu-24.04",
      requiresDist: false,
      planConcurrency: 1,
      timeoutMinutes: 10,
      env: { OPENCLAW_VITEST_MAX_WORKERS: "2" },
      predictedSeconds: 20,
      predictedTestSeconds: 20,
      groups: [
        {
          shard_name: `core-tooling-${index}`,
          configs: ["test/vitest/vitest.tooling.config.ts"],
          includePatterns: [target],
          runner: "ubuntu-24.04",
          requiresDist: false,
          env: { NODE_OPTIONS: `--max-old-space-size=${1024 * (index + 1)}` },
          fallbackMaxWorkers: index + 1,
          minTotalMemoryBytes: (index + 1) * 1024 ** 3,
        },
      ],
      ...(index === 1 ? override : {}),
    }));
    const selected = vi
      .spyOn(
        await import("../../scripts/lib/ci-node-test-plan.mts"),
        "createSelectedNodeTestShardBundles",
      )
      .mockReturnValue(canonical);
    try {
      const packed = expectDefined(
        createChangedNodeTestShardsWithSmoke(["src/index.ts"], {
          selectedTestTargets: targets,
          dedicatedBuildArtifacts: true,
        }),
        "policy-preserving changed plan",
      );
      expect(packed).toHaveLength(Object.keys(override).length === 0 ? 1 : 2);
      expect(packed.flatMap((job) => job.groups)).toEqual(canonical.flatMap((job) => job.groups));
      expect(selectedFiles(packed).toSorted()).toEqual(targets.toSorted());
      expect(new Set(selectedFiles(packed)).size).toBe(targets.length);
      for (const target of targets) {
        expect(buildVitestRunPlans([target]).map((plan) => plan.config)).toEqual([
          "test/vitest/vitest.tooling.config.ts",
        ]);
      }
      for (const source of canonical) {
        const owner = expectDefined(
          packed.find((job) => job.groups?.includes(source.groups[0]!)),
          "packed child owner",
        );
        expectSameFields(owner, source, [
          "runner",
          "timeoutMinutes",
          "planConcurrency",
          "pretestBuildMode",
          "env",
        ]);
      }
    } finally {
      selected.mockRestore();
    }
  });

  it("retains observed file floors before packing underestimated serial rows", async () => {
    const cases = [
      [
        "src/infra/update-managed-service-handoff-lifecycle.test.ts",
        "test/vitest/vitest.infra.config.ts",
        92,
      ],
      [
        "src/cli/update-cli/update-command-migrated.test.ts",
        "test/vitest/vitest.cli-process.config.ts",
        67,
      ],
    ] as const;
    const row = (name: string, config: string, files: string[]): CompactNodeTestShard => ({
      checkName: `checks-node-changed-${name}`,
      shardName: `changed-${name}`,
      runner: "ubuntu-24.04",
      requiresDist: false,
      planConcurrency: 1,
      env: { OPENCLAW_VITEST_MAX_WORKERS: "2" },
      predictedSeconds: 10,
      predictedTestSeconds: 10,
      groups: [
        {
          shard_name: name,
          configs: [config],
          includePatterns: files,
          runner: "ubuntu-24.04",
          requiresDist: false,
          env: { NODE_OPTIONS: "--max-old-space-size=4096" },
          fallbackMaxWorkers: 1,
          minTotalMemoryBytes: 8 * 1024 ** 3,
        },
      ],
    });
    const canonical = cases.map(([target, config], index) =>
      row(`floor-${index}`, config, [target]),
    );
    const selectedTestTargets = cases.map(([target]) => target);
    const planner = await import("../../scripts/lib/ci-node-test-plan.mts");
    // Isolate admission after canonical selection; broad routing has its own cases.
    const metadata = vi
      .spyOn(planner, "nodeTestConfigRequiresCanonicalMetadata")
      .mockReturnValue(true);
    const selected = vi
      .spyOn(planner, "createSelectedNodeTestShardBundles")
      .mockReturnValue(canonical);
    try {
      const packed = expectDefined(
        createChangedNodeTestShardsWithSmoke(["src/index.ts"], {
          selectedTestTargets,
          dedicatedBuildArtifacts: true,
        }),
        "broad serial floor plan",
      );
      const serialRows = packed.filter((job) => !job.requiresDist);
      expect(serialRows).toHaveLength(2);
      for (const [index, [target, config, seconds]] of cases.entries()) {
        expect(buildVitestRunPlans([target]).map((plan) => plan.config)).toEqual([config]);
        const owner = expectDefined(
          serialRows.find((job) => selectedFiles([job]).includes(target)),
          "file floor owner",
        );
        expect(owner.predictedTestSeconds).toBe(seconds);
        expect(owner.groups).toEqual(canonical[index]!.groups);
        expectSameFields(owner, canonical[index]!, ["runner", "env", "planConcurrency"]);
      }
      const files = selectedFiles(packed);
      expect(files.toSorted()).toEqual(selectedTestTargets.toSorted());
      expect(new Set(files).size).toBe(selectedTestTargets.length);
    } finally {
      selected.mockRestore();
      metadata.mockRestore();
    }
  });

  it("packs broad changed targets by execution policy without losing coverage", () => {
    const runtimeTargets = Array.from(
      { length: 4 },
      (_, i) => `src/infra/row-cap-runtime-${i}.test.ts`,
    );
    const e2eTargets = Array.from({ length: 4 }, (_, i) => `src/infra/row-cap-${i}.e2e.test.ts`);
    const serialTargets = Array.from(
      { length: 4 },
      (_, i) => `extensions/memory-core/row-cap-${i}.test.ts`,
    );
    const selectedTestTargets = [
      ...Array.from({ length: 1_000 }, (_, i) => `src/infra/row-cap-${i}.test.ts`),
      ...runtimeTargets,
      ...e2eTargets,
      ...serialTargets,
      serialTargets[0]!,
    ];
    const seconds = Object.fromEntries(selectedTestTargets.map((target) => [target, 20]));
    const plans = vi.spyOn(testProjects, "buildVitestRunPlans").mockImplementation((targets) => [
      {
        config: targets.some((target) => e2eTargets.includes(target))
          ? "test/vitest/vitest.e2e.config.ts"
          : "test/vitest/vitest.unit.config.ts",
        includePatterns: null,
        forwardedArgs: [...targets],
        watchMode: false,
      },
    ]);
    const buildMode = vi
      .spyOn(buildPrerequisites, "resolveVitestPretestBuildMode")
      .mockImplementation((selections) =>
        selections.some((selection) =>
          selection.includePatterns?.some((target) => runtimeTargets.includes(target)),
        )
          ? "runtime"
          : undefined,
      );
    const e2eTimings = vi.spyOn(testTimings, "readRepoE2eFileTimings").mockReturnValue(seconds);
    const toolingTimings = vi.spyOn(testTimings, "readToolingFileTimings").mockReturnValue({});
    try {
      const options = { selectedTestTargets };
      const original = expectDefined(
        createChangedNodeTestShardsWithSmoke(selectedTestTargets, options),
        "broad changed-target plan",
      );
      expect(original.filter((shard) => !shard.requiresDist).length).toBeGreaterThan(130);
      const packed = expectDefined(
        createChangedNodeTestShardsWithSmoke(selectedTestTargets, {
          ...options,
          compactNodeJobCap: 130,
        }),
        "packed changed-target plan",
      );
      expect(packed.filter((shard) => !shard.requiresDist)).toHaveLength(130);
      expect(selectedFiles(packed).toSorted()).toEqual(selectedTestTargets.toSorted());
      expect(packed.filter((shard) => !shard.targets)).toEqual(
        original.filter((shard) => !shard.targets),
      );
      const targetRows = packed.filter((shard) => shard.targets);
      // These three small policy partitions each need just one of the 129 target rows.
      expect(targetRows.filter((shard) => shard.pretestBuildMode)).toHaveLength(2);
      expect(targetRows.filter((shard) => shard.planConcurrency === 1)).toHaveLength(1);
      for (const [index, shard] of targetRows.entries()) {
        expect(shard).toMatchObject({
          checkName: `checks-node-changed-${index + 1}`,
          shardName: `changed-${index + 1}`,
          predictedSeconds: shard.targets!.length * 20,
        });
        for (const target of shard.targets!) {
          expect(shard.pretestBuildMode).toBe(
            e2eTargets.includes(target)
              ? "private-qa"
              : runtimeTargets.includes(target)
                ? "runtime"
                : undefined,
          );
          expect(shard.planConcurrency).toBe(serialTargets.includes(target) ? 1 : undefined);
        }
      }
      const ordinarySeconds = targetRows
        .filter((shard) => !shard.pretestBuildMode && !shard.planConcurrency)
        .map((shard) => shard.predictedSeconds!);
      expect(Math.max(...ordinarySeconds) - Math.min(...ordinarySeconds)).toBeLessThanOrEqual(20);
      expect(() =>
        createChangedNodeTestShardsWithSmoke(selectedTestTargets, {
          ...options,
          compactNodeJobCap: 3,
        }),
      ).toThrow("4 execution policies exceed the changed-target row budget of 2");
      // The boundary row already consumes this cap; leave rejection to the workflow.
      expect(
        createChangedNodeTestShardsWithSmoke(selectedTestTargets, {
          ...options,
          compactNodeJobCap: 1,
        }),
      ).toEqual(original);
      const small = selectedTestTargets.slice(0, 2);
      expect(
        createChangedNodeTestShardsWithSmoke(small, {
          selectedTestTargets: small,
          compactNodeJobCap: 130,
        }),
      ).toEqual(createChangedNodeTestShardsWithSmoke(small, { selectedTestTargets: small }));
    } finally {
      plans.mockRestore();
      buildMode.mockRestore();
      e2eTimings.mockRestore();
      toolingTimings.mockRestore();
    }
  });

  it.each(["blacksmith", "github", "hybrid"])(
    "retains precise process ownership and independent timing keys (%s)",
    (runnerBackend) => {
      const targets = [
        "src/agents/embedded-agent-runner/model-resolution-consistency.test.ts",
        "src/agents/embedded-agent-runner/run/attempt-transcript-helpers.presence.test.ts",
      ];
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
      const selected = expectDefined(
        createChangedNodeTestShards(targets, { runnerBackend }),
        "selected embedded plan",
      );
      expect(selectedFiles(selected).toSorted()).toEqual(targets.toSorted());
      for (const job of selected.filter((candidate) => candidate.groups)) {
        for (const group of job.groups ?? []) {
          const { job: ownerJob, group: owner } = canonicalOwner(full, group.shard_name);
          expect(group.env).toEqual(owner.env);
          expect(group.env?.OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS).toBe("660000");
          for (const target of group.includePatterns ?? []) {
            expect(group.configs).toEqual([buildVitestRunPlans([target])[0]?.config]);
          }
          expect(group.runner).toBe(owner.runner);
          expect(job.planConcurrency).toBe(
            job.groups?.length === 1 && ownerJob.planConcurrency === 2
              ? 1
              : ownerJob.planConcurrency,
          );
          for (const key of ["pretestBuildMode", "timeoutMinutes"] as const) {
            expect(job[key], key).toEqual(ownerJob[key]);
          }
          expect(job.predictedSeconds).toBeGreaterThan(0);
          expect(job.predictedSeconds).toBeLessThanOrEqual(300);
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
        }
      }
      expect(selected.filter((shard) => !shard.groups)).toEqual([
        expect.objectContaining({
          configs: ["test/vitest/vitest.boundary.config.ts"],
          requiresDist: false,
        }),
      ]);
      expect(selected.some((shard) => shard.requiresDist)).toBe(false);
      const acp = "src/acp/control-plane/manager.accepted-controls.test.ts";
      const logging = "src/logging/logger-file-transport.test.ts";
      const processTest = "src/process/exec.test.ts";
      for (const { targets: ownerTargets, configs } of [
        { targets: [acp], configs: ["test/vitest/vitest.acp.config.ts"] },
        {
          targets: ["src/gateway/setup-inference.first-signin.integration.test.ts"],
          configs: ["test/vitest/vitest.gateway-server-isolated.config.ts"],
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
        const ownerSelection = expectDefined(
          createSelectedNodeTestShardBundles(ownerTargets, { runnerBackend }),
          "precise multi-config owner selection",
        );
        if (ownerTargets.includes("src/gateway/setup-inference.first-signin.integration.test.ts")) {
          expect(ownerSelection).toEqual([expect.objectContaining({ planConcurrency: 1 })]);
        }
        expect(
          ownerSelection
            .flatMap((job) => job.groups.flatMap((group) => group.includePatterns ?? []))
            .toSorted(),
        ).toEqual(ownerTargets.toSorted());
        expect(
          ownerSelection.flatMap((job) => job.groups.flatMap((group) => group.configs)).toSorted(),
        ).toEqual(configs.toSorted());
        for (const job of ownerSelection) {
          for (const group of job.groups) {
            const { job: ownerJob, group: owner } = canonicalOwner(full, group.shard_name);
            expectSameFields(group, owner, [
              "env",
              "fallbackMaxWorkers",
              "minTotalMemoryBytes",
              "pretestBuildMode",
            ]);
            const singleton = job.groups.length === 1 && ownerJob.planConcurrency === 2;
            expect(job.planConcurrency).toBe(singleton ? 1 : ownerJob.planConcurrency);
            expect(job.env).toEqual(
              singleton && owner.env?.OPENCLAW_VITEST_MAX_WORKERS === undefined
                ? { ...ownerJob.env, OPENCLAW_VITEST_MAX_WORKERS: "2" }
                : ownerJob.env,
            );
            expectSameFields(job, ownerJob, ["runner", "timeoutMinutes"]);
          }
        }
      }
    },
  );

  it.each(["blacksmith", "github", "hybrid"])(
    "retains the complete built TUI process owner for precise selections (%s)",
    (runnerBackend) => {
      const targets = ["src/tui/tui-pty-local.e2e.test.ts", "src/tui/tui-pty-harness.e2e.test.ts"];
      const full = createNodeTestShardBundles({
        compactMode: "pull-request",
        runnerBackend,
        includeReleaseOnlyPluginShards: false,
      });
      const { job, group: owner } = canonicalOwner(full, "core-runtime-tui-pty");
      expect(owner).toMatchObject({
        configs: ["test/vitest/vitest.tui-pty.config.ts"],
        env: { OPENCLAW_TUI_PTY_INCLUDE_LOCAL: "1", OPENCLAW_TUI_PTY_USE_BUILT_CLI: "1" },
        requiresDist: true,
      });
      expect(owner.includePatterns).toBeUndefined();
      expect(createSelectedNodeTestShardBundles(targets, { runnerBackend })).toEqual([
        {
          ...job,
          checkName: `checks-node-changed-${job.shardName}`,
          shardName: `changed-${job.shardName}`,
          groups: [owner],
        },
      ]);
      const changed = expectDefined(
        createChangedNodeTestShards(targets, { runnerBackend }),
        "changed TUI plan",
      );
      expect(
        changed
          .flatMap((candidate) => candidate.groups ?? [])
          .filter((group) => group.requiresDist),
      ).toEqual([owner]);
      const changedJob = expectDefined(
        changed.find((candidate) => candidate.requiresDist),
        "changed TUI job",
      );
      for (const key of [
        "env",
        "runner",
        "planConcurrency",
        "pretestBuildMode",
        "timeoutMinutes",
      ] as const) {
        expect(changedJob[key], key).toEqual(job[key]);
      }
      expect(
        fallbackGroups(changed.filter((candidate) => !candidate.requiresDist)).flatMap(
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
      expectCanonicalGroupedConcurrency(shards, runnerBackend);
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
          expect(shard.runner).toBe("blacksmith-16vcpu-ubuntu-2404");
        }
      }
      expect(new Set((shards ?? []).flatMap(resolveTestGitCommits))).toEqual(
        new Set(expectedTargets.flatMap((target) => resolveTestGitCommits({ targets: [target] }))),
      );
    },
  );

  it("retains ordinary and embedded targets beside a shared Git fixture's canonical family", () => {
    const ordinary = "src/plugin-sdk/plugin-config-runtime.test.ts";
    const embedded =
      "src/agents/embedded-agent-runner/run/attempt-transcript-helpers.presence.test.ts";
    const shards = createChangedNodeTestShards([
      "test/scripts/ci-git-owner.test-support.ts",
      ordinary,
      embedded,
    ]);
    expect(shards).not.toBeNull();
    expectProtectedOwnerExpansion(
      shards,
      [ordinary, "test/scripts/ci-git-prerequisites.test.ts", ...gitToolingTargets, embedded],
      ["scripts", "src/scripts", "test/scripts"],
    );
    expect(selectedFiles(shards)).not.toContain(
      "extensions/acpx/src/runtime-advertised-model.process.test.ts",
    );
    expect(shards?.some((shard) => shard.requiresDist)).toBe(false);
    expect(shards).toContainEqual(
      expect.objectContaining({ configs: ["test/vitest/vitest.boundary.config.ts"] }),
    );
    for (const other of ["src/deleted.ts", "tsconfig.json"]) {
      const mixed = createChangedNodeTestShards(["test/scripts/ci-linux-git.test.ts", other]);
      expect(mixed).not.toBeNull();
      expect(selectedFiles(mixed)).toContain("test/scripts/ci-linux-git.test.ts");
      expect(selectedFiles(mixed)).not.toContain(
        "extensions/acpx/src/runtime-advertised-model.process.test.ts",
      );
    }
  });

  it.each(
    [
      [],
      ["test/scripts/unknown-tooling.test.ts"],
      ["test/vitest/vitest.tooling.config.ts"],
      ["test/scripts/docker-build-helper.test.ts", "test/scripts/unknown-tooling.test.ts"],
    ].map((targets) => ({ targets })),
  )("refuses incomplete or unsupported canonical selection $targets", ({ targets }) => {
    expect(createSelectedNodeTestShardBundles(targets)).toBeNull();
  });

  it("refuses prepared plans belonging to another selected file", () => {
    const target = "src/plugins/activation-planner.test.ts";
    const preparedTestPlans = new Map([
      [target, buildVitestRunPlans(["src/plugins/manifest-registry.test.ts"])],
    ]);
    expect(createSelectedNodeTestShardBundles([target], { preparedTestPlans })).toBeNull();
  });

  it("does not borrow canonical embedded ownership for another checkout", () => {
    const cwd = argvTempDirs.make("openclaw-embedded-owner-");
    const target =
      "src/agents/embedded-agent-runner/run/attempt-transcript-helpers.presence.test.ts";

    mkdirSync(path.dirname(path.join(cwd, target)), { recursive: true });
    writeFileSync(path.join(cwd, target), "export {};\n");
    expect(buildVitestRunPlans([target], cwd)[0]?.includePatterns).toEqual([target]);
    expect(createChangedNodeTestShards([target], { cwd })).toBeNull();
  });

  it("keeps more than 96 changed tests with E2E and plugin owners precise with canonical worker budgets", () => {
    const cronTests = listGitTrackedFiles({ pathspecs: "src/cron" })
      ?.filter((file) => file.endsWith(".test.ts") && !/\.(?:e2e|live)\.test\.ts$/u.test(file))
      .slice(0, 97);
    expect(cronTests?.length).toBe(97);
    const e2eTarget = "src/auto-reply/reply/agent-runner.runreplyagent.e2e.test.ts";
    const changedTests = [...(cronTests ?? []), "src/plugins/tools.optional.test.ts", e2eTarget];
    const expectedTargets = [...changedTests, "test/scripts/tsgo-core-test-shards.test.ts"];
    const shards = createChangedNodeTestShards(changedTests);
    expect(shards).not.toBeNull();
    const targets = selectedFiles(shards);
    expect(targets.toSorted()).toEqual(expectedTargets.toSorted());
    expect(new Set(targets).size).toBe(targets.length);
    const e2eRow = expectDefined(
      shards?.find((shard) => shard.targets?.includes(e2eTarget)),
      "E2E target row",
    );
    expect(e2eRow.pretestBuildMode).toBe("private-qa");
    expect(
      resolveShardPlans({ OPENCLAW_NODE_TEST_TARGETS_JSON: JSON.stringify(e2eRow.targets) }),
    ).toContainEqual({ kind: "target", name: e2eTarget, target: e2eTarget });
    expect(buildVitestRunPlans([e2eTarget]).map((plan) => plan.config)).toEqual([
      "test/vitest/vitest.e2e.config.ts",
    ]);
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
        const singleton = job.groups?.length === 1 && ownerJob.planConcurrency === 2;
        expect(job.env).toEqual(
          singleton && owner.env?.OPENCLAW_VITEST_MAX_WORKERS === undefined
            ? { ...ownerJob.env, OPENCLAW_VITEST_MAX_WORKERS: "2" }
            : ownerJob.env,
        );
        expect(job.runner).toBe(ownerJob.runner);
        expect(job.planConcurrency).toBe(singleton ? 1 : ownerJob.planConcurrency);
      }
    }
    const cheapFiles = vi
      .spyOn(testTimings, "readRepoE2eFileTimings")
      .mockReturnValue(Object.fromEntries(changedTests.map((file) => [file, 1])));
    const measuredGroups = vi.spyOn(testTimings, "readCompactGroupTimings").mockReturnValue(
      Object.fromEntries(
        full.flatMap((job) =>
          job.groups.flatMap((group) => [
            [group.shard_name, 1],
            [group.timing_key ?? group.shard_name, 1],
          ]),
        ),
      ),
    );
    try {
      const measured = createChangedNodeTestShards(changedTests);
      expect(measured).not.toBeNull();
      expect(selectedFiles(measured).toSorted()).toEqual(expectedTargets.toSorted());
      expect(
        measured?.every((job) => (job.predictedTestSeconds ?? job.predictedSeconds ?? 0) <= 150),
      ).toBe(true);
      expect(
        measured?.some((job) =>
          job.groups?.some((group) => (group.includePatterns?.length ?? 0) > 12),
        ),
      ).toBe(true);
    } finally {
      measuredGroups.mockRestore();
      cheapFiles.mockRestore();
    }
  });
});

const githubActivityHelper = ".agents/skills/openclaw-pr-maintainer/scripts/github-activity.sh";

function listExecutableExtensionFiles(roots: string[]) {
  return listExtensionTestFilesForRoots(roots).filter(
    (file) => !isSharedVitestExcludedPath(file, "extensions"),
  );
}

// Repository-backed routing cases share the planner's existing import graph.
describe("CI changed Node test plan", () => {
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

  it.each([
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

  it.each(["src/agents/simple-completion-runtime.plugin-scope.test.ts"])(
    "prepares runtime artifacts for changed fixture %s",
    (target) => {
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
    },
  );

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
      configs: ["test/vitest/vitest.infra.config.ts"],
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
        config: "test/vitest/vitest.infra.config.ts",
        includePatterns: [target],
      }),
    ]);
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
});
