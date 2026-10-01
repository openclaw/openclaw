import fs from "node:fs/promises";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  bumpSkillsSnapshotVersion,
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
let fixtureWorkspaceDir: string;

vi.mock("@openclaw/fs-safe/watch", () => ({ watch: watchMock }));
vi.mock("../loading/plugin-skills.js", () => ({
  resolvePluginSkillRoots: () => [],
  resolvePluginSkillRootsFromMetadata: () => [],
}));

describe("skills watcher subscription lifecycle", () => {
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

  it("stops fanning a shared-directory change to a workspace after it unsubscribes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const secondWorkspace = await createFixtureDirectory("second-workspace");
    const sharedRoot = await createFixtureDirectory("shared");
    const config = { skills: { load: { extraDirs: [sharedRoot] } } };
    const seen: SkillsChangeEvent[] = [];
    refreshModule.registerSkillsChangeListener((change) => {
      seen.push(change);
    });
    refreshModule.ensureSkillsWatcher({ workspaceDir: fixtureWorkspaceDir, config });
    refreshModule.ensureSkillsWatcher({ workspaceDir: secondWorkspace, config });
    await observer.readyAll();
    const sharedWatcher = observer.forRoot(sharedRoot);

    refreshModule.ensureSkillsWatcher({
      workspaceDir: fixtureWorkspaceDir,
      config: { skills: { load: { extraDirs: [sharedRoot], watch: false } } },
    });
    seen.length = 0;
    expect(sharedWatcher.close).not.toHaveBeenCalled();
    const changedPath = path.join(sharedRoot, "demo", "SKILL.md");
    sharedWatcher.change(changedPath);
    await vi.advanceTimersByTimeAsync(250);

    expect(seen).toEqual([{ workspaceDir: secondWorkspace, reason: "watch", changedPath }]);
  });

  it("preserves workspace invalidation on watch disable without changing other workspaces", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const workspaceDir = fixtureWorkspaceDir;
    const otherWorkspace = await createFixtureDirectory("other-workspace");
    refreshModule.ensureSkillsWatcher({ workspaceDir: otherWorkspace });
    const otherVersion = getSkillsSnapshotVersion(otherWorkspace);
    const globalVersion = getSkillsSnapshotVersion();
    refreshModule.ensureSkillsWatcher({
      workspaceDir,
      config: { skills: { load: {} } },
    });

    const firstVersion = bumpSkillsSnapshotVersion({
      workspaceDir,
      reason: "watch",
      changedPath: `${workspaceDir}/skills/demo/SKILL.md`,
    });
    refreshModule.ensureSkillsWatcher({
      workspaceDir,
      config: { skills: { load: { watch: false } } },
    });

    const nextVersion = getSkillsSnapshotVersion(workspaceDir);
    expect(nextVersion).toBe(firstVersion);
    expect(getSkillsSnapshotVersion(otherWorkspace)).toBe(otherVersion);
    expect(getSkillsSnapshotVersion()).toBe(globalVersion);
    vi.setSystemTime(new Date(nextVersion));
    refreshModule.ensureSkillsWatcher({ workspaceDir });
    expect(getSkillsSnapshotVersion(workspaceDir)).toBeGreaterThan(nextVersion);
  });

  it("evicts idle workspace subscriptions on a later ensure call", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const idleWorkspaceDir = fixtureWorkspaceDir;
    const activeWorkspaceDir = await createFixtureDirectory("workspace-active");
    refreshModule.ensureSkillsWatcher({
      workspaceDir: idleWorkspaceDir,
      config: { skills: { load: {} } },
    });
    await observer.readyAll();
    const idleSkillsWatcher = observer.forRoot(path.join(idleWorkspaceDir, "skills"));
    const firstVersion = bumpSkillsSnapshotVersion({
      workspaceDir: idleWorkspaceDir,
      reason: "watch",
    });
    const globalVersion = getSkillsSnapshotVersion();

    vi.advanceTimersByTime(60 * 60_000 + 1_000);
    refreshModule.ensureSkillsWatcher({
      workspaceDir: activeWorkspaceDir,
      config: { skills: { load: {} } },
    });

    expect(idleSkillsWatcher.close).toHaveBeenCalledTimes(1);
    const evictedVersion = getSkillsSnapshotVersion(idleWorkspaceDir);
    expect(evictedVersion).toBe(firstVersion);
    expect(getSkillsSnapshotVersion()).toBe(globalVersion);
    vi.setSystemTime(new Date(evictedVersion));
    refreshModule.ensureSkillsWatcher({ workspaceDir: idleWorkspaceDir });
    expect(getSkillsSnapshotVersion(idleWorkspaceDir)).toBeGreaterThan(evictedVersion);
  });

  it("keeps another execution subscription for the workspace alive after disposal", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const workspaceDir = fixtureWorkspaceDir;
    const executionWorkspaceDir = await createFixtureDirectory("remaining-worktree");
    refreshModule.ensureSkillsWatcher({ workspaceDir });
    refreshModule.ensureSkillsWatcher({ workspaceDir, executionWorkspaceDir });
    await observer.readyAll();
    const version = getSkillsSnapshotVersion(workspaceDir);
    const globalVersion = getSkillsSnapshotVersion();
    await observer.readyAll();
    const watcher = observer.forRoot(path.join(workspaceDir, "skills"));
    const seen: SkillsChangeEvent[] = [];
    refreshModule.registerSkillsChangeListener((change) => seen.push(change));

    refreshModule.ensureSkillsWatcher({
      workspaceDir,
      config: { skills: { load: { watch: false } } },
    });

    expect(watcher.close).not.toHaveBeenCalled();
    expect(getSkillsSnapshotVersion(workspaceDir)).toBe(version);
    expect(getSkillsSnapshotVersion()).toBe(globalVersion);
    expect(seen).toEqual([]);
    const changedPath = path.join(workspaceDir, "skills", "demo", "SKILL.md");
    watcher.change(changedPath);
    await vi.advanceTimersByTimeAsync(250);
    expect(seen).toEqual([{ workspaceDir, reason: "watch", changedPath }]);
  });

  it("keeps refreshed workspace subscriptions within the idle TTL", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const activeWorkspaceDir = fixtureWorkspaceDir;
    const otherWorkspaceDir = await createFixtureDirectory("workspace-other");
    refreshModule.ensureSkillsWatcher({
      workspaceDir: activeWorkspaceDir,
      config: { skills: { load: {} } },
    });
    await observer.readyAll();
    const activeSkillsWatcher = observer.forRoot(path.join(activeWorkspaceDir, "skills"));

    vi.advanceTimersByTime(30 * 60_000);
    refreshModule.ensureSkillsWatcher({
      workspaceDir: activeWorkspaceDir,
      config: { skills: { load: {} } },
    });
    vi.advanceTimersByTime(31 * 60_000);
    refreshModule.ensureSkillsWatcher({
      workspaceDir: otherWorkspaceDir,
      config: { skills: { load: {} } },
    });

    expect(activeSkillsWatcher.close).not.toHaveBeenCalled();
  });

  it.each(["execution", "base"] as const)(
    "keeps an idle %s source active while another consumer remains",
    async (scope) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
      const { loadWorkspaceSkills } = await import("../loading/workspace-skill-loader.js");
      const workspaceDir = fixtureWorkspaceDir;
      const executionWorkspaceDir = await createFixtureDirectory("shared-execution");
      const idleScope = {
        executionWorkspaceDir: scope === "execution" ? executionWorkspaceDir : undefined,
      };
      const skillDir = await createFixtureDirectory(
        scope === "execution" ? "shared-execution/skills/demo" : "workspace/skills/demo",
      );
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
          executionWorkspaceDir:
            scope === "base"
              ? await createFixtureDirectory("new-execution-workspace")
              : executionWorkspaceDir,
        });
        expect(getSkillsSnapshotVersion(workspaceDir)).toBeGreaterThan(retiredVersion);
      });
    },
  );

  it("fans shared discovery out once per workspace across execution subscriptions", async () => {
    const workspaceDir = fixtureWorkspaceDir;
    const first = await createFixtureDirectory("execution-one");
    const second = await createFixtureDirectory("execution-two");
    refreshModule.ensureSkillsWatcher({ workspaceDir, executionWorkspaceDir: first });
    refreshModule.ensureSkillsWatcher({ workspaceDir, executionWorkspaceDir: second });
    await observer.readyAll();
    const seen = vi.fn();
    refreshModule.registerSkillsChangeListener(seen);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const changedPath = path.join(workspaceDir, "skills", "demo", "SKILL.md");
    observer.forRoot(path.join(workspaceDir, "skills")).change(changedPath);
    await vi.advanceTimersByTimeAsync(250);
    expect(seen).toHaveBeenCalledExactlyOnceWith({ workspaceDir, reason: "watch", changedPath });
  });
});
