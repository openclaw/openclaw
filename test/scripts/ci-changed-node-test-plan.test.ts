import childProcess, { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
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
  type CompactNodeTestShard,
} from "../../scripts/lib/ci-node-test-plan.mts";
import {
  CI_PROOF_TEST_FILES,
  isCiProofTestFile,
  isPrExemptRuntimeTestFile,
  isReleaseOnlyRuntimeTestFile,
  PR_PROTECTED_RUNTIME_TEST_FILES,
} from "../../scripts/lib/ci-proof-test-inventory.mts";
import { refitTestTimings } from "../../scripts/lib/ci-test-timings-refit.mts";
import * as testTimings from "../../scripts/lib/ci-test-timings.mts";
import * as buildPrerequisites from "../../scripts/lib/vitest-build-prerequisites.mts";
import * as testProjects from "../../scripts/test-projects.test-support.mts";
import {
  buildVitestRunPlans,
  hasImportGraphConsumers,
  hasImportGraphImpactOnTargets,
  resolveAffectedTestsFromImportGraph,
} from "../../scripts/test-projects.test-support.mts";
import { listGitTrackedFiles } from "../../src/test-utils/repo-files.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createNestedGitEnv } from "../helpers/temp-repo.js";
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
  expect(
    hasUiE2eAffectingChange(["ui/src/pages/activity/activity-page.test.ts", "package.json"]),
  ).toBe(false);
});

it.each([
  ["extensions/telegram/src/send.ts", false],
  ["src/gateway/control-ui.ts", true],
  ["packages/gateway-protocol/src/schema/protocol-schemas.ts", true],
  ["extensions/browser/chrome-extension/background.js", false],
  ["src/gateway/worker-environments/workspace-quiescence.ts", true],
  ["src/gateway/server-methods/cron.ts", true],
  ["src/gateway/cron-stream-matcher.worker.ts", false],
] as const)(
  "selects browser proof only for its owner or imported wire contract: %s",
  (file, expected) => {
    expect(hasUiE2eAffectingChange([file])).toBe(expected);
  },
);

it.each([
  ["src/gateway/worker-environments/workspace-quiescence.ts", true],
  ["src/gateway/server-methods/cron.ts", true],
  ["src/gateway/cron-stream-matcher.worker.ts", true],
  ["src/gateway/control-ui.ts", true],
  ["packages/gateway-protocol/src/schema/protocol-schemas.ts", true],
  ["src/test-utils/openclaw-test-state.ts", true],
  ["ui/src/e2e/profile-page.real-gateway.e2e.test.ts", true],
  ["ui/src/e2e/control-ui-e2e-suite.test-support.ts", true],
  ["ui/src/e2e/settings-layout.e2e.test.ts", false],
  ["extensions/browser/chrome-extension/background.js", false],
  ["src/gateway/README.md", false],
] as const)(
  "selects real-Gateway tests through their source, fixture, and protocol owners: %s",
  (file, expected) => {
    expect(hasUiE2eAffectingChange([file], { family: "real-gateway" })).toBe(expected);
  },
);

it("does not widen an isolated UI unit change for Gateway documentation", () => {
  expect(
    hasUiE2eAffectingChange(
      ["src/gateway/README.md", "ui/src/pages/activity/activity-page.test.ts"],
      { family: "real-gateway" },
    ),
  ).toBe(false);
});

it.each([
  ["ui/src/styles/chat.css", false],
  ["ui/vite.config.ts", false],
  ["extensions/browser/chrome-extension/background.js", true],
  ["extensions/browser/src/browser/extension-install.ts", true],
  ["test/vitest/vitest.shared.config.ts", false],
  ["pnpm-lock.yaml", false],
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
  ["ui/src/pages/page.ts", false],
  ["scripts/fixture.mts", false],
  ["ui/vite.config.ts", false],
  ["ui/public/sw.js", false],
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
    ).toBe(Boolean(consumer && !/\/(?:\.cache|\.artifacts|dist|node_modules)\//u.test(consumer)));
    expect(hasUiE2eAffectingChange([target], { cwd })).toBe(expected);
  } finally {
    rmSync(cwd, { force: true, recursive: true });
  }
});

it.each(["archive", "untracked", "symlink"])(
  "bounds UI E2E selection for %s unit inputs",
  (mode) => {
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
      expect(hasUiE2eAffectingChange([target], { cwd })).toBe(mode === "symlink");
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  },
);

describe("CI changed Node test plan", () => {
  it("retains changed-owner proof tiers and direct test opt-in without unrelated areas", () => {
    const cwd = argvTempDirs.make("changed-owner-proof-tiers-");
    const areaSource = "src/infra/owner-entry.ts";
    const ordinary = "src/infra/ordinary-owner.test.ts";
    const prExempt = "src/infra/device-bootstrap.test.ts";
    const releaseOnly = "src/infra/state-migrations.test.ts";
    const unrelated = "src/config/io.factory.test.ts";
    expect(isPrExemptRuntimeTestFile(prExempt)).toBe(true);
    expect(isReleaseOnlyRuntimeTestFile(releaseOnly)).toBe(true);
    expect(PR_PROTECTED_RUNTIME_TEST_FILES).toContain(releaseOnly);
    for (const [file, content] of Object.entries({
      [areaSource]: "export {};\n",
      [ordinary]: "export {};\n",
      [unrelated]: "export {};\n",
      [prExempt]: 'import "./exempt-subject.js";\n',
      [releaseOnly]: 'import "./release-subject.js";\n',
      "src/infra/exempt-subject.ts": "export {};\n",
      "src/infra/release-subject.ts": "export {};\n",
    })) {
      mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
      writeFileSync(path.join(cwd, file), content);
    }
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
    expect(selectedFiles(automatic)).not.toContain(unrelated);
    const full = createChangedNodeTestShards([areaSource], {
      ...options,
      includePrExemptRuntimeTests: true,
      includeReleaseOnlyRuntimeTests: true,
    });
    expect(full).not.toBeNull();
    expect(selectedFiles(full).toSorted()).toEqual([ordinary, prExempt, releaseOnly].toSorted());
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
        expect(selectedFiles(direct), changedPath).not.toContain(unrelated);
      }
    }
  });

  it("protects caught and deferred owner contracts without widening a direct test edit", () => {
    const cwd = argvTempDirs.make("changed-protected-owner-contracts-");
    const source = "src/cli/fixture-command.ts";
    const sibling = "src/cli/fixture-command.test.ts";
    const caught = "src/cli/update-cli.test.ts";
    const deferred = "src/cli/claws-cli-legacy-resume.test.ts";
    const unrelated = "src/other/unprotected.test.ts";
    expect(PR_PROTECTED_RUNTIME_TEST_FILES).toContain(caught);
    expect(isPrExemptRuntimeTestFile(deferred)).toBe(true);
    expect(PR_PROTECTED_RUNTIME_TEST_FILES).not.toContain(unrelated);
    writeFileSync(path.join(cwd, "package.json"), "{}\n");
    for (const file of [source, sibling, caught, deferred, unrelated]) {
      mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
      writeFileSync(path.join(cwd, file), "export {};\n");
    }
    const options = {
      cwd,
      includePrExemptRuntimeTests: false,
      includeReleaseOnlyRuntimeTests: false,
    };
    const owner = createChangedNodeTestShards([source], options);
    expect(owner).not.toBeNull();
    expect(selectedFiles(owner).toSorted()).toEqual([sibling, caught, deferred].toSorted());
    const global = createChangedNodeTestShards(["package.json"], options);
    expect(global).not.toBeNull();
    expect(selectedFiles(global)).toEqual([caught]);
    expect(selectedFiles(global)).not.toContain(unrelated);
    expect(selectedFiles(global)).not.toContain(deferred);
    for (const target of [sibling, caught, deferred]) {
      const leaf = createChangedNodeTestShards([target], options);
      expect(leaf, target).not.toBeNull();
      expect(selectedFiles(leaf), target).toEqual([target]);
    }
  });

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
    const dedicatedProofs = [
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
    expect(selectedFiles(sourcePlan)).toContain(deferred);
    for (const companion of [unknown, "src/infra/deleted.ts"]) {
      const mixed = createChangedNodeTestShards([helper, companion], options);
      expect(mixed).not.toBeNull();
      expect(selectedFiles(mixed)).toContain(gatewayCallsitesGuard);
      expect(selectedFiles(mixed)).not.toContain(companion);
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

  it("keeps directly affected maintainer helpers beside product tests", () => {
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
    const helperTarget = "src/cli/update-cli/update-command-legacy-finalize.test.ts";
    const helperConfig = expectDefined(
      buildVitestRunPlans([helperTarget])[0]?.config,
      "maintainer helper's canonical config",
    );
    expect(
      files?.includes(helperTarget) ||
        fallbackGroups(shards ?? []).some(
          (group) => group.configs.includes(helperConfig) && group.includePatterns === undefined,
        ),
    ).toBe(true);
    expect(
      shards?.some((shard) =>
        [...shard.configs, ...(shard.groups?.flatMap((group) => group.configs) ?? [])].some(
          (config) => config.includes("vitest.tooling"),
        ),
      ),
    ).toBe(true);
    expect(files).not.toContain("test/scripts/mobile-release-ci.test.ts");
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

  it.each(["blacksmith", "github", "hybrid"])(
    "retains exact plugin selections in their canonical process owner without enabling the unrelated sweep (%s)",
    (runnerBackend) => {
      const pluginConfig = "test/vitest/vitest.plugins.config.ts";
      const targets = [
        "src/plugins/activation-planner.test.ts",
        "src/plugins/manifest-registry.test.ts",
        "src/infra/retry.test.ts",
      ];
      const selected = createSelectedNodeTestShardBundles(targets, { runnerBackend });
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
          // Repacked jobs combine owners and honor their own timing observations;
          // an individual original owner's forecast is not their cost ceiling.
          expect(selectedJob?.predictedSeconds).toBeGreaterThan(0);
          expect(selectedJob?.predictedSeconds).toBeLessThanOrEqual(300);
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
      expect(
        changedTui
          ?.flatMap((job) => job.groups ?? [])
          .filter((group) => group.requiresDist)
          .every((group) => group.includePatterns === undefined),
      ).toBe(true);
      const changedTuiOwner = expectDefined(
        changedTui?.find((job) => job.groups?.some((group) => group.requiresDist)),
        "changed built TUI job",
      );
      expect(changedTuiOwner.env).toEqual(tuiOwnerJob.env);
      expect(changedTuiOwner.runner).toBe(tuiOwnerJob.runner);
      expect(changedTuiOwner.planConcurrency).toBe(tuiOwnerJob.planConcurrency);
      expect(changedTuiOwner.pretestBuildMode).toBe(tuiOwnerJob.pretestBuildMode);
      expect(changedTuiOwner.timeoutMinutes).toBe(tuiOwnerJob.timeoutMinutes);
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
      expect(selectedFiles(measured).toSorted()).toEqual(changedTests.toSorted());
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
