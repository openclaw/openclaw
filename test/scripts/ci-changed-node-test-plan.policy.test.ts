import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  hasBuildArtifactAffectingChange as affectsBuild,
  hasControlUiPerformanceAffectingChange as affectsUi,
  hasPromptSnapshotAffectingChange as affectsPrompts,
  hasQaSmokeAffectingChange as affectsQa,
  resolveReleaseFastLaneScope as releaseScope,
} from "../../scripts/lib/ci-changed-node-test-plan.mts";
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

it("classifies build-artifact and QA smoke impact by changed surface", () => {
  expect(affectsBuild(["src/agents/foo.test.ts", "test/helpers/x.ts"])).toBe(false);
  expectImpact(affectsBuild, true, [
    "src/agents/foo.ts",
    "scripts/build-all.mts",
    "tsconfig.json",
    "cli-invocation.mjs",
    "tsdown.config.ts",
    "scripts/lib/build-artifact-cache.mts",
    "scripts/test-built-source-verifiers.mts",
  ]);
  expectImpact(affectsBuild, false, [
    "src/gateway/server.auth.control-ui.trusted-proxy.suite.ts",
    "scripts/run-vitest.mjs",
  ]);
  expectImpact(affectsQa, true, [
    "extensions/qa-lab/src/ci-smoke-plan.ts",
    "qa/scenarios/index.yaml",
    ".github/actions/setup-node-env/action.yml",
    "scripts/lib/ci-changed-node-test-plan.mts",
  ]);
  expectImpact(affectsQa, false, ["extensions/discord/src/index.ts"]);
});

it("keeps the built native-host proof selected when its test changes", () => {
  const changedPath = "extensions/browser/src/browser/extension-install.native-host.e2e.test.ts";
  expect(affectsBuild([changedPath])).toBe(true);
});

it.each([
  [
    [
      ".github/workflows/openclaw-release-publish.yml",
      "scripts/lib/release-publish-children.sh",
      "test/scripts/release-publish-children.test.ts",
      ".agents/skills/release-openclaw-ci/SKILL.md",
      "docs/ci.md",
    ],
    "",
  ],
  [["src/foo.ts"], "outside the release tooling scope: src/foo.ts"],
  [
    ["src/foo.ts", "scripts/run-vitest.mts", "scripts/run-vitest.mjs"],
    "global execution or resolution input: scripts/run-vitest.mts",
  ],
  [null, "missing changed paths"],
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
