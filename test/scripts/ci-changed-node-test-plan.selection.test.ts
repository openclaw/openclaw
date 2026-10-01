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
  expect(reasons.find(({ rule }) => rule === "protected-owner")?.targets).toEqual([nearby]);
  expect(new Set(reasons.flatMap(({ targets }) => targets))).toEqual(new Set(selected));
  const full = resolveChangedNodeTestTargets([source], { cwd, selectionMode: "full" });
  expect(full).toEqual([unrelated, direct, nearby, distant].toSorted());
  expect(resolveChangedNodeTestTargets([source], { cwd })).toEqual(full);
  expect(
    resolveChangedNodeTestTargets([source, distant], { cwd, selectionMode: "aggressive" }),
  ).toContain(distant);
});
