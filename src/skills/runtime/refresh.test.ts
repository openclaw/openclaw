import path from "node:path";
import type { WatchEntry, WatchInvalidation } from "@openclaw/fs-safe/watch";
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

function observeScan(
  observed: ReturnType<typeof observer.forRoot>,
  entries: WatchEntry[],
  changes?: WatchInvalidation["changes"],
) {
  observed.options.onHealth?.({ ...observed.subscription.health(), state: "reconciling" });
  for (const entry of entries) {
    observed.options.exclude?.(entry);
  }
  if (changes) {
    observed.dirty(changes);
    observed.options.onHealth?.({ ...observed.subscription.health(), state: "ready" });
  }
}

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

it.each(["file", "directory"] as const)(
  "retains an untouched %s kind across a partial watch scan",
  async (kind) => {
    const { getSkillsResourceVersion, getSkillsSourceVersion } = await import("./refresh-state.js");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const workspaceDir = fixture.workspaceDir;
    const root = path.join(workspaceDir, "skills");
    refresh.ensureSkillsWatcher({ workspaceDir });
    await observer.started();
    const observed = observer.forRoot(root);
    const relative = (name: string) =>
      path.relative(observed.authority.rootDir, path.join(root, name));
    const edited = relative("first/README.md");
    const untouched = relative("second/README.md");
    observeScan(observed, [
      { path: edited, kind: "file" },
      { path: untouched, kind },
    ]);
    await observer.readyAll();
    const sourceVersion = getSkillsSourceVersion(workspaceDir);

    // Native content hints visit only the affected directory, omitting its sibling.
    observeScan(observed, [{ path: edited, kind: "file" }], [{ path: edited, type: "content" }]);
    await vi.advanceTimersByTimeAsync(250);
    expect(getSkillsSourceVersion(workspaceDir)).toBe(sourceVersion);
    const resourceVersion = getSkillsResourceVersion(workspaceDir);

    // A removed file stays supporting-only; replacing an empty directory does not.
    observeScan(observed, kind === "file" ? [] : [{ path: untouched, kind: "file" }], [
      { path: untouched, type: "structural" },
    ]);
    await vi.advanceTimersByTimeAsync(250);
    expect(getSkillsResourceVersion(workspaceDir)).toBeGreaterThan(resourceVersion);
    if (kind === "file") {
      expect(getSkillsSourceVersion(workspaceDir)).toBe(sourceVersion);
    } else {
      expect(getSkillsSourceVersion(workspaceDir)).toBeGreaterThan(sourceVersion);
      const replacedVersion = getSkillsSourceVersion(workspaceDir);
      observeScan(observed, [], [{ path: untouched, type: "structural" }]);
      await vi.advanceTimersByTimeAsync(250);
      expect(getSkillsSourceVersion(workspaceDir)).toBe(replacedVersion);
    }
  },
);

it("keeps discovery conservative after partial scans exhaust the kind cache", async () => {
  const { getSkillsSourceVersion } = await import("./refresh-state.js");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  const workspaceDir = fixture.workspaceDir;
  const root = path.join(workspaceDir, "skills");
  refresh.ensureSkillsWatcher({ workspaceDir });
  await observer.started();
  const observed = observer.forRoot(root);
  const relative = (name: string) =>
    path.relative(observed.authority.rootDir, path.join(root, name));
  const entries: WatchEntry[] = Array.from({ length: 4096 }, (_, index) => ({
    path: relative(`supporting-${index}.md`),
    kind: "file",
  }));
  observeScan(observed, entries);
  await observer.readyAll();
  const originalVersion = getSkillsSourceVersion(workspaceDir);
  const removed = entries[0]!.path;
  observeScan(observed, [], [{ path: removed, type: "structural" }]);
  await vi.advanceTimersByTimeAsync(250);
  expect(getSkillsSourceVersion(workspaceDir)).toBe(originalVersion);

  const added = relative("one-more.md");
  observeScan(observed, [{ path: added, kind: "file" }], []);
  // A later small pass must not make the incomplete cumulative history authoritative.
  for (const seen of [[{ path: removed, kind: "file" as const }], []]) {
    const before = getSkillsSourceVersion(workspaceDir);
    observeScan(observed, seen, [{ path: removed, type: "structural" }]);
    await vi.advanceTimersByTimeAsync(250);
    expect(getSkillsSourceVersion(workspaceDir)).toBeGreaterThan(before);
  }
});

it("closes only the deleted workspace skill watchers", async () => {
  const otherWorkspaceDir = await fixture.createFixtureDirectory("other-workspace");
  await fixture.createFixtureDirectory("other-workspace/skills");
  refresh.ensureSkillsWatcher({ workspaceDir: fixture.workspaceDir });
  refresh.ensureSkillsWatcher({ workspaceDir: otherWorkspaceDir });
  await observer.readyAll();
  const deletedWorkspaceWatch = observer.forRoot(path.join(fixture.workspaceDir, "skills"));
  const otherWorkspaceWatch = observer.forRoot(path.join(otherWorkspaceDir, "skills"));
  let releaseClose: (() => void) | undefined;
  const closeBarrier = new Promise<void>((resolve) => {
    releaseClose = resolve;
  });
  deletedWorkspaceWatch.holdClose(closeBarrier);
  let settled = false;

  const close = refresh.closeSkillsWatchersForWorkspace(fixture.workspaceDir).then(() => {
    settled = true;
  });
  await Promise.resolve();

  expect(deletedWorkspaceWatch.close).toHaveBeenCalledOnce();
  expect(otherWorkspaceWatch.close).not.toHaveBeenCalled();
  expect(settled).toBe(false);
  releaseClose?.();
  await close;
  expect(settled).toBe(true);
});

it("rejects workspace drainage when its physical watcher cannot close", async () => {
  const otherWorkspaceDir = await fixture.createFixtureDirectory("other-workspace");
  await fixture.createFixtureDirectory("other-workspace/skills");
  refresh.ensureSkillsWatcher({ workspaceDir: otherWorkspaceDir });
  await observer.readyAll();
  const otherWorkspaceWatch = observer.forRoot(path.join(otherWorkspaceDir, "skills"));
  const registry = await import("./refresh-watch-registry.js");
  const targetPath = path.join(fixture.workspaceDir, "skills");
  const watcherKey = JSON.stringify([fixture.workspaceDir, undefined, undefined]);
  const closeFailure = Promise.reject(new Error("synthetic watcher close failure"));
  void closeFailure.catch(() => {});
  const close = vi.fn(() => closeFailure);
  registry.pathWatchers.set(targetPath, {
    closed: false,
    close,
    refreshScope: vi.fn(async () => {}),
    depth: 7,
    initialScan: "ready",
    unavailable: false,
    verified: true,
    failed: false,
    recovering: false,
    replacing: false,
    subscribers: new Set([watcherKey]),
  });
  registry.workspaceWatchOwners.set(watcherKey, {
    workspaceDir: fixture.workspaceDir,
    sourceScope: {},
    sharedScanPending: false,
    unavailable: false,
  });
  registry.workspaceWatchTargets.set(watcherKey, [
    { path: targetPath, authorityPath: fixture.workspaceDir, depth: 7 },
  ]);

  await expect(refresh.closeSkillsWatchersForWorkspace(fixture.workspaceDir)).rejects.toThrow(
    "synthetic watcher close failure",
  );

  expect(registry.pathWatchers.get(targetPath)).toMatchObject({
    failed: true,
  });
  expect(
    Array.from(registry.workspaceWatchOwners.values()).some(
      (owner) => owner.workspaceDir === fixture.workspaceDir,
    ),
  ).toBe(true);
  await expect(refresh.closeSkillsWatchersForWorkspace(fixture.workspaceDir)).rejects.toThrow(
    "synthetic watcher close failure",
  );
  expect(close).toHaveBeenCalledTimes(2);
  expect(otherWorkspaceWatch.close).not.toHaveBeenCalled();
});
