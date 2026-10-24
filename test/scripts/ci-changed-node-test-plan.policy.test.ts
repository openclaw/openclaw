import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it } from "vitest";
import {
  hasBuildArtifactAffectingChange as affectsBuild,
  hasControlUiPerformanceAffectingChange as affectsUi,
  hasPromptSnapshotAffectingChange as affectsPrompts,
  hasQaSmokeAffectingChange as affectsQa,
  resolveReleaseFastLaneScope as releaseScope,
} from "../../scripts/lib/ci-changed-node-test-plan.mts";
import { createSelectedNodeTestShardBundles } from "../../scripts/lib/ci-node-test-plan.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  createChangedNodeTestShards,
  selectedFiles,
} from "./ci-changed-node-test-plan.test-support.js";

const argvTempDirs = useAutoCleanupTempDirTracker(afterEach);
function expectImpact(select: (paths: string[]) => boolean, expected: boolean, paths: string[]) {
  for (const file of paths) {
    expect(select([file]), file).toBe(expected);
  }
}
function write(cwd: string, file: string, contents = "# Guide\n") {
  const absolute = path.join(cwd, file);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
  return absolute;
}

it.each([
  [affectsQa, "extensions/telegram/README.md", "extensions/telegram/src/index.ts"],
  [affectsUi, "ui/docs/design-system/README.md", "ui/src/main.ts"],
  [affectsPrompts, "extensions/codex/README.md", "extensions/codex/src/index.ts"],
] as const)("ignores documentation in mixed diffs (%#)", (select, documentation, source) => {
  expect(select([documentation, "src/utils/absolute-deadline.test.ts"])).toBe(false);
  expect(select([documentation, source])).toBe(true);
});

it("keeps runtime Markdown and fixture documentation in their owner lanes", () => {
  expect(affectsQa(["qa/scenarios.md"])).toBe(true);
  expect(affectsQa(["extensions/telegram/test/fixtures/README.md"])).toBe(true);
  expect(affectsUi(["ui/src/runtime.md"])).toBe(true);
});

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
  expect(affectsBuild(["src/agents/foo.test.ts", "test/helpers/x.ts"])).toBe(false);
  expectImpact(affectsBuild, true, [
    "src/agents/foo.ts",
    "scripts/build-all.mts",
    "tsconfig.json",
    "cli-invocation.mjs",
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
  ]);
  expectImpact(affectsBuild, false, [
    "src/gateway/server.auth.control-ui.trusted-proxy.suite.ts",
    "scripts/run-vitest.mjs",
    ".github/workflows/ci.yml",
    "qa/scenarios/index.yaml",
    "ui/src/app.ts",
  ]);
  expectImpact(affectsQa, true, [
    "extensions/qa-lab/src/ci-smoke-plan.ts",
    "qa/scenarios/index.yaml",
    "extensions/telegram/src/index.ts",
    ".github/workflows/ci.yml",
    ".github/actions/setup-node-env/action.yml",
    "scripts/lib/ci-changed-node-test-plan.mts",
    "scripts/lib/ci-qa-smoke-scope.mts",
  ]);
  expectImpact(affectsQa, false, [
    "extensions/discord/src/index.ts",
    "ui/src/app.ts",
    "src/infra/retry.ts",
    "packages/llm-core/src/index.ts",
    "pnpm-lock.yaml",
    "scripts/run-vitest.mjs",
    "test/scripts/ci-node-test-plan.test.ts",
    ".github/workflows/labeler.yml",
  ]);
});

it.each([
  "extensions/browser/src/browser/extension-install.native-host.e2e.test.ts",
  "extensions/browser/src/browser/extension-install.test-support.ts",
  "extensions/browser/chrome-extension/relay-key.test-support.ts",
])("keeps the built native-host proof selected when only %s changes", (changedPath) => {
  expect(affectsBuild([changedPath])).toBe(true);
});

it.each([
  [
    [
      ".github/workflows/openclaw-release-publish.yml",
      "scripts/lib/release-publish-children.sh",
      "test/scripts/release-publish-children.test.ts",
      "docs/reference/RELEASING.md",
      ".agents/skills/release-openclaw-ci/SKILL.md",
      "docs/ci.md",
    ],
    "",
  ],
  ...["src/foo.ts", "config/knip.config.ts"].map((file): [string[], string] => [
    [file],
    `outside the release tooling scope: ${file}`,
  ]),
  [
    ["src/foo.ts", "scripts/run-vitest.mts", "scripts/run-vitest.mjs"],
    "global execution or resolution input: scripts/run-vitest.mts",
  ],
  [null, "missing changed paths"],
  [[], "missing changed paths"],
] satisfies [string[] | null, string][])(
  "classifies release fast-lane eligibility for %j",
  (paths, reason) => {
    expect(releaseScope(paths)).toEqual(reason ? { eligible: false, reason } : { eligible: true });
  },
);

it("accepts deleted tooling paths and uses the existing documentation classifier", () => {
  const cwd = argvTempDirs.make("release-fast-lane-scope-");
  write(cwd, "docs/page.md", "fixture");
  symlinkSync("page.md", path.join(cwd, "docs/linked.md"));
  expect(
    releaseScope(["scripts/deleted.mts", "docs/page.md", "docs/deleted.md"], {
      cwd,
    }),
  ).toEqual({ eligible: true });
  expect(releaseScope(["docs/linked.md"], { cwd })).toEqual({
    eligible: false,
    reason: "outside the release tooling scope: docs/linked.md",
  });
});
it.each([
  ["docs/guide.md", "file", true],
  ["docs/deleted.md", "missing", true],
  ["ui/src/i18n/locales/de.ts", "file", true],
  ["docs/reference/templates/AGENTS.md", "file", false],
  ["src/runtime.md", "file", false],
  ["docs/guide.md", "symlink", false],
  ["docs/../guide.md", "file", false],
] as const)("preserves Node ownership for %s (%s): %s", (file, kind, precise) => {
  const cwd = argvTempDirs.make("openclaw-docs-targeting-");
  const target = "src/channels/plugins/unowned.test.ts";
  write(cwd, target, "export {};\n");
  if (kind === "symlink") {
    write(cwd, path.join(path.dirname(file), "target.md"));
    symlinkSync("target.md", path.join(cwd, file));
  } else if (kind !== "missing") {
    write(cwd, file);
  }
  const before = createChangedNodeTestShards([target], { cwd });
  expect(before?.flatMap((shard) => shard.targets ?? [])).toEqual([target]);
  const mixed = createChangedNodeTestShards([target, file], { cwd });
  if (path.posix.normalize(file) !== file) {
    expect(mixed).toBeNull();
  } else {
    expect(mixed).not.toBeNull();
    expect(selectedFiles(mixed)).toEqual(selectedFiles(before));
  }
  if (precise) {
    expect(selectedFiles(createChangedNodeTestShards([file], { cwd }))).toEqual([]);
  }
});
