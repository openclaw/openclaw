import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolveChangedNodeTestTargets } from "../../scripts/lib/ci-changed-node-test-plan.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createFixtureGit, writeFiles } from "./ci-changed-node-test-plan.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
type Mode = "aggressive" | "full";
function fixture(files: Record<string, string> | string[]) {
  const cwd = tempDirs.make("node-selection-");
  writeFiles(cwd, files);
  return cwd;
}

const select = (cwd: string, paths: string[], selectionMode: Mode = "aggressive") =>
  resolveChangedNodeTestTargets(paths, { cwd, selectionMode });

it.each(["aggressive", "full"] as const)(
  "retains indirect workflow fixture consumers beside a busy hub in %s mode",
  (selectionMode) => {
    const helper = "test/scripts/ci-workflow.test-support.ts";
    const bridge = "test/scripts/ci-workflow-manifest.test-support.ts";
    const indirect = ["ci-workflow-native-generated", "ci-workflow-ui-full"].map(
      (name) => `test/scripts/${name}.test.ts`,
    );
    const family = [
      "ci-workflow-complete",
      "ci-workflow-cost",
      "ci-workflow-evidence",
      "ci-workflow-guards",
      "ci-workflow-planning",
      "ci-workflow.test-support",
      "ci-swift-cache-lifetime",
    ].map((name) => `test/scripts/${name}.test.ts`);
    const direct = Array.from({ length: 30 }, (_, i) => `test/scripts/other-${i}.test.ts`);
    const native = "test/scripts/macos-native-test-launch.test.ts";
    const cwd = fixture({
      [helper]: "export {};",
      [bridge]: 'import "./ci-workflow.test-support.js";',
      [native]: "export {};",
      ...Object.fromEntries(
        [...family, ...direct].map((file) => [file, 'import "./ci-workflow.test-support.js";']),
      ),
      ...Object.fromEntries(
        indirect.map((file) => [file, 'import "./ci-workflow-manifest.test-support.js";']),
      ),
    });
    const files = select(cwd, [helper], selectionMode);
    expect(files.toSorted()).toEqual(
      [...family, ...direct, ...indirect, ...(selectionMode === "full" ? [native] : [])].toSorted(),
    );
    expect(select(cwd, [family[0]!], selectionMode)).toEqual([family[0]]);
  },
);

it.each(["aggressive", "full"] as const)(
  "routes skill node:test and Python files through their Vitest owner in %s mode",
  (selectionMode) => {
    // Skill scripts carry node:test and Python files that no Vitest config owns.
    const unownedSkillTest = ".agents/skills/example/scripts/driver.test.mjs";
    const skillRoot = ".agents/skills/telegram-e2e-userbot/scripts/driver.test";
    const skillTest = `${skillRoot}.mjs`,
      skillPythonTest = `${skillRoot}.py`;
    const wrapper = "test/scripts/telegram-e2e-userbot-skill.test.ts";
    const routable = "src/infra/own.test.ts";
    const cwd = fixture([unownedSkillTest, skillTest, skillPythonTest, wrapper, routable]);
    expect(select(cwd, [skillTest], selectionMode)).toEqual([wrapper]);
    expect(select(cwd, [unownedSkillTest, skillPythonTest, routable], selectionMode)).toEqual([
      routable,
      wrapper,
    ]);
  },
);

it("bounds protected regressions to nearby consumers and restores area coverage in full mode", () => {
  const source = "src/agents/example/subject.ts";
  const direct = "src/agents/example/subject.test.ts";
  const nearby = "src/infra/device-pairing.test.ts";
  const distant = "src/infra/state-migrations.audit-logs.test.ts";
  const unrelated = "src/agents/bash-tools.exec.script-preflight.test.ts";
  const cwd = fixture({
    [source]: "export const value = 1;",
    [direct]: 'import "./subject.js";',
    "src/infra/bridge.ts": 'import "../agents/example/subject.js";',
    [nearby]: 'import "./bridge.js";',
    "src/infra/distant.ts": 'import "./bridge.js";',
    [distant]: 'import "./distant.js";',
    [unrelated]: "export {};",
  });
  const reasons: { rule: string; input: string; targets: string[] }[] = [];
  const selected = resolveChangedNodeTestTargets([source], {
    cwd,
    selectionMode: "aggressive",
    onSelection: (selection) => reasons.push(selection),
  });
  expect(selected).toEqual([direct, nearby]);
  expect(
    reasons.filter(({ rule }) => rule === "import-consumer").flatMap(({ targets }) => targets),
  ).toContain(nearby);
  expect(new Set(reasons.flatMap(({ targets }) => targets))).toEqual(new Set(selected));
  const full = select(cwd, [source], "full");
  expect(full).toEqual([unrelated, direct, nearby, distant].toSorted());
  expect(resolveChangedNodeTestTargets([source], { cwd })).toEqual(full);
  expect(select(cwd, [source, distant])).toContain(distant);
});

it.each(
  ["relative", "package", "mixed"].flatMap((kind) => [19, 20].map((count) => ({ kind, count }))),
)("limits $kind second-hop expansion at $count direct importers", ({ kind, count }) => {
  const source = kind === "relative" ? "src/core/value.ts" : "packages/subject/src/value.ts";
  const specifier = kind === "relative" ? "../core/value.js" : "@fixture/subject";
  const direct = Array.from({ length: count - 1 }, (_, i) => `src/readers/direct-${i}.test.ts`);
  const indirect = "src/consumers/indirect.test.ts";
  const cwd = fixture({
    "packages/subject/package.json": JSON.stringify({
      name: "@fixture/subject",
      exports: { ".": "./src/value.ts" },
    }),
    [source]: "export const value = 1;",
    "src/bridge/value.ts": `import "${specifier}";`,
    [indirect]: 'import "../bridge/value.js";',
    ...Object.fromEntries(
      direct.map((file, index) => [
        file,
        `import "${kind === "mixed" && index % 2 ? "../../packages/subject/src/value.js" : specifier}";`,
      ]),
    ),
  });
  const selected = select(cwd, [source]);
  expect(selected).toEqual([...direct, ...(count < 20 ? [indirect] : [])].toSorted());
  expect(select(cwd, [source], "full")).toEqual(expect.arrayContaining(direct));
  expect(select(cwd, [source, indirect])).toContain(indirect);
  if (kind === "package") {
    expect(select(cwd, ["packages/subject/package.json"])).toEqual(direct.toSorted());
  }
});

it.each([30, 31])(
  "uses stems instead of broad directory ownership at %i adjacent tests",
  (count) => {
    const source = "src/infra/foo.ts";
    const matching = ["foo", "foo.extra", "foo-more"].map((stem) => `src/infra/${stem}.test.ts`);
    const unrelated = Array.from(
      { length: count - matching.length },
      (_, index) => `src/infra/unrelated-${index}.test.ts`,
    );
    const nested = "src/infra/nested/other.test.ts";
    const cwd = fixture([source, ...matching, ...unrelated, nested]);
    const selected = select(cwd, [source]);
    expect(selected).toEqual((count <= 30 ? [...matching, ...unrelated] : matching).toSorted());
    expect(selected).not.toContain(nested);
    expect(select(cwd, [source, unrelated[0]!])).toContain(unrelated[0]);
  },
);

it.each(["aggressive", "full"] as const)(
  "keeps opt-in tests outside PR test roots out of %s selection",
  (selectionMode) => {
    // #182101: the retention census imports this helper but has its own opt-in config.
    const helper = "ui/src/test-helpers/control-ui-e2e.ts";
    const optIn = "scripts/control-ui-retention/dependency-retention.test.ts";
    const consumer = "ui/src/test-helpers/control-ui-e2e.test.ts";
    const cwd = fixture({
      [helper]: "export const helper = 1;\n",
      [optIn]: 'import "../../ui/src/test-helpers/control-ui-e2e.ts";\n',
      [consumer]: 'import "./control-ui-e2e.ts";\n',
    });
    const selected = select(cwd, [helper], selectionMode);
    expect(selected).toContain(consumer);
    expect(selected).not.toContain(optIn);
    expect(select(cwd, [optIn], selectionMode)).not.toContain(optIn);
  },
);

it.each(
  ["packages", "extensions"].flatMap((root) => [false, true].map((deleted) => ({ root, deleted }))),
)("selects resolved $root subpaths independently (deleted: $deleted)", ({ root, deleted }) => {
  const changed = `${root}/subject/src/value.ts`;
  const companion = `${root}/subject/src/value.test.ts`;
  const manifest = `${root}/subject/package.json`;
  const cwd = fixture({
    [manifest]: JSON.stringify({
      name: "@fixture/subject",
      exports: {
        "./value": "./src/value.ts",
        "./other": "./src/other.ts",
        ".": "./src/index.ts",
      },
    }),
    [changed]: "export const value = 1;",
    [companion]: 'import "./value.js";',
    [`${root}/subject/src/value.test-support.ts`]: "export {};",
    [`${root}/subject/scripts/generate.mjs`]: "export {};",
    [`${root}/subject/src/other.ts`]: "export const other = 1;",
    [`${root}/subject/src/index.ts`]: 'export * from "./bridge.js";',
    [`${root}/subject/src/bridge.ts`]: 'export * from "./value.js";',
    "src/readers/value.test.ts": 'import "@fixture/subject/value";',
    "src/readers/barrel.test.ts": 'import "@fixture/subject";',
    "src/readers/other.test.ts": 'import "@fixture/subject/other";',
    "src/readers/unknown.test.ts": 'import "@fixture/subject/generated";',
    "src/readers/types.test.ts": 'import type { Other } from "@fixture/subject/other";',
  });
  const expected = ["barrel", "unknown", "value"].map((name) => `src/readers/${name}.test.ts`);
  if (deleted) {
    fs.unlinkSync(path.join(cwd, changed));
  }
  expect(select(cwd, [changed])).toEqual([companion, ...expected]);
  expect(select(cwd, [changed, companion])).toEqual([companion, ...expected]);
  const all = [...expected, "src/readers/other.test.ts"].toSorted();
  expect(select(cwd, [manifest])).toEqual(all);
  expect(select(cwd, [changed, `${root}/subject/src/value.test-support.ts`])).toEqual([
    companion,
    ...all,
  ]);
  expect(select(cwd, [`${root}/subject/scripts/generate.mjs`])).toEqual(all);
});

it.each([
  "added",
  "moved",
  "removed",
  "metadata",
  "other-script",
  "invalid-list",
  "duplicate",
  "missing-base",
  "invalid-base",
])("bounds Windows package inventory changes with %s inputs", (kind) => {
  const first = "src/platform/one.windows.test.ts";
  const second = "src/platform/two.windows.test.ts";
  const added = "src/platform/three.windows.test.ts";
  const reader = "src/manifest/read.test.ts";
  const unrelated = "src/consumer/package.test.ts";
  const own = "src/feature/own.test.ts";
  const command = (files: string[]) => `node scripts/test-projects.mts ${files.join(" ")}`;
  const before = {
    name: "@fixture/subject",
    exports: { ".": "./src/value.ts" },
    scripts: {
      "test:windows:ci:1": command(kind === "removed" ? [first, added] : [first]),
      "test:windows:ci:2": command([second]),
      build: "node scripts/build.mjs",
    },
  };
  const cwd = fixture({
    "package.json": JSON.stringify(before),
    "src/value.ts": "export const value = 1;",
    "src/feature/own.ts": "export const own = 1;",
    [own]: 'import "./own.js";',
    [reader]: 'new URL("../../package.json", import.meta.url);',
    [unrelated]: 'import "@fixture/subject";',
    [first]: "export {};",
    [second]: "export {};",
    [added]: "export {};",
  });
  const git = createFixtureGit(cwd);
  git("init", "--quiet");
  git("add", ".");
  git("commit", "--quiet", "-m", "fixture baseline");
  const baseRef =
    kind === "missing-base"
      ? undefined
      : kind === "invalid-base"
        ? "a".repeat(40)
        : git("rev-parse", "HEAD");
  const after = structuredClone(before);
  after.scripts["test:windows:ci:1"] = command([first, added]);
  if (kind === "moved") {
    after.scripts["test:windows:ci:1"] = command([second]);
    after.scripts["test:windows:ci:2"] = command([first]);
  } else if (kind === "removed") {
    after.scripts["test:windows:ci:1"] = command([first]);
  } else if (kind === "duplicate") {
    after.scripts["test:windows:ci:1"] = command([first, second]);
  } else if (kind === "metadata") {
    after.exports["."] = "./src/feature/own.ts";
  } else if (kind === "other-script") {
    after.scripts.build += " --changed";
  } else if (kind === "invalid-list") {
    after.scripts["test:windows:ci:1"] += " --run";
  }
  writeFiles(cwd, { "package.json": JSON.stringify(after) });
  const selected = resolveChangedNodeTestTargets(["package.json", "src/feature/own.ts"], {
    cwd,
    baseRef,
    selectionMode: "aggressive",
  });
  expect(selected).toContain(reader);
  expect(selected).toContain(own);
  if (["added", "moved", "removed"].includes(kind)) {
    expect(selected).not.toContain(unrelated);
    expect(selected.includes(added)).toBe(kind === "added");
  } else {
    expect(selected).toContain(unrelated);
  }
});
