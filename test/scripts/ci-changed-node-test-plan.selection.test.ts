import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolveChangedNodeTestTargets } from "../../scripts/lib/ci-changed-node-test-plan.mts";
import { resolveCiCheckFamilyScope } from "../../scripts/lib/ci-check-family-scope.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
type Mode = "aggressive" | "full";
function fixture(files: Record<string, string> | string[]) {
  const cwd = tempDirs.make("node-selection-");
  const entries: [string, string][] = Array.isArray(files)
    ? files.map((file) => [file, "export {};\n"])
    : Object.entries(files);
  for (const [file, content] of entries) {
    mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    writeFileSync(path.join(cwd, file), content);
  }
  return cwd;
}

const select = (cwd: string, paths: string[], selectionMode: Mode = "aggressive") =>
  resolveChangedNodeTestTargets(paths, { cwd, selectionMode });

it.each(["added", "renamed", "deleted", "import-edge"])(
  "retains non-import inventories and architecture for %s source modules",
  (change) => {
    const source = "src/infra/new-module.ts";
    const guards = [
      "test/scripts/pr-wrapper-source-closure.test.ts",
      "test/scripts/pr-worktree-provision.test.ts",
      "test/scripts/eager-import-closure.test.ts",
      "test/scripts/update-restart-module-outcome.test.ts",
      "test/scripts/type-suppression-inventory.test.ts",
      "test/scripts/plugin-sdk-surface-report.test.ts",
    ];
    const testOnly = "src/infra/own.test.ts";
    const cwd = fixture([...guards, ...(change === "deleted" ? [] : [source])]);
    if (change === "import-edge") {
      writeFileSync(path.join(cwd, source), 'import "./dependency.js";\n');
      writeFileSync(path.join(cwd, "src/infra/dependency.ts"), "export {};\n");
    }
    const paths = change === "renamed" ? ["src/infra/old-module.ts", source] : [source];
    expect(select(cwd, paths)).toEqual(guards.toSorted());
    mkdirSync(path.dirname(path.join(cwd, testOnly)), { recursive: true });
    writeFileSync(path.join(cwd, testOnly), "export {};\n");
    expect(select(cwd, [testOnly])).toEqual([testOnly]);
    expect(resolveCiCheckFamilyScope(paths).additionalGroups).toContain(
      "runtime-topology-architecture",
    );
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
  const unrelated = "src/agents/bash-tools.exec.path.test.ts";
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
