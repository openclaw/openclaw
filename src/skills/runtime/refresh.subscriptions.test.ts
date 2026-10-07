import fs from "node:fs/promises";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../../test-utils/env.js";
import { loadWorkspaceSkills } from "../loading/workspace-skill-loader.js";
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

  it.each(["workspace", "execution"] as const)(
    "keeps the remaining %s subscription alive after disposal",
    async (peer) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
      const workspaceDir = fixtureWorkspaceDir;
      const secondWorkspace =
        peer === "workspace" ? await createFixtureDirectory("second-workspace") : workspaceDir;
      const executionWorkspaceDir =
        peer === "execution" ? await createFixtureDirectory("remaining-worktree") : undefined;
      const sharedRoot =
        peer === "workspace"
          ? await createFixtureDirectory("shared")
          : path.join(workspaceDir, "skills");
      const config = { skills: { load: { extraDirs: [sharedRoot] } } };
      refreshModule.ensureSkillsWatcher({ workspaceDir, config });
      refreshModule.ensureSkillsWatcher({
        workspaceDir: secondWorkspace,
        executionWorkspaceDir,
        config,
      });
      await observer.readyAll();
      const watcher = observer.forRoot(sharedRoot);
      const seen: SkillsChangeEvent[] = [];
      refreshModule.registerSkillsChangeListener((change) => seen.push(change));
      const changedPath = path.join(sharedRoot, "demo", "SKILL.md");
      if (peer === "execution") {
        watcher.change(changedPath);
        await vi.advanceTimersByTimeAsync(250);
        expect(seen).toEqual([{ workspaceDir, reason: "watch", changedPath }]);
        seen.length = 0;
      }
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
      expect(seen).toEqual([{ workspaceDir: secondWorkspace, reason: "watch", changedPath }]);
    },
  );

  it.each(["disable", "idle", "refreshed"] as const)(
    "preserves versions through %s subscription retirement or renewal",
    async (mode) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const workspaceDir = fixtureWorkspaceDir;
      const otherWorkspace = await createFixtureDirectory("other-workspace");
      refreshModule.ensureSkillsWatcher({ workspaceDir: otherWorkspace });
      refreshModule.ensureSkillsWatcher({ workspaceDir });
      await observer.readyAll();
      const watcher = observer.forRoot(path.join(workspaceDir, "skills"));
      const version = bumpSkillsSnapshotVersion({
        workspaceDir,
        reason: "watch",
        changedPath: `${workspaceDir}/skills/demo/SKILL.md`,
      });
      const otherVersion = getSkillsSnapshotVersion(otherWorkspace);
      const globalVersion = getSkillsSnapshotVersion();
      if (mode === "disable") {
        refreshModule.ensureSkillsWatcher({
          workspaceDir,
          config: { skills: { load: { watch: false } } },
        });
      } else {
        if (mode === "refreshed") {
          vi.advanceTimersByTime(30 * 60_000);
          refreshModule.ensureSkillsWatcher({ workspaceDir });
          vi.advanceTimersByTime(31 * 60_000);
        } else {
          vi.advanceTimersByTime(60 * 60_000 + 1_000);
        }
        refreshModule.ensureSkillsWatcher({ workspaceDir: otherWorkspace });
      }
      expect(getSkillsSnapshotVersion(workspaceDir)).toBe(version);
      expect(getSkillsSnapshotVersion(otherWorkspace)).toBe(otherVersion);
      expect(getSkillsSnapshotVersion()).toBe(globalVersion);
      if (mode === "refreshed") {
        expect(watcher.close).not.toHaveBeenCalled();
      } else {
        expect(watcher.close).toHaveBeenCalledTimes(1);
        vi.setSystemTime(new Date(version));
        refreshModule.ensureSkillsWatcher({ workspaceDir });
        expect(getSkillsSnapshotVersion(workspaceDir)).toBeGreaterThan(version);
      }
    },
  );

  it.each(["execution", "base"] as const)(
    "keeps an idle %s source active while another consumer remains",
    async (scope) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
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
});
