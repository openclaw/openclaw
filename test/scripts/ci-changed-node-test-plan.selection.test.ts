import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolveChangedNodeTestTargets } from "../../scripts/lib/ci-changed-node-test-plan.mts";
import { resolveCiCheckFamilyScope } from "../../scripts/lib/ci-check-family-scope.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each(["added", "renamed", "deleted", "import-edge"])(
  "retains non-import inventories and architecture for %s source modules",
  (change) => {
    const cwd = tempDirs.make("node-source-inventory-");
    const source = "src/infra/new-module.ts";
    const guards = [
      "test/scripts/pr-wrapper-source-closure.test.ts",
      "test/scripts/pr-worktree-provision.test.ts",
      "test/scripts/eager-import-closure.test.ts",
      "test/scripts/update-restart-module-outcome.test.ts",
      "test/scripts/type-suppression-inventory.test.ts",
      "test/scripts/plugin-sdk-surface-report.test.ts",
    ];
    for (const file of [...guards, ...(change === "deleted" ? [] : [source])]) {
      mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
      writeFileSync(path.join(cwd, file), "export {};\n");
    }
    if (change === "import-edge") {
      writeFileSync(path.join(cwd, source), 'import "./dependency.js";\n');
      writeFileSync(path.join(cwd, "src/infra/dependency.ts"), "export {};\n");
    }
    const paths = change === "renamed" ? ["src/infra/old-module.ts", source] : [source];
    expect(resolveChangedNodeTestTargets(paths, { cwd, selectionMode: "aggressive" })).toEqual(
      guards.toSorted(),
    );
    const testOnly = "src/infra/own.test.ts";
    mkdirSync(path.dirname(path.join(cwd, testOnly)), { recursive: true });
    writeFileSync(path.join(cwd, testOnly), "export {};\n");
    expect(resolveChangedNodeTestTargets([testOnly], { cwd, selectionMode: "aggressive" })).toEqual(
      [testOnly],
    );
    expect(resolveCiCheckFamilyScope(paths).additionalGroups).toContain(
      "runtime-topology-architecture",
    );
  },
);

it("bounds protected regressions to nearby consumers and restores area coverage in full mode", () => {
  const cwd = tempDirs.make("node-selection-");
  const source = "src/agents/example/subject.ts";
  const direct = "src/agents/example/subject.test.ts";
  const nearby = "src/infra/device-pairing.test.ts";
  const distant = "src/infra/state-migrations.audit-logs.test.ts";
  const unrelated = "src/agents/bash-tools.exec.path.test.ts";
  const files = {
    [source]: "export const value = 1;",
    [direct]: 'import "./subject.js";',
    "src/infra/bridge.ts": 'import "../agents/example/subject.js";',
    [nearby]: 'import "./bridge.js";',
    "src/infra/distant.ts": 'import "./bridge.js";',
    [distant]: 'import "./distant.js";',
    [unrelated]: "export {};",
  };
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    writeFileSync(path.join(cwd, file), content);
  }
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
  const full = resolveChangedNodeTestTargets([source], { cwd, selectionMode: "full" });
  expect(full).toEqual([unrelated, direct, nearby, distant].toSorted());
  expect(resolveChangedNodeTestTargets([source], { cwd })).toEqual(full);
  expect(
    resolveChangedNodeTestTargets([source, distant], { cwd, selectionMode: "aggressive" }),
  ).toContain(distant);
});

it.each([
  ["relative", 19],
  ["relative", 20],
  ["package", 19],
  ["package", 20],
  ["mixed", 19],
  ["mixed", 20],
] as const)("limits %s second-hop expansion at %i direct importers", (kind, count) => {
  const cwd = tempDirs.make("node-hub-selection-");
  const source = kind === "relative" ? "src/core/value.ts" : "packages/subject/src/value.ts";
  const specifier = kind === "relative" ? "../core/value.js" : "@fixture/subject";
  const direct = Array.from(
    { length: count - 1 },
    (_, index) => `src/readers/direct-${index}.test.ts`,
  );
  const indirect = "src/consumers/indirect.test.ts";
  const files: Record<string, string> = {
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
  };
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    writeFileSync(path.join(cwd, file), content);
  }
  const selected = resolveChangedNodeTestTargets([source], { cwd, selectionMode: "aggressive" });
  expect(selected).toEqual([...direct, ...(count < 20 ? [indirect] : [])].toSorted());
  expect(resolveChangedNodeTestTargets([source], { cwd, selectionMode: "full" })).toEqual(
    expect.arrayContaining(direct),
  );
  expect(
    resolveChangedNodeTestTargets([source, indirect], { cwd, selectionMode: "aggressive" }),
  ).toContain(indirect);
  if (kind === "package") {
    expect(
      resolveChangedNodeTestTargets(["packages/subject/package.json"], {
        cwd,
        selectionMode: "aggressive",
      }),
    ).toEqual(direct.toSorted());
  }
});

it.each([30, 31])(
  "uses stems instead of broad directory ownership at %i adjacent tests",
  (count) => {
    const cwd = tempDirs.make("node-directory-selection-");
    const source = "src/infra/foo.ts";
    const matching = [
      "src/infra/foo.test.ts",
      "src/infra/foo.extra.test.ts",
      "src/infra/foo-more.test.ts",
    ];
    const unrelated = Array.from(
      { length: count - matching.length },
      (_, index) => `src/infra/unrelated-${index}.test.ts`,
    );
    const nested = "src/infra/nested/other.test.ts";
    for (const file of [source, ...matching, ...unrelated, nested]) {
      mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
      writeFileSync(path.join(cwd, file), "export {};\n");
    }
    const selected = resolveChangedNodeTestTargets([source], { cwd, selectionMode: "aggressive" });
    expect(selected).toEqual((count <= 30 ? [...matching, ...unrelated] : matching).toSorted());
    expect(selected).not.toContain(nested);
    expect(
      resolveChangedNodeTestTargets([source, unrelated[0]!], { cwd, selectionMode: "aggressive" }),
    ).toContain(unrelated[0]);
  },
);
