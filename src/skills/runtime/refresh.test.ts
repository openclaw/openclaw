import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import type { SkillSnapshot } from "../types.js";
import {
  createSkillsWatcherMock,
  useSkillsWatcherFixture,
} from "./refresh.watcher.test-support.js";

const observer = createSkillsWatcherMock();
vi.mock("@openclaw/fs-safe/watch", () => ({ watch: observer.watchMock }));
vi.mock("../loading/plugin-skills.js", () => ({
  resolvePluginSkillRoots: vi.fn(() => []),
  resolvePluginSkillRootsFromMetadata: vi.fn(() => []),
}));
// Capacity degradation persists until shutdown; each case owns its module state.
beforeEach(() => vi.resetModules());
const fixture = useSkillsWatcherFixture(observer);
let refresh: typeof import("./refresh.js");
beforeEach(async () => {
  refresh = await import("./refresh.js");
});

it("refreshes shared snapshots after native watch exhaustion until shutdown", async () => {
  const { resolveReusableWorkspaceSkillSnapshot } = await import("./session-snapshot.js");
  const { getSkillsSnapshotVersion } = await import("./refresh-state.js");
  const sharedRoot = await fixture.createFixtureDirectory("shared");
  const workspaces = [fixture.workspaceDir, await fixture.createFixtureDirectory("second")];
  const config = { skills: { load: { extraDirs: [sharedRoot] } } };
  const write = (name: string, description: string) =>
    writeSkill({ dir: path.join(sharedRoot, "skills", name), name, description });
  const resolve = async (workspaceDir: string, existingSnapshot?: SkillSnapshot) =>
    (
      await resolveReusableWorkspaceSkillSnapshot({
        workspaceDir,
        config,
        skillFilter: ["capacity-proof", "added-proof"],
        existingSnapshot,
      })
    ).snapshot;
  await write("capacity-proof", "Original description");
  const snapshots = [];
  for (const workspace of workspaces) {
    const snapshot = await resolve(workspace);
    expect(snapshot.prompt).toContain("Original description");
    snapshots.push(snapshot);
  }
  await observer.readyAll();
  observer.forRoot(sharedRoot).fail(new Error("EMFILE"), { operation: "watch", code: "EMFILE" });
  const watcherCount = observer.subscriptions.length;
  expect(observer.subscriptions.every((watcher) => watcher.closed)).toBe(true);
  await write("capacity-proof", "Edited description");
  for (const [index, workspace] of workspaces.entries()) {
    snapshots[index] = await resolve(workspace, snapshots[index]);
    expect(snapshots[index].prompt).toContain("Edited description");
    expect(snapshots[index].prompt).not.toContain("Original description");
  }
  await write("added-proof", "New skill");
  for (const [index, workspace] of workspaces.entries()) {
    expect((await resolve(workspace, snapshots[index])).prompt).toContain("New skill");
  }
  expect((await resolve(await fixture.createFixtureDirectory("late"))).prompt).toContain(
    "New skill",
  );
  expect(observer.subscriptions).toHaveLength(watcherCount);
  const disabled = {
    workspaceDir: fixture.workspaceDir,
    config: { skills: { load: { watch: false } } },
  };
  refresh.ensureSkillsWatcher(disabled);
  const version = getSkillsSnapshotVersion(fixture.workspaceDir);
  refresh.ensureSkillsWatcher(disabled);
  expect(getSkillsSnapshotVersion(fixture.workspaceDir)).toBe(version);
  expect(observer.subscriptions).toHaveLength(watcherCount);
  await refresh.closeSkillsWatchers();
  refresh.ensureSkillsWatcher({ workspaceDir: workspaces[1]!, config });
  await observer.readyAll();
  expect(observer.forRoot(sharedRoot).closed).toBe(false);
});

it("recovers a scan-side capacity error without degrading healthy siblings", async () => {
  const { getSkillsSourceVersion } = await import("./refresh-state.js");
  const workspaceDir = fixture.workspaceDir;
  const sibling = await fixture.createFixtureDirectory("sibling");
  refresh.ensureSkillsWatcher({ workspaceDir });
  refresh.ensureSkillsWatcher({ workspaceDir: sibling });
  await observer.readyAll();
  const healthy = observer.forRoot(path.join(sibling, "skills"));
  const failed = observer.forRoot(path.join(workspaceDir, "skills"));
  failed.fail(new Error("EMFILE"), { operation: "scan", code: "EMFILE" });
  await failed.close();
  await observer.readyAll();
  expect(healthy.closed).toBe(false);
  expect(observer.forRoot(path.join(workspaceDir, "skills"))).not.toBe(failed);
  expect(refresh.reconcileSkillsWatcherCoverage({ workspaceDir: sibling })).toBe(true);
  const version = getSkillsSourceVersion(sibling);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  healthy.dirty(undefined, "overflow");
  await vi.advanceTimersByTimeAsync(250);
  expect(getSkillsSourceVersion(sibling)).toBeGreaterThan(version);
});

it("uses prepared plugin metadata to observe nested companion skills", async () => {
  const plugin = await import("../loading/plugin-skills.js");
  vi.mocked(plugin.resolvePluginSkillRoots).mockClear();
  vi.mocked(plugin.resolvePluginSkillRootsFromMetadata).mockClear();
  const root = await fixture.createFixtureDirectory("plugin");
  await writeSkill({
    dir: path.join(root, "skills/group/demo"),
    name: "demo",
    description: "Demo",
  });
  const roots = vi.mocked(plugin.resolvePluginSkillRootsFromMetadata);
  roots.mockReturnValue([{ dir: root, rejectHardlinks: true }]);
  try {
    const pluginMetadataSnapshot = { policyHash: "prepared" } as PluginMetadataSnapshot;
    refresh.ensureSkillsWatcher({ workspaceDir: fixture.workspaceDir, pluginMetadataSnapshot });
    await observer.readyAll();
    expect(roots).toHaveBeenCalled();
    expect(plugin.resolvePluginSkillRoots).not.toHaveBeenCalled();
    const observed = observer.forRoot(path.join(root, "skills"));
    expect(observed.options.scopes[0]!.depth).toBeGreaterThanOrEqual(7);
    for (const ignored of [".git", "node_modules", "dist", ".venv", "__pycache__", "build"]) {
      expect(
        observed.options.exclude?.({
          path: path.relative(observed.authority.rootDir, path.join(root, "skills", ignored)),
          kind: "directory",
        }),
      ).toBe(true);
    }
  } finally {
    roots.mockReturnValue([]);
  }
});
