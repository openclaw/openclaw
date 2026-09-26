import fs from "node:fs/promises";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  bumpSkillsSnapshotVersion,
  getSkillsResourceVersion,
  getSkillsSnapshotVersion,
  getSkillsSourceVersion,
} from "./refresh-state.js";
import {
  createSkillsWatcherMock,
  useSkillsWatcherFixture,
} from "./refresh.watcher.test-support.js";

type SkillsChangeEvent = NonNullable<Parameters<typeof bumpSkillsSnapshotVersion>[0]>;
const observer = createSkillsWatcherMock();
const { watchMock } = observer;
let refreshModule: typeof import("./refresh.js");
let buildSkillSnapshot: typeof import("../loading/workspace-skill-prompt.js").buildSkillSnapshot;
let syncWorkspaceSkills: typeof import("../loading/workspace-skill-sync.runtime.js").syncWorkspaceSkills;
let fixtureWorkspaceDir: string;

vi.mock("@openclaw/fs-safe/watch", () => ({ watch: watchMock }));
vi.mock("../loading/plugin-skills.js", () => ({
  resolvePluginSkillRoots: () => [],
  resolvePluginSkillRootsFromMetadata: () => [],
}));

describe("skills watcher churn", () => {
  const fixture = useSkillsWatcherFixture(observer);
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
    fixtureWorkspaceDir = fixture.workspaceDir;
  });

  it("keeps due work independent of another target's later debounce deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const workspaceDir = fixtureWorkspaceDir;
    const secondWorkspace = await createFixtureDirectory("later-workspace");
    const laterRoot = await createFixtureDirectory("later-workspace/skills");
    refreshModule.ensureSkillsWatcher({ workspaceDir });
    await observer.readyAll();
    refreshModule.ensureSkillsWatcher({ workspaceDir: secondWorkspace });
    await observer.readyAll();
    const seen: SkillsChangeEvent[] = [];
    refreshModule.registerSkillsChangeListener((change) => seen.push(change));
    const firstPath = path.join(workspaceDir, "skills", "guide", "SKILL.md");
    const laterPath = path.join(laterRoot, "guide", "SKILL.md");
    observer.forRoot(path.join(workspaceDir, "skills")).change(firstPath);
    await vi.advanceTimersByTimeAsync(200);
    observer.forRoot(laterRoot).change(laterPath);
    await vi.advanceTimersByTimeAsync(50);
    expect(seen).toEqual([{ workspaceDir, reason: "watch", changedPath: firstPath }]);
    await vi.advanceTimersByTimeAsync(199);
    expect(seen).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(seen).toEqual([
      { workspaceDir, reason: "watch", changedPath: firstPath },
      { workspaceDir: secondWorkspace, reason: "watch", changedPath: laterPath },
    ]);
  });

  it("retains shared supporting resources alongside an execution-only discovery change", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const workspaceDir = fixtureWorkspaceDir;
    const executionWorkspaceDir = await createFixtureDirectory("mixed-execution");
    const executionRoot = await createFixtureDirectory("mixed-execution/skills");
    const skillDir = await createFixtureDirectory("workspace/skills/demo");
    const scriptDir = await createFixtureDirectory("workspace/skills/demo/scripts");
    const targetWorkspaceDir = await createFixtureDirectory("mixed-sandbox");
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\nname: demo\ndescription: Demo\n---\n",
    );
    const scriptPath = path.join(scriptDir, "run.sh");
    await fs.writeFile(scriptPath, "before");
    await withEnvAsync({ OPENCLAW_STATE_DIR: workspaceDir }, async () => {
      refreshModule.ensureSkillsWatcher({ workspaceDir, executionWorkspaceDir });
      await observer.readyAll();
      const loadOptions = {
        bundledSkillsDir: "",
        managedSkillsDir: path.join(workspaceDir, "missing"),
      };
      const skillsSnapshot = await buildSkillSnapshot(workspaceDir, loadOptions);
      const syncOptions = {
        sourceWorkspaceDir: workspaceDir,
        targetWorkspaceDir,
        skillsSnapshot,
        ...loadOptions,
      };
      await syncWorkspaceSkills(syncOptions);
      const baseVersion = getSkillsSourceVersion(workspaceDir);
      const resourceVersion = getSkillsResourceVersion(workspaceDir);
      const executionVersion = getSkillsSourceVersion(workspaceDir, { executionWorkspaceDir });
      await fs.writeFile(scriptPath, "after");
      observer.forRoot(path.join(workspaceDir, "skills")).change(scriptPath, "content");
      observer.forRoot(executionRoot).change(path.join(executionRoot, "guide", "SKILL.md"));
      await vi.advanceTimersByTimeAsync(250);
      expect(getSkillsSourceVersion(workspaceDir)).toBe(baseVersion);
      expect(getSkillsResourceVersion(workspaceDir)).toBeGreaterThan(resourceVersion);
      expect(getSkillsSourceVersion(workspaceDir, { executionWorkspaceDir })).toBeGreaterThan(
        executionVersion,
      );
      await syncWorkspaceSkills(syncOptions);
      const copiedScript = path.join(targetWorkspaceDir, "skills", "demo", "scripts", "run.sh");
      expect(await fs.readFile(copiedScript, "utf8")).toBe("after");
    });
  });

  it("refreshes supporting-file sandbox copies without refreshing skills", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
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
      await observer.readyAll();
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
      const watcher = observer.forRoot(path.join(workspaceDir, "skills"));
      watcher.change(scriptPath, "content");
      await vi.advanceTimersByTimeAsync(250);
      await syncWorkspaceSkills(syncOptions);

      expect(await fs.readFile(copiedScript, "utf8")).toBe("after");
      expect(getSkillsSnapshotVersion(workspaceDir)).toBe(version);
      expect(getSkillsSourceVersion(workspaceDir)).toBe(sourceVersion);
      expect(changed).not.toHaveBeenCalled();
    });
  });

  it("does not delay a pending skill refresh for later supporting-file churn", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const workspaceDir = fixtureWorkspaceDir;
    refreshModule.ensureSkillsWatcher({ workspaceDir });
    await observer.readyAll();
    const root = path.join(workspaceDir, "skills");
    const watcher = observer.forRoot(root);
    const changed = vi.fn();
    refreshModule.registerSkillsChangeListener(changed);
    const skillPath = path.join(root, "demo", "SKILL.md");
    watcher.change(path.join(root, "demo", "README.md"), "content");
    watcher.change(skillPath);
    await vi.advanceTimersByTimeAsync(200);
    watcher.change(path.join(root, "demo", "README.md"), "content");
    await vi.advanceTimersByTimeAsync(50);

    expect(changed).toHaveBeenCalledExactlyOnceWith({
      workspaceDir,
      reason: "watch",
      changedPath: skillPath,
    });
  });

  it("refreshes source-origin identity metadata at maximum discovery depth", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
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
      await observer.readyAll();
      const watched = observer.forRoot(path.join(workspaceDir, "skills"));
      const loadOptions = {
        bundledSkillsDir: "",
        managedSkillsDir: path.join(workspaceDir, "missing-managed"),
      };
      const before = await buildSkillSnapshot(workspaceDir, loadOptions);
      expect(before.skills[0]?.skillKey).toBe("origin-before");
      // Library tree depth selects entries, not Chokidar directory traversal depth.
      // At loader depth six, the metadata file itself needs two more levels.
      const metadataDepth = path
        .relative(path.join(workspaceDir, "skills"), originPath)
        .split(path.sep).length;
      expect.soft(metadataDepth).toBeLessThanOrEqual(watched.options.scopes[0]!.depth!);
      const version = getSkillsSnapshotVersion(workspaceDir);
      await fs.writeFile(originPath, JSON.stringify({ slug: "origin-after" }));
      watched.change(originPath, "structural");
      await vi.advanceTimersByTimeAsync(250);

      expect.soft(getSkillsSnapshotVersion(workspaceDir)).toBeGreaterThan(version);
      const after = await buildSkillSnapshot(workspaceDir, loadOptions);
      expect(after.skills[0]?.skillKey).toBe("origin-after");
    });
  });

  it("scopes a new worktree watch subscription to its owning workspace", async () => {
    const workspaceDir = fixtureWorkspaceDir;
    const otherWorkspace = await createFixtureDirectory("other-workspace");
    const executionWorkspaceDir = await createFixtureDirectory("new-worktree");
    refreshModule.ensureSkillsWatcher({ workspaceDir });
    await observer.readyAll();
    refreshModule.ensureSkillsWatcher({ workspaceDir: otherWorkspace });
    await observer.readyAll();
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
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
      const workspaceDir = fixtureWorkspaceDir;
      const executionWorkspaceDir = await createFixtureDirectory("execution-scope");
      const executionRoot = path.join(executionWorkspaceDir, "skills");
      const config = { skills: { load: { extraDirs: shared ? [executionRoot] : [] } } };
      refreshModule.ensureSkillsWatcher({ workspaceDir, executionWorkspaceDir, config });
      await observer.readyAll();
      const baseVersion = getSkillsSourceVersion(workspaceDir);
      const executionVersion = getSkillsSourceVersion(workspaceDir, { executionWorkspaceDir });
      observer.forRoot(executionRoot).change(path.join(executionRoot, "demo", "SKILL.md"));
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
      observer.forRoot(baseRoot).change(path.join(baseRoot, "demo", "SKILL.md"));
      await vi.advanceTimersByTimeAsync(250);
      expect(getSkillsSourceVersion(workspaceDir)).toBeGreaterThan(beforeSharedEdit);
    },
  );

  it("revalidates base consumers when a ready execution target becomes shared", async () => {
    const workspaceDir = fixtureWorkspaceDir;
    const executionWorkspaceDir = await createFixtureDirectory("promoted-worktree");
    refreshModule.ensureSkillsWatcher({ workspaceDir, executionWorkspaceDir });
    await observer.readyAll();
    const version = getSkillsSourceVersion(workspaceDir);

    refreshModule.ensureSkillsWatcher({
      workspaceDir,
      executionWorkspaceDir,
      config: { skills: { load: { extraDirs: [path.join(executionWorkspaceDir, "skills")] } } },
    });

    await observer.readyAll();
    expect(getSkillsSourceVersion(workspaceDir)).toBeGreaterThan(version);
  });

  it("closes shared initial-scan gaps without revalidating base consumers for later worktrees", async () => {
    const workspaceDir = fixtureWorkspaceDir;
    const firstExecution = await createFixtureDirectory("first-execution");
    const secondExecution = await createFixtureDirectory("second-execution");
    refreshModule.ensureSkillsWatcher({ workspaceDir, executionWorkspaceDir: firstExecution });
    const beforeReady = getSkillsSourceVersion(workspaceDir);
    await observer.readyAll();
    const afterReady = getSkillsSourceVersion(workspaceDir);
    expect(afterReady).toBeGreaterThan(beforeReady);

    refreshModule.ensureSkillsWatcher({ workspaceDir, executionWorkspaceDir: secondExecution });
    expect(getSkillsSourceVersion(workspaceDir)).toBe(afterReady);
    const secondVersion = getSkillsSourceVersion(workspaceDir, {
      executionWorkspaceDir: secondExecution,
    });
    await observer.readyAll();
    expect(getSkillsSourceVersion(workspaceDir)).toBe(afterReady);
    expect(
      getSkillsSourceVersion(workspaceDir, {
        executionWorkspaceDir: secondExecution,
      }),
    ).toBeGreaterThan(secondVersion);
  });
});
