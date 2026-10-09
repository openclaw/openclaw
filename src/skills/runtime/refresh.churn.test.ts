import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../../test-utils/env.js";
import { loadWorkspaceSkills } from "../loading/workspace-skill-loader.js";
import { buildSkillSnapshot } from "../loading/workspace-skill-prompt.js";
import { syncWorkspaceSkills } from "../loading/workspace-skill-sync.runtime.js";
import {
  bumpSkillsSnapshotVersion,
  getSkillsResourceVersion,
  getSkillsSnapshotVersion,
  getSkillsSourceVersion,
} from "./refresh-state.js";
import {
  createSkillsWatcherMock,
  useSkillsWatcherFixture,
  waitForSkillsWatcherTurn,
} from "./refresh.watcher.test-support.js";

type SkillsChangeEvent = NonNullable<Parameters<typeof bumpSkillsSnapshotVersion>[0]>;
const observer = createSkillsWatcherMock();
const { watchMock } = observer;
let refreshModule: typeof import("./refresh.js");
let fixtureWorkspaceDir: string;

vi.mock("@openclaw/fs-safe/watch", () => ({ watch: watchMock }));
vi.mock("../loading/plugin-skills.js", () => ({
  resolvePluginSkillRoots: () => [],
  resolvePluginSkillRootsFromMetadata: () => [],
}));

describe("skills watcher changes and subscriptions", () => {
  const fixture = useSkillsWatcherFixture(observer);
  const { createFixtureDirectory } = fixture;
  beforeAll(async () => {
    refreshModule = await import("./refresh.js");
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

  it("refreshes supporting copies with execution discovery in the same batch", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const workspaceDir = fixtureWorkspaceDir;
    const executionWorkspaceDir = await createFixtureDirectory("mixed-execution");
    const executionRoot = await createFixtureDirectory("mixed-execution/skills");
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
      refreshModule.ensureSkillsWatcher({ workspaceDir, executionWorkspaceDir });
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
      const copiedScript = path.join(targetWorkspaceDir, "skills", "demo", "scripts", "run.sh");
      await syncWorkspaceSkills(syncOptions);
      expect(await fs.readFile(copiedScript, "utf8")).toBe("before");
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
      expect(await fs.readFile(copiedScript, "utf8")).toBe("after");
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

  it("isolates siblings beneath the same admitted ancestor", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const parent = await createFixtureDirectory("shared-ancestor");
    const secondWorkspace = await createFixtureDirectory("second-workspace");
    const roots = [path.join(parent, "left", "skills"), path.join(parent, "right", "skills")];
    refreshModule.ensureSkillsWatcher({
      workspaceDir: fixtureWorkspaceDir,
      config: { skills: { load: { extraDirs: [roots[0]!] } } },
    });
    refreshModule.ensureSkillsWatcher({
      workspaceDir: secondWorkspace,
      config: { skills: { load: { extraDirs: [roots[1]!] } } },
    });
    await observer.readyAll();
    const seen: SkillsChangeEvent[] = [];
    refreshModule.registerSkillsChangeListener((event) => seen.push(event));
    const first = observer.forRoot(roots[0]!);
    first.change(path.join(roots[1]!, "foreign", "SKILL.md"));
    await vi.advanceTimersByTimeAsync(250);
    expect(seen).toEqual([]);
    const changedPath = path.join(roots[0]!, "new", "SKILL.md");
    first.change(changedPath);
    await vi.advanceTimersByTimeAsync(250);
    expect(seen).toEqual([{ workspaceDir: fixtureWorkspaceDir, reason: "watch", changedPath }]);
  });

  it.each(["ensure", "dispose", "reacquire"] as const)(
    "revalidates a later workspace after a listener performs %s",
    async (action) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
      const secondWorkspace = await createFixtureDirectory("reentrant-workspace");
      const sharedRoot = await createFixtureDirectory("reentrant-shared");
      const config = { skills: { load: { extraDirs: [sharedRoot] } } };
      refreshModule.ensureSkillsWatcher({ workspaceDir: fixtureWorkspaceDir, config });
      refreshModule.ensureSkillsWatcher({ workspaceDir: secondWorkspace, config });
      await observer.readyAll();
      const seen: SkillsChangeEvent[] = [];
      refreshModule.registerSkillsChangeListener((change) => {
        if (change.reason !== "watch") {
          return;
        }
        seen.push(change);
        if (change.workspaceDir !== fixtureWorkspaceDir) {
          return;
        }
        if (action !== "ensure") {
          refreshModule.ensureSkillsWatcher({
            workspaceDir: secondWorkspace,
            config: { skills: { load: { watch: false } } },
          });
        }
        if (action !== "dispose") {
          refreshModule.ensureSkillsWatcher({ workspaceDir: secondWorkspace, config });
        }
      });
      const changedPath = path.join(sharedRoot, "guide", "SKILL.md");
      observer.forRoot(sharedRoot).change(changedPath);
      await vi.advanceTimersByTimeAsync(250);
      expect(seen).toEqual([
        { workspaceDir: fixtureWorkspaceDir, reason: "watch", changedPath },
        ...(action === "ensure"
          ? [{ workspaceDir: secondWorkspace, reason: "watch", changedPath }]
          : []),
      ]);
    },
  );

  it("keeps the remaining execution subscription alive after disposal", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const workspaceDir = fixtureWorkspaceDir;
    const executionWorkspaceDir = await createFixtureDirectory("remaining-worktree");
    const sharedRoot = path.join(workspaceDir, "skills");
    const config = { skills: { load: { extraDirs: [sharedRoot] } } };
    refreshModule.ensureSkillsWatcher({ workspaceDir, config });
    refreshModule.ensureSkillsWatcher({
      workspaceDir,
      executionWorkspaceDir,
      config,
    });
    await observer.readyAll();
    const watcher = observer.forRoot(sharedRoot);
    const seen: SkillsChangeEvent[] = [];
    refreshModule.registerSkillsChangeListener((change) => seen.push(change));
    const changedPath = path.join(sharedRoot, "demo", "SKILL.md");
    watcher.change(changedPath);
    await vi.advanceTimersByTimeAsync(250);
    expect(seen).toEqual([{ workspaceDir, reason: "watch", changedPath }]);
    seen.length = 0;
    const version = getSkillsSnapshotVersion(workspaceDir);
    const globalVersion = getSkillsSnapshotVersion();
    refreshModule.ensureSkillsWatcher({
      workspaceDir,
      config: { skills: { load: { ...config.skills.load, watch: false } } },
    });
    expect(watcher.close).not.toHaveBeenCalled();
    expect(getSkillsSnapshotVersion(workspaceDir)).toBe(version);
    expect(getSkillsSnapshotVersion()).toBe(globalVersion);
    expect(seen).toEqual([]);
    watcher.change(changedPath);
    await vi.advanceTimersByTimeAsync(250);
    expect(seen).toEqual([{ workspaceDir, reason: "watch", changedPath }]);
  });

  it("keeps an idle execution source active while another consumer remains", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const workspaceDir = fixtureWorkspaceDir;
    const executionWorkspaceDir = await createFixtureDirectory("shared-execution");
    const idleScope = { executionWorkspaceDir };
    const skillDir = await createFixtureDirectory("shared-execution/skills/demo");
    const skillFile = path.join(skillDir, "SKILL.md");
    await fs.writeFile(
      skillFile,
      "---\nname: demo\ndescription: Demo\n---\nOriginal instructions\n",
    );
    await withEnvAsync({ OPENCLAW_STATE_DIR: workspaceDir }, async () => {
      const options = {
        ...idleScope,
        agentId: "agent-b",
        bundledSkillsDir: "",
        managedSkillsDir: path.join(workspaceDir, "missing-managed"),
      };
      const original = loadWorkspaceSkills(workspaceDir, options)[0]!.skill.contentHash;
      refreshModule.ensureSkillsWatcher({
        workspaceDir,
        ...idleScope,
        agentId: "agent-a",
      });
      refreshModule.ensureSkillsWatcher({
        workspaceDir,
        executionWorkspaceDir,
        agentId: "agent-b",
      });
      vi.advanceTimersByTime(30 * 60_000);
      refreshModule.ensureSkillsWatcher({
        workspaceDir,
        executionWorkspaceDir,
        agentId: "agent-b",
      });
      const sourceVersion = getSkillsSourceVersion(workspaceDir, idleScope);
      vi.advanceTimersByTime(31 * 60_000);
      refreshModule.ensureSkillsWatcher({
        workspaceDir,
        executionWorkspaceDir,
        agentId: "agent-b",
      });
      expect(getSkillsSourceVersion(workspaceDir, idleScope)).toBe(sourceVersion);

      const version = getSkillsSnapshotVersion(workspaceDir);
      await fs.appendFile(skillFile, "\nUpdated instructions\n");
      bumpSkillsSnapshotVersion({ reason: "workshop" });
      expect(getSkillsSnapshotVersion(workspaceDir)).toBeGreaterThan(version);
      expect(loadWorkspaceSkills(workspaceDir, options)[0]!.skill.contentHash).not.toBe(original);

      vi.advanceTimersByTime(60 * 60_000 + 1_000);
      refreshModule.ensureSkillsWatcher({
        workspaceDir: await createFixtureDirectory("other-active-workspace"),
      });
      const retiredVersion = getSkillsSnapshotVersion(workspaceDir);
      await fs.appendFile(skillFile, "\nInstructions changed while retired\n");
      bumpSkillsSnapshotVersion({ reason: "workshop" });
      expect(getSkillsSnapshotVersion(workspaceDir)).toBe(retiredVersion);

      refreshModule.ensureSkillsWatcher({
        workspaceDir,
        executionWorkspaceDir,
      });
      expect(getSkillsSnapshotVersion(workspaceDir)).toBeGreaterThan(retiredVersion);
    });
  });

  it("does not retain the requesting turn context through initial observation or recovery", async () => {
    const caller = new AsyncLocalStorage<string>();
    const seen: Array<string | undefined> = [];
    const start = observer.watchMock.getMockImplementation()!;
    observer.watchMock.mockImplementation((authority, options) => {
      seen.push(caller.getStore());
      return start(authority, options);
    });
    try {
      const params = { workspaceDir: fixture.workspaceDir };
      caller.run("initial-turn", () => refreshModule.ensureSkillsWatcher(params));
      await observer.readyAll();
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((context) => context === undefined)).toBe(true);
      const initialCount = seen.length;
      const original = observer.forRoot(path.join(fixture.workspaceDir, "skills"));
      const { pathWatchers } = await import("./refresh-watch-registry.js");
      const setScopes = original.subscription.setScopes.bind(original.subscription);
      original.subscription.setScopes = (scopes) => {
        seen.push(caller.getStore());
        return setScopes(scopes);
      };
      const state = pathWatchers.get(
        path.join(fixture.workspaceDir, "skills").replaceAll("\\", "/"),
      )!;
      state.depth += 1;
      await caller.run("scope-turn", () => state.refreshScope());
      expect(seen).toHaveLength(initialCount + 1);
      expect(seen.at(-1)).toBeUndefined();
      caller.run("later-turn", () => original.fail(new Error("lost coverage")));
      await original.close();
      await waitForSkillsWatcherTurn();
      await observer.readyAll();
      expect(seen.every((context) => context === undefined)).toBe(true);
      expect(observer.forRoot(path.join(fixture.workspaceDir, "skills")).subscription).not.toBe(
        original.subscription,
      );
    } finally {
      observer.watchMock.mockImplementation(start);
    }
  });
});
