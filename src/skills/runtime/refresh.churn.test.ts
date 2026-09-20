import fs from "node:fs/promises";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  type bumpSkillsSnapshotVersion,
  getSkillsSnapshotVersion,
  getSkillsSourceVersion,
} from "./refresh-state.js";
import {
  createSkillsWatcherMock,
  useSkillsWatcherFixture,
} from "./refresh.watcher.test-support.js";

type SkillsChangeEvent = NonNullable<Parameters<typeof bumpSkillsSnapshotVersion>[0]>;
const { createdWatchers, watchMock, watchForSkillRoot } = createSkillsWatcherMock();
let refreshModule: typeof import("./refresh.js");
let buildSkillSnapshot: typeof import("../loading/workspace-skill-prompt.js").buildSkillSnapshot;
let syncWorkspaceSkills: typeof import("../loading/workspace-skill-sync.runtime.js").syncWorkspaceSkills;
let fixtureWorkspaceDir: string;

vi.mock("chokidar", () => ({ default: { watch: watchMock } }));
vi.mock("../loading/plugin-skills.js", () => ({
  resolvePluginSkillRoots: () => [],
  resolvePluginSkillRootsFromMetadata: () => [],
}));

describe("skills watcher churn", () => {
  const fixture = useSkillsWatcherFixture();
  const { createFixtureDirectory } = fixture;
  beforeAll(async () => {
    const [refresh, snapshot, sync] = await Promise.all([
      import("./refresh.js"),
      import("../loading/workspace-skill-prompt.js"),
      import("../loading/workspace-skill-sync.runtime.js"),
    ]);
    refreshModule = refresh;
    buildSkillSnapshot = snapshot.buildSkillSnapshot;
    syncWorkspaceSkills = sync.syncWorkspaceSkills;
  });
  beforeEach(() => {
    vi.stubEnv("CHOKIDAR_USEPOLLING", "false");
    watchMock.mockClear();
    createdWatchers.length = 0;
    fixtureWorkspaceDir = fixture.workspaceDir;
  });

  it.each(["add", "change", "unlink"] as const)(
    "ignores non-skill file %s events under watched worktrees",
    async (event) => {
      vi.useFakeTimers();
      const workspaceDir = fixtureWorkspaceDir;
      const executionWorkspaceDir = await createFixtureDirectory("busy-worktree");
      for (const root of [workspaceDir, executionWorkspaceDir]) {
        for (const directory of ["skills", ".agents/skills"]) {
          await fs.mkdir(path.join(root, directory), { recursive: true });
        }
      }
      refreshModule.ensureSkillsWatcher({ workspaceDir, executionWorkspaceDir });
      const version = getSkillsSnapshotVersion(workspaceDir);
      const seen: SkillsChangeEvent[] = [];
      refreshModule.registerSkillsChangeListener((change) => seen.push(change));
      for (const root of [workspaceDir, executionWorkspaceDir]) {
        for (const directory of ["skills", ".agents/skills"]) {
          const skillRoot = path.join(root, directory);
          const watcher = watchForSkillRoot(skillRoot).watcher;
          for (const file of ["README.md", "scripts/worker.ts", "notes.txt"]) {
            const changedPath = path.join(skillRoot, "demo", file);
            await fs.mkdir(path.dirname(changedPath), { recursive: true });
            await fs.writeFile(changedPath, "unrelated worktree output");
            watcher.emit("all", event, changedPath);
            watcher.emit("raw", "change", path.basename(changedPath), {
              watchedPath: path.dirname(changedPath),
            });
          }
        }
      }
      await vi.advanceTimersByTimeAsync(500);

      expect(getSkillsSnapshotVersion(workspaceDir)).toBe(version);
      expect(seen).toEqual([]);
    },
  );

  it.each(["all", "raw"] as const)(
    "refreshes supporting-file sandbox copies from %s events without refreshing skills",
    async (event) => {
      vi.useFakeTimers();
      const workspaceDir = fixtureWorkspaceDir;
      const skillDir = await createFixtureDirectory("workspace/skills/demo");
      const scriptDir = await createFixtureDirectory("workspace/skills/demo/scripts");
      const targetWorkspaceDir = await createFixtureDirectory("sandbox");
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        "---\nname: demo\ndescription: Demo\n---\nRun scripts/run.sh.\n",
      );
      const scriptPath = path.join(scriptDir, "run.sh");
      await fs.writeFile(scriptPath, "before");
      await withEnvAsync({ OPENCLAW_STATE_DIR: workspaceDir }, async () => {
        refreshModule.ensureSkillsWatcher({ workspaceDir });
        for (const watcher of createdWatchers) {
          watcher.emit("ready");
        }
        const loadOptions = {
          bundledSkillsDir: "",
          managedSkillsDir: path.join(workspaceDir, "missing-managed"),
        };
        const skillsSnapshot = await buildSkillSnapshot(workspaceDir, {
          ...loadOptions,
          snapshotVersion: getSkillsSnapshotVersion(workspaceDir),
        });
        const syncOptions = {
          sourceWorkspaceDir: workspaceDir,
          targetWorkspaceDir,
          skillsSnapshot,
          ...loadOptions,
        };
        await syncWorkspaceSkills(syncOptions);
        const copiedScript = path.join(targetWorkspaceDir, "skills", "demo", "scripts", "run.sh");
        expect(await fs.readFile(copiedScript, "utf8")).toBe("before");
        const version = getSkillsSnapshotVersion(workspaceDir);
        const sourceVersion = getSkillsSourceVersion(workspaceDir);
        const changed = vi.fn();
        refreshModule.registerSkillsChangeListener(changed);

        await fs.writeFile(scriptPath, "after");
        const watcher = watchForSkillRoot(path.join(workspaceDir, "skills")).watcher;
        if (event === "all") {
          watcher.emit("all", "change", scriptPath);
        } else {
          watcher.emit("raw", "change", "run.sh", { watchedPath: scriptDir });
        }
        await vi.advanceTimersByTimeAsync(250);
        await syncWorkspaceSkills(syncOptions);

        expect(await fs.readFile(copiedScript, "utf8")).toBe("after");
        expect(getSkillsSnapshotVersion(workspaceDir)).toBe(version);
        expect(getSkillsSourceVersion(workspaceDir)).toBe(sourceVersion);
        expect(changed).not.toHaveBeenCalled();
      });
    },
  );

  it("does not delay a pending skill refresh for later supporting-file churn", async () => {
    vi.useFakeTimers();
    const workspaceDir = fixtureWorkspaceDir;
    refreshModule.ensureSkillsWatcher({ workspaceDir });
    const root = path.join(workspaceDir, "skills");
    const watcher = watchForSkillRoot(root).watcher;
    const changed = vi.fn();
    refreshModule.registerSkillsChangeListener(changed);
    const skillPath = path.join(root, "demo", "SKILL.md");
    watcher.emit("all", "change", path.join(root, "demo", "README.md"));
    watcher.emit("all", "change", skillPath);
    await vi.advanceTimersByTimeAsync(200);
    watcher.emit("raw", "change", "README.md", { watchedPath: path.join(root, "demo") });
    await vi.advanceTimersByTimeAsync(50);

    expect(changed).toHaveBeenCalledExactlyOnceWith({
      workspaceDir,
      reason: "watch",
      changedPath: skillPath,
    });
  });

  it.each(["all", "raw"] as const)(
    "refreshes source-origin identity metadata from %s events at maximum discovery depth",
    async (event) => {
      vi.useFakeTimers();
      const workspaceDir = fixtureWorkspaceDir;
      const metadataDir = await createFixtureDirectory(
        "workspace/skills/group1/group2/group3/group4/group5/demo/.openclaw",
      );
      const skillDir = path.dirname(metadataDir);
      const originPath = path.join(metadataDir, "source-origin.json");
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        "---\nname: demo\ndescription: Demo\n---\nOriginal instructions\n",
      );
      await fs.writeFile(originPath, JSON.stringify({ slug: "origin-before" }));
      await withEnvAsync({ OPENCLAW_STATE_DIR: workspaceDir }, async () => {
        refreshModule.ensureSkillsWatcher({ workspaceDir });
        for (const watcher of createdWatchers) {
          watcher.emit("ready");
        }
        const watched = watchForSkillRoot(path.join(workspaceDir, "skills"));
        const loadOptions = {
          bundledSkillsDir: "",
          managedSkillsDir: path.join(workspaceDir, "missing-managed"),
        };
        const before = await buildSkillSnapshot(workspaceDir, loadOptions);
        expect(before.skills[0]?.skillKey).toBe("origin-before");
        // The loader admits skills at depth six; their metadata parent adds one level.
        const metadataDepth = path.relative(watched.watchRoot, metadataDir).split(path.sep).length;
        expect.soft(metadataDepth).toBeLessThanOrEqual(watched.options.depth);
        const version = getSkillsSnapshotVersion(workspaceDir);
        await fs.writeFile(originPath, JSON.stringify({ slug: "origin-after" }));
        if (event === "all") {
          watched.watcher.emit("all", "change", originPath);
        } else {
          watched.watcher.emit("raw", "change", "source-origin.json", { watchedPath: metadataDir });
        }
        await vi.advanceTimersByTimeAsync(500);

        expect.soft(getSkillsSnapshotVersion(workspaceDir)).toBeGreaterThan(version);
        const after = await buildSkillSnapshot(workspaceDir, loadOptions);
        expect(after.skills[0]?.skillKey).toBe("origin-after");
      });
    },
  );

  it("scopes a new worktree watch subscription to its owning workspace", async () => {
    const workspaceDir = fixtureWorkspaceDir;
    const otherWorkspace = await createFixtureDirectory("other-workspace");
    const executionWorkspaceDir = await createFixtureDirectory("new-worktree");
    refreshModule.ensureSkillsWatcher({ workspaceDir });
    refreshModule.ensureSkillsWatcher({ workspaceDir: otherWorkspace });
    const version = getSkillsSnapshotVersion(workspaceDir);
    const otherVersion = getSkillsSnapshotVersion(otherWorkspace);
    const globalVersion = getSkillsSnapshotVersion();
    const seen: SkillsChangeEvent[] = [];
    refreshModule.registerSkillsChangeListener((change) => seen.push(change));

    refreshModule.ensureSkillsWatcher({ workspaceDir, executionWorkspaceDir });

    expect(getSkillsSnapshotVersion(workspaceDir)).toBeGreaterThan(version);
    expect(getSkillsSnapshotVersion(otherWorkspace)).toBe(otherVersion);
    expect(getSkillsSnapshotVersion()).toBe(globalVersion);
    expect(seen).toEqual([expect.objectContaining({ workspaceDir, reason: "watch-targets" })]);
  });

  it.each([false, true])(
    "invalidates all base consumers only when an execution root is also shared: %s",
    async (shared) => {
      vi.useFakeTimers();
      const workspaceDir = fixtureWorkspaceDir;
      const executionWorkspaceDir = await createFixtureDirectory("execution-scope");
      const executionRoot = path.join(executionWorkspaceDir, "skills");
      const config = { skills: { load: { extraDirs: shared ? [executionRoot] : [] } } };
      refreshModule.ensureSkillsWatcher({ workspaceDir, executionWorkspaceDir, config });
      const baseVersion = getSkillsSourceVersion(workspaceDir);
      const executionVersion = getSkillsSourceVersion(workspaceDir, { executionWorkspaceDir });
      watchForSkillRoot(executionRoot).watcher.emit(
        "all",
        "change",
        path.join(executionRoot, "demo", "SKILL.md"),
      );
      await vi.advanceTimersByTimeAsync(250);
      expect(getSkillsSourceVersion(workspaceDir, { executionWorkspaceDir })).toBeGreaterThan(
        executionVersion,
      );
      if (shared) {
        expect(getSkillsSourceVersion(workspaceDir)).toBeGreaterThan(baseVersion);
      } else {
        expect(getSkillsSourceVersion(workspaceDir)).toBe(baseVersion);
      }

      const beforeSharedEdit = getSkillsSourceVersion(workspaceDir);
      const baseRoot = path.join(workspaceDir, "skills");
      watchForSkillRoot(baseRoot).watcher.emit(
        "all",
        "change",
        path.join(baseRoot, "demo", "SKILL.md"),
      );
      await vi.advanceTimersByTimeAsync(250);
      expect(getSkillsSourceVersion(workspaceDir)).toBeGreaterThan(beforeSharedEdit);
    },
  );

  it("revalidates base consumers when a ready execution target becomes shared", async () => {
    const workspaceDir = fixtureWorkspaceDir;
    const executionWorkspaceDir = await createFixtureDirectory("promoted-worktree");
    refreshModule.ensureSkillsWatcher({ workspaceDir, executionWorkspaceDir });
    for (const watcher of createdWatchers) {
      watcher.emit("ready");
    }
    const version = getSkillsSourceVersion(workspaceDir);
    const watcherCount = createdWatchers.length;

    refreshModule.ensureSkillsWatcher({
      workspaceDir,
      executionWorkspaceDir,
      config: { skills: { load: { extraDirs: [path.join(executionWorkspaceDir, "skills")] } } },
    });

    expect(createdWatchers).toHaveLength(watcherCount);
    expect(getSkillsSourceVersion(workspaceDir)).toBeGreaterThan(version);
  });

  it("closes shared initial-scan gaps without revalidating base consumers for later worktrees", async () => {
    const workspaceDir = fixtureWorkspaceDir;
    const firstExecution = await createFixtureDirectory("first-execution");
    const secondExecution = await createFixtureDirectory("second-execution");
    refreshModule.ensureSkillsWatcher({ workspaceDir, executionWorkspaceDir: firstExecution });
    const beforeReady = getSkillsSourceVersion(workspaceDir);
    for (const watcher of createdWatchers) {
      watcher.emit("ready");
    }
    const afterReady = getSkillsSourceVersion(workspaceDir);
    expect(afterReady).toBeGreaterThan(beforeReady);
    const watcherCount = createdWatchers.length;

    refreshModule.ensureSkillsWatcher({ workspaceDir, executionWorkspaceDir: secondExecution });
    expect(getSkillsSourceVersion(workspaceDir)).toBe(afterReady);
    const secondVersion = getSkillsSourceVersion(workspaceDir, {
      executionWorkspaceDir: secondExecution,
    });
    for (const watcher of createdWatchers.slice(watcherCount)) {
      watcher.emit("ready");
    }
    expect(getSkillsSourceVersion(workspaceDir)).toBe(afterReady);
    expect(
      getSkillsSourceVersion(workspaceDir, {
        executionWorkspaceDir: secondExecution,
      }),
    ).toBeGreaterThan(secondVersion);
  });

  it.runIf(process.platform !== "win32")(
    "refreshes directory symlink additions and removals without watching file symlinks",
    async () => {
      vi.useFakeTimers();
      const workspaceDir = fixtureWorkspaceDir;
      const target = await createFixtureDirectory("linked-skill");
      const skillFile = path.join(target, "SKILL.md");
      await fs.writeFile(skillFile, "---\nname: linked\ndescription: Linked\n---\n");
      const skillRoot = path.join(workspaceDir, "skills");
      const link = path.join(skillRoot, "linked");
      await fs.symlink(target, link, process.platform === "win32" ? "junction" : "dir");
      refreshModule.ensureSkillsWatcher({ workspaceDir });
      const watched = watchForSkillRoot(skillRoot);
      // Chokidar classifies initial entries even when ignoreInitial suppresses their add events.
      expect(watched.options.ignored(link, await fs.lstat(link))).toBe(false);
      const seen: SkillsChangeEvent[] = [];
      refreshModule.registerSkillsChangeListener((change) => seen.push(change));
      await fs.unlink(link);
      watched.watcher.emit("all", "unlink", link);
      await vi.advanceTimersByTimeAsync(250);
      expect(seen).toEqual([{ workspaceDir, reason: "watch", changedPath: link }]);

      seen.length = 0;
      await fs.symlink(target, link, process.platform === "win32" ? "junction" : "dir");
      expect(watched.options.ignored(link, await fs.lstat(link))).toBe(false);
      watched.watcher.emit("all", "add", link, await fs.lstat(link));
      await vi.advanceTimersByTimeAsync(250);
      expect(seen).toEqual([{ workspaceDir, reason: "watch", changedPath: link }]);

      seen.length = 0;
      const fileLink = path.join(skillRoot, "README.md");
      await fs.symlink(skillFile, fileLink, "file");
      expect(watched.options.ignored(fileLink, await fs.lstat(fileLink))).toBe(false);
      watched.watcher.emit("all", "add", fileLink, await fs.lstat(fileLink));
      await fs.unlink(fileLink);
      watched.watcher.emit("all", "unlink", fileLink);
      await vi.advanceTimersByTimeAsync(250);
      expect(seen).toEqual([]);
    },
  );
});
