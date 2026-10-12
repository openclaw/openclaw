import path from "node:path";
import type { WatchEntry, WatchHealth, WatchInvalidation } from "@openclaw/fs-safe/watch";
import { beforeEach, expect, it, vi } from "vitest";
import "../../test-utils/prepare-compiled-subprocesses.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import type { SkillSnapshot } from "../types.js";
import {
  createSkillsWatcherMock,
  useSkillsWatcherFixture,
} from "./refresh.watcher.test-support.js";

const observer = createSkillsWatcherMock();
const warnings = vi.hoisted(() => vi.fn());
vi.mock("@openclaw/fs-safe/watch", () => ({ watch: observer.watchMock }));
vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      return subsystem === "gateway/skills" ? { ...logger, warn: warnings } : logger;
    },
  };
});
vi.mock("../loading/plugin-skills.js", () => ({
  resolvePluginSkillRoots: vi.fn(() => []),
  resolvePluginSkillRootsFromMetadata: vi.fn(() => []),
}));
// Capacity degradation persists until shutdown; each case owns its module state.
beforeEach(() => vi.resetModules());
const fixture = useSkillsWatcherFixture(observer);
let refresh: typeof import("./refresh.js");
beforeEach(async () => {
  warnings.mockClear();
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

it("honors the polling interval and reports automatic fallback once", async () => {
  const failure = {
    operation: "watch",
    code: "ENOTSUP",
    error: new Error("unsupported backend"),
  } as const;
  vi.stubEnv("CHOKIDAR_USEPOLLING", "false");
  vi.stubEnv("CHOKIDAR_INTERVAL", "40");
  refresh.ensureSkillsWatcher({ workspaceDir: fixture.workspaceDir });
  await observer.readyAll();
  expect(observer.subscriptions.length).toBeGreaterThan(0);
  for (const observed of observer.subscriptions) {
    expect(observed.options.mode).toBe("auto");
    expect(observed.options.pollIntervalMs).toBe(40);
  }
  const observed = observer.forRoot(path.join(fixture.workspaceDir, "skills"));
  for (const state of ["reconciling", "ready", "reconciling", "ready"] as const) {
    const health: WatchHealth = { state, mode: "poll", directories: 1, failure };
    observed.options.onHealth?.(health);
  }
  expect(warnings).toHaveBeenCalledTimes(1);
  expect(warnings).toHaveBeenCalledWith(
    expect.stringContaining(`fallback polling (${path.join(fixture.workspaceDir, "skills")})`),
  );
  expect(warnings).toHaveBeenCalledWith(expect.stringContaining("40 ms"));
  expect(warnings).toHaveBeenCalledWith(
    expect.stringContaining("ENOTSUP: Error: unsupported backend"),
  );
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

it("uses prepared plugin metadata to observe nested companion skills", async () => {
  const plugin = await import("../loading/plugin-skills.js");
  vi.mocked(plugin.resolvePluginSkillRoots).mockClear();
  vi.mocked(plugin.resolvePluginSkillRootsFromMetadata).mockClear();
  const root = await fixture.createFixtureDirectory(".cache/plugin");
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
    for (const included of [
      root,
      path.join(root, "skills"),
      path.join(root, "skills/group/demo"),
    ]) {
      expect(
        observed.options.exclude?.({
          path: path.relative(observed.authority.rootDir, included),
          kind: "directory",
        }),
      ).toBe(false);
    }
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

it("retains an untouched directory kind across a partial watch scan", async () => {
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
    { path: untouched, kind: "directory" },
  ]);
  await observer.readyAll();
  const sourceVersion = getSkillsSourceVersion(workspaceDir);

  // Native content hints visit only the affected directory, omitting its sibling.
  observeScan(observed, [{ path: edited, kind: "file" }], [{ path: edited, type: "content" }]);
  await vi.advanceTimersByTimeAsync(250);
  expect(getSkillsSourceVersion(workspaceDir)).toBe(sourceVersion);
  const resourceVersion = getSkillsResourceVersion(workspaceDir);

  // Replacing an empty directory changes discovery, unlike a supporting-file deletion.
  observeScan(
    observed,
    [{ path: untouched, kind: "file" }],
    [{ path: untouched, type: "structural" }],
  );
  await vi.advanceTimersByTimeAsync(250);
  expect(getSkillsResourceVersion(workspaceDir)).toBeGreaterThan(resourceVersion);
  expect(getSkillsSourceVersion(workspaceDir)).toBeGreaterThan(sourceVersion);
  const replacedVersion = getSkillsSourceVersion(workspaceDir);
  observeScan(observed, [], [{ path: untouched, type: "structural" }]);
  await vi.advanceTimersByTimeAsync(250);
  expect(getSkillsSourceVersion(workspaceDir)).toBe(replacedVersion);
});

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
