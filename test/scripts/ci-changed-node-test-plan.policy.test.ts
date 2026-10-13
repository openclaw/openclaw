import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  hasBuildArtifactAffectingChange,
  hasQaSmokeAffectingChange,
  resolveReleaseFastLaneScope,
} from "../../scripts/lib/ci-changed-node-test-plan.mts";
import { createSelectedNodeTestShardBundles } from "../../scripts/lib/ci-node-test-plan.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
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
    expect(hasQaSmokeAffectingChange(["scripts/lib/ci-qa-smoke-scope.mts"])).toBe(true);
    expect(hasQaSmokeAffectingChange([".github/workflows/labeler.yml"])).toBe(false);
  });

  it.each([
    "extensions/browser/src/browser/extension-install.native-host.e2e.test.ts",
    "extensions/browser/src/browser/extension-install.test-support.ts",
    "extensions/browser/chrome-extension/relay-key.test-support.ts",
  ])("keeps the built native-host proof selected when only %s changes", (changedPath) => {
    expect(hasBuildArtifactAffectingChange([changedPath])).toBe(true);
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
  });

  describe("documentation targeting", () => {
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
  });
});
