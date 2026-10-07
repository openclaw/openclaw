import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hasBuildArtifactAffectingChange,
  hasControlUiPerformanceAffectingChange,
  hasPromptSnapshotAffectingChange,
  hasQaSmokeAffectingChange,
  hasSqliteSessionLifecycleAffectingChange,
  resolveReleaseFastLaneScope,
} from "../../scripts/lib/ci-changed-node-test-plan.mts";
import { createSelectedNodeTestShardBundles } from "../../scripts/lib/ci-node-test-plan.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { startupCorpusTestFiles } from "../vitest/vitest.startup-corpus-paths.mjs";
import {
  createChangedNodeTestShards,
  selectedFiles,
} from "./ci-changed-node-test-plan.test-support.js";

const argvTempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("CI changed Node test plan", () => {
  it("keeps split planner proof within native row budgets without losing cases", () => {
    const files = [
      "test/scripts/ci-changed-node-test-plan.test.ts",
      "test/scripts/ci-changed-node-test-plan.source-owners.test.ts",
      "test/scripts/ci-changed-node-test-plan.policy.test.ts",
      "test/scripts/ci-changed-node-test-plan.process-owners.test.ts",
      "test/scripts/ci-changed-node-test-plan.dependency-hubs.test.ts",
      "test/scripts/ci-changed-node-test-plan.dependency-inputs.test.ts",
      "test/scripts/ci-changed-node-test-plan.config-fallback.test.ts",
    ];
    for (const targets of [files, [files[0]!], [files[3]!]]) {
      for (const runnerBackend of ["blacksmith", "hybrid"]) {
        const rows = expectDefined(
          createSelectedNodeTestShardBundles(targets, { runnerBackend }),
          "precise planner proof",
        );
        const selected = rows.flatMap((row) =>
          row.groups.flatMap((group) => group.includePatterns ?? []),
        );
        expect(selected).toHaveLength(targets.length);
        expect(new Set(selected)).toEqual(new Set(targets));
        for (const row of rows) {
          expect(row.predictedTestSeconds).toBeGreaterThan(0);
          expect(row.predictedTestSeconds).toBeLessThanOrEqual(150);
          expect(row.planConcurrency).toBe(1);
          for (const group of row.groups) {
            expect(group.configs).toEqual(["test/vitest/vitest.tooling.config.ts"]);
            expect(group.env?.OPENCLAW_VITEST_MAX_WORKERS).toBe("2");
          }
        }
      }
    }
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
    ["ui/src/pages/chat/chat-gateway.test.ts", false],
    ["packages/gateway-client/src/index.ts", false],
    ["packages/gateway-client/src/browser.ts", true],
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
    it.each([
      {
        paths: [
          ".github/workflows/openclaw-release-publish.yml",
          "scripts/lib/release-publish-children.sh",
          "test/scripts/release-publish-children.test.ts",
          "docs/reference/RELEASING.md",
          ".agents/skills/release-openclaw-ci/SKILL.md",
          "docs/ci.md",
        ],
        expected: { eligible: true },
      },
      ...["src/foo.ts", "config/knip.config.ts"].map((file) => ({
        paths: [file],
        expected: { eligible: false, reason: `outside the release tooling scope: ${file}` },
      })),
      {
        paths: ["src/foo.ts", "scripts/run-vitest.mts", "scripts/run-vitest.mjs"],
        expected: {
          eligible: false,
          reason: "global execution or resolution input: scripts/run-vitest.mts",
        },
      },
      ...[null, []].map((paths) => ({
        paths,
        expected: { eligible: false, reason: "missing changed paths" },
      })),
    ])("classifies release fast-lane eligibility for $paths", ({ paths, expected }) => {
      expect(resolveReleaseFastLaneScope(paths)).toEqual(expected);
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

    it("keeps compact packing policy and runtime inputs bounded", () => {
      const onFallback = vi.fn();
      createChangedNodeTestShards(
        ["scripts/lib/ci-node-test-plan.mts", "test/scripts/ci-node-test-plan.test.ts"],
        { runnerBackend: "blacksmith", onFallback },
      );
      expect(onFallback).not.toHaveBeenCalledWith(
        "compact packing policy requires full-plan proof",
      );
      const globalPlan = createChangedNodeTestShards(["scripts/run-vitest.mts"], {
        onFallback,
      });
      expect(globalPlan).not.toBeNull();
      expect(selectedFiles(globalPlan)).toContain("test/scripts/test-projects.test.ts");
      expect(selectedFiles(globalPlan)).not.toContain("src/cron/service.stream-trigger.test.ts");
      expect(onFallback).not.toHaveBeenCalled();
    });
  });

  it("keeps measured packing ownership bounded on RunsOn", () => {
    const shards = createChangedNodeTestShards(["scripts/lib/ci-measured-compact-packing.mts"], {
      runnerBackend: "runson",
    });
    expect(shards).not.toBeNull();
    expect(selectedFiles(shards)).toContain("test/scripts/ci-node-test-plan.test.ts");
    expect(selectedFiles(shards)).not.toContain("src/cron/service.stream-trigger.test.ts");
  });

  it("fails safe for raw Git paths that resemble normalized script paths", () => {
    for (const changedPath of [
      " scripts/changed-lanes.mts",
      String.raw`scripts\changed-lanes.mts`,
    ]) {
      expect(createChangedNodeTestShards([changedPath]), changedPath).toBeNull();
    }
  });

  describe("documentation targeting", () => {
    it("keeps the complete budgeted corpus plan beside a documentation page", () => {
      const targets = startupCorpusTestFiles;
      const before = createChangedNodeTestShards(targets);
      expect(before).toHaveLength(3);
      expect(before?.every((shard) => (shard.predictedSeconds ?? 0) <= 150)).toBe(true);
      expect(before?.flatMap((shard) => shard.targets ?? []).toSorted()).toEqual(
        targets.toSorted(),
      );
      expect(before?.some((shard) => shard.pretestBuildMode === "runtime")).toBe(true);
      expect(createChangedNodeTestShards([...targets, "docs/ci/pipeline.md"])).toEqual(before);
    });

    it.each([
      [["docs/guide.md"], "file", true],
      [["docs/deleted.md"], "missing", true],
      [["ui/src/i18n/locales/de.ts"], "file", true],
      [["docs/reference/templates/AGENTS.md"], "file", false],
      [["src/runtime.md"], "file", false],
      [["docs/guide.md"], "symlink", false],
      [["docs/../guide.md"], "file", false],
    ] as const)("preserves Node ownership for %j (%s): %s", (paths, kind, precise) => {
      const cwd = mkdtempSync(path.join(tmpdir(), "openclaw-docs-targeting-"));
      const target = "src/channels/plugins/unowned.test.ts";
      try {
        mkdirSync(path.dirname(path.join(cwd, target)), { recursive: true });
        writeFileSync(path.join(cwd, target), "export {};\n");
        for (const file of kind === "missing" ? [] : paths) {
          const absolute = path.join(cwd, file);
          mkdirSync(path.dirname(absolute), { recursive: true });
          if (kind === "symlink") {
            writeFileSync(path.join(path.dirname(absolute), "target.md"), "# Guide\n");
            symlinkSync("target.md", absolute);
          } else {
            writeFileSync(absolute, "# Guide\n");
          }
        }
        const before = createChangedNodeTestShards([target], { cwd });
        expect(before?.flatMap((shard) => shard.targets ?? [])).toEqual([target]);
        const mixed = createChangedNodeTestShards([target, ...paths], { cwd });
        if (paths.some((file) => path.posix.normalize(file) !== file)) {
          expect(mixed).toBeNull();
        } else {
          expect(mixed).not.toBeNull();
          expect(selectedFiles(mixed)).toEqual(selectedFiles(before));
        }
        if (precise) {
          expect(selectedFiles(createChangedNodeTestShards([...paths], { cwd }))).toEqual([]);
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
});
