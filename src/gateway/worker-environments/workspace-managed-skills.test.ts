import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { captureWorkspaceSnapshot } from "./workspace-manifest-worker.js";
import {
  isDerivedWorkspacePath,
  WORKSPACE_PATH_EXCLUSIONS_JS,
  DERIVED_WORKSPACE_RSYNC_EXCLUDES,
} from "./workspace-path-exclusions.js";
import { prepareNonDirectoryTargets } from "./workspace-reconcile-derived-paths.js";
import { preflightWorkspaceApplyImpl } from "./workspace-reconcile-preflight.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
it("excludes only the root managed skill namespace in host and serialized inventories", async () => {
  const root = tempDirs.make("managed-skill-inventory-");
  await fs.mkdir(path.join(root, ".openclaw/sandbox-skills/skills/demo"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".openclaw/sandbox-skills/skills/demo/SKILL.md"),
    "runtime instruction",
  );
  await fs.writeFile(path.join(root, ".openclaw/project.json"), "project content");
  const snapshot = await captureWorkspaceSnapshot({ root, baseCommit: null });
  expect(snapshot.manifest.entries.map((entry) => entry.path)).toEqual([".openclaw/project.json"]);
  for (const relative of [
    ".openclaw/sandbox-skills",
    ".openclaw/sandbox-skills/skills/demo/SKILL.md",
  ]) {
    expect(isDerivedWorkspacePath(relative)).toBe(true);
    expect(
      vm.runInNewContext(
        `${WORKSPACE_PATH_EXCLUSIONS_JS}\nisDerivedWorkspacePath(${JSON.stringify(relative)})`,
      ),
    ).toBe(true);
  }
  for (const relative of [
    ".openclaw/project.json",
    ".openclaw/sandbox-skills-project/config",
    "nested/.openclaw/sandbox-skills/notes",
  ]) {
    expect(isDerivedWorkspacePath(relative)).toBe(false);
  }
  expect(DERIVED_WORKSPACE_RSYNC_EXCLUDES).toContain("/.openclaw/sandbox-skills");
  expect(isDerivedWorkspacePath(".openclaw/sandbox-skills/skills/demo/SKILL.md", true)).toBe(true);
});

it.each(
  [
    { parent: ".openclaw", runtime: ".openclaw/sandbox-skills/skills" },
    { parent: ".artifacts", runtime: ".artifacts/dist-artifacts.lock" },
  ].flatMap(({ parent, runtime }) =>
    [true, false].map((baseParent) => ({ parent, runtime, baseParent })),
  ),
)(
  "preserves runtime ownership when a project replaces $parent (base parent: $baseParent)",
  async ({ parent, runtime, baseParent }) => {
    const root = tempDirs.make("managed-skill-replacement-");
    if (baseParent) {
      await fs.mkdir(path.join(root, parent));
    }
    const base = (await captureWorkspaceSnapshot({ root, baseCommit: null })).manifest;
    await fs.mkdir(path.join(root, runtime), { recursive: true });
    await fs.writeFile(path.join(root, runtime, "owner.json"), "runtime ownership");
    const input = tempDirs.make("managed-skill-replacement-input-");
    await fs.writeFile(path.join(input, parent), "replacement");
    const current = (await captureWorkspaceSnapshot({ root: input, baseCommit: null })).manifest;
    const preflight = await preflightWorkspaceApplyImpl({ root, base, current });
    expect(preflight.conflictPaths).toContain(parent);
    expect(preflight.applyPaths.has(parent)).toBe(false);
    const deletion = await preflightWorkspaceApplyImpl({
      root,
      base,
      current: { version: 1, baseCommit: null, entries: [], directories: [] },
    });
    expect(deletion.conflictPaths).toEqual([]);
    await prepareNonDirectoryTargets(root, current.entries);
    expect(await fs.readFile(path.join(root, runtime, "owner.json"), "utf8")).toBe(
      "runtime ownership",
    );
  },
);
