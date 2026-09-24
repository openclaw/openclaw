import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import type { SkillSnapshot } from "../types.js";
import { bumpSkillsSnapshotVersion, getSkillsSnapshotVersion } from "./refresh-state.js";
import {
  createSkillsWatcherMock,
  useSkillsWatcherFixture,
} from "./refresh.watcher.test-support.js";

type SkillsChangeEvent = NonNullable<Parameters<typeof bumpSkillsSnapshotVersion>[0]>;

const { createdWatchers, watchMock, nativeWatchMock, watchForSkillRoot } =
  createSkillsWatcherMock();

vi.mock("chokidar", () => ({ default: { watch: watchMock } }));
vi.mock("./refresh-ancestor-native.js", () => ({
  createNativeSkillsAncestorWatcher: nativeWatchMock,
}));
vi.mock("../loading/plugin-skills.js", () => ({
  resolvePluginSkillRoots: () => [],
  resolvePluginSkillRootsFromMetadata: () => [],
}));

let refreshModule: typeof import("./refresh.js");
let fixtureWorkspaceDir: string;

describe("ensureSkillsWatcher", () => {
  const fixture = useSkillsWatcherFixture();
  const { createFixtureDirectory } = fixture;

  beforeAll(async () => {
    refreshModule = await import("./refresh.js");
  });

  beforeEach(() => {
    vi.stubEnv("CHOKIDAR_USEPOLLING", "false");
    watchMock.mockClear();
    createdWatchers.length = 0;
    fixtureWorkspaceDir = fixture.workspaceDir;
  });

  it.each(["before", "after"] as const)(
    "reconciles healthy roots when a scan fails %s its siblings become ready",
    async (order) => {
      vi.useFakeTimers();
      refreshModule.ensureSkillsWatcher({ workspaceDir: fixtureWorkspaceDir });
      const failed = watchForSkillRoot(path.join(fixtureWorkspaceDir, "skills")).watcher;
      const seen: Array<
        Parameters<Parameters<typeof refreshModule.registerSkillsChangeListener>[0]>[0]
      > = [];
      refreshModule.registerSkillsChangeListener((change) => seen.push(change));
      const fail = () =>
        failed.emit("error", Object.assign(new Error("scan failed"), { code: "EIO" }));
      if (order === "before") {
        fail();
      }
      for (const watcher of createdWatchers) {
        if (watcher !== failed) {
          watcher.emit("ready");
        }
      }
      if (order === "after") {
        await vi.advanceTimersByTimeAsync(250);
        expect(seen).toEqual([]);
        fail();
      }
      await vi.advanceTimersByTimeAsync(250);
      const reconciliation = {
        workspaceDir: fixtureWorkspaceDir,
        reason: "watch",
        changedPath: undefined,
      };
      const unavailable = { ...reconciliation, reason: "watch-unavailable" };
      const failedEvents = order === "before" ? [unavailable, reconciliation] : [unavailable];
      expect(seen).toEqual(failedEvents);
      fail();
      await vi.advanceTimersByTimeAsync(250);
      expect(seen).toEqual(failedEvents);
      // A recovered scan first observes a verification; the failed scan alone
      // cannot establish native coverage or publish initial readiness.
      failed.emit("ready");
      expect(seen).toEqual(failedEvents);
      watchForSkillRoot(path.join(fixtureWorkspaceDir, "skills")).watcher.emit("ready");
      expect(seen).toEqual(failedEvents);
      watchForSkillRoot(path.join(fixtureWorkspaceDir, "skills")).watcher.emit("ready");
      await vi.advanceTimersByTimeAsync(250);
      expect(seen).toEqual([...failedEvents, reconciliation]);
    },
  );

  it.each(["EMFILE", "ENFILE", "ENOSPC"])(
    "refreshes shared skill snapshots during preparation after native %s",
    async (code) => {
      const { resolveReusableWorkspaceSkillSnapshot } = await import("./session-snapshot.js");
      const sharedRoot = await createFixtureDirectory("shared/skills");
      const secondWorkspace = await createFixtureDirectory("second-workspace");
      const skillDir = path.join(sharedRoot, "capacity-proof");
      const config = { skills: { load: { extraDirs: [sharedRoot] } } };
      const resolveSnapshot = async (workspaceDir: string, existingSnapshot?: SkillSnapshot) =>
        (
          await resolveReusableWorkspaceSkillSnapshot({
            workspaceDir,
            config,
            skillFilter: ["capacity-proof", "added-proof"],
            existingSnapshot,
          })
        ).snapshot;
      await writeSkill({
        dir: skillDir,
        name: "capacity-proof",
        description: "Amber lantern catalog description.",
      });
      const first = await resolveSnapshot(fixtureWorkspaceDir);
      const second = await resolveSnapshot(secondWorkspace);
      expect(first.prompt).toContain("Amber lantern catalog description.");
      expect(second.prompt).toContain("Amber lantern catalog description.");
      const failedWatcher = watchForSkillRoot(sharedRoot).watcher;
      failedWatcher.emit("error", Object.assign(new Error(code), { code, syscall: "watch" }));
      const watcherCount = createdWatchers.length;
      expect(createdWatchers.every((watcher) => watcher.closed)).toBe(true);
      // Real Chokidar close removes listeners while scan rejections can still arrive.
      expect(() => {
        failedWatcher.emit("error", Object.assign(new Error("late scan"), { code: "EACCES" }));
      }).not.toThrow();

      await writeSkill({
        dir: skillDir,
        name: "capacity-proof",
        description: "Cobalt heron catalog description.",
      });
      const editedFirst = await resolveSnapshot(fixtureWorkspaceDir, first);
      const editedSecond = await resolveSnapshot(secondWorkspace, second);
      for (const snapshot of [editedFirst, editedSecond]) {
        expect(snapshot.prompt).toContain("Cobalt heron catalog description.");
        expect(snapshot.prompt).not.toContain("Amber lantern catalog description.");
      }

      await writeSkill({
        dir: path.join(sharedRoot, "added-proof"),
        name: "added-proof",
        description: "Silver otter new catalog entry.",
      });
      expect((await resolveSnapshot(fixtureWorkspaceDir, editedFirst)).prompt).toContain(
        "Silver otter new catalog entry.",
      );
      expect((await resolveSnapshot(secondWorkspace, editedSecond)).prompt).toContain(
        "Silver otter new catalog entry.",
      );
      const lateWorkspace = await createFixtureDirectory("late-workspace");
      expect((await resolveSnapshot(lateWorkspace)).prompt).toContain(
        "Silver otter new catalog entry.",
      );
      expect(createdWatchers).toHaveLength(watcherCount);

      const disabled = {
        workspaceDir: fixtureWorkspaceDir,
        config: { skills: { load: { watch: false } } },
      };
      refreshModule.ensureSkillsWatcher(disabled);
      const disabledVersion = getSkillsSnapshotVersion(fixtureWorkspaceDir);
      refreshModule.ensureSkillsWatcher(disabled);
      expect(getSkillsSnapshotVersion(fixtureWorkspaceDir)).toBe(disabledVersion);
      expect(createdWatchers).toHaveLength(watcherCount);

      await refreshModule.closeSkillsWatchers();
      refreshModule.ensureSkillsWatcher({ workspaceDir: secondWorkspace, config });
      expect(watchForSkillRoot(sharedRoot).watcher.closed).toBe(false);
    },
  );

  it.each([
    { code: "EACCES", syscall: "watch" },
    { code: "ENOSPC", syscall: "scandir" },
    { code: "EMFILE", syscall: "open" },
  ])("keeps active skill watching after $syscall $code", async ({ code, syscall }) => {
    vi.useFakeTimers();
    refreshModule.ensureSkillsWatcher({ workspaceDir: fixtureWorkspaceDir });
    const watcher = watchForSkillRoot(path.join(fixtureWorkspaceDir, "skills")).watcher;
    watcher.emit("error", Object.assign(new Error(code), { code, syscall }));
    expect(watcher.closed).toBe(false);
    const before = getSkillsSnapshotVersion(fixtureWorkspaceDir);
    watcher.emit("all", "change", path.join(fixtureWorkspaceDir, "skills", "demo", "SKILL.md"));
    await vi.advanceTimersByTimeAsync(250);
    expect(getSkillsSnapshotVersion(fixtureWorkspaceDir)).toBeGreaterThan(before);
  });

  it("does not double-refresh polling SKILL.md changes from raw events", async () => {
    vi.useFakeTimers();
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-watch-polling-raw-"));
    const previousPolling = process.env.CHOKIDAR_USEPOLLING;
    const seen: SkillsChangeEvent[] = [];
    try {
      process.env.CHOKIDAR_USEPOLLING = "true";
      refreshModule.registerSkillsChangeListener((change) => {
        seen.push(change);
      });
      refreshModule.ensureSkillsWatcher({
        workspaceDir,
        config: { skills: { load: {} } },
      });

      seen.length = 0;
      watchForSkillRoot(path.join(workspaceDir, "skills")).watcher.emit(
        "raw",
        "change",
        path.join(workspaceDir, "skills", "demo", "SKILL.md"),
        {
          watchedPath: path.join(workspaceDir, "skills", "demo"),
        },
      );
      await vi.advanceTimersByTimeAsync(500);

      expect(seen).toEqual([]);
    } finally {
      if (previousPolling === undefined) {
        delete process.env.CHOKIDAR_USEPOLLING;
      } else {
        process.env.CHOKIDAR_USEPOLLING = previousPolling;
      }
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("refreshes snapshots from raw directory events for SKILL.md files", async () => {
    vi.useFakeTimers();
    const workspaceDir = fixtureWorkspaceDir;
    const seen: SkillsChangeEvent[] = [];
    refreshModule.registerSkillsChangeListener((change) => {
      seen.push(change);
    });

    refreshModule.ensureSkillsWatcher({
      workspaceDir,
      config: { skills: { load: {} } },
    });

    seen.length = 0;
    watchForSkillRoot(path.join(workspaceDir, "skills")).watcher.emit(
      "raw",
      "rename",
      "README.md",
      {
        watchedPath: path.join(fixtureWorkspaceDir, "skills", "demo"),
      },
    );
    await vi.advanceTimersByTimeAsync(250);
    expect(seen).toEqual([]);

    watchForSkillRoot(path.join(workspaceDir, "skills")).watcher.emit("raw", "rename", "SKILL.md", {
      watchedPath: path.join(fixtureWorkspaceDir, "skills", "demo"),
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    expect(seen).toEqual([
      {
        workspaceDir,
        reason: "watch",
        changedPath: path.join(fixtureWorkspaceDir, "skills", "demo", "SKILL.md"),
      },
    ]);
  });

  it("falls back to a watched-directory refresh when raw events omit a filename", async () => {
    vi.useFakeTimers();
    const workspaceDir = fixtureWorkspaceDir;
    const seen: SkillsChangeEvent[] = [];
    refreshModule.registerSkillsChangeListener((change) => {
      seen.push(change);
    });

    refreshModule.ensureSkillsWatcher({
      workspaceDir,
      config: { skills: { load: {} } },
    });

    seen.length = 0;
    watchForSkillRoot(path.join(workspaceDir, "skills")).watcher.emit("raw", "rename", undefined, {
      watchedPath: path.join(fixtureWorkspaceDir, "skills"),
    });
    await vi.advanceTimersByTimeAsync(250);

    expect(seen).toEqual([
      {
        workspaceDir,
        reason: "watch",
        changedPath: path.join(fixtureWorkspaceDir, "skills"),
      },
    ]);
  });

  it("coalesces raw SKILL.md bursts while renewing stability for unchanged metadata", async () => {
    vi.useFakeTimers();
    const workspaceDir = await createFixtureDirectory("watch-stable");
    const skillDir = path.join(workspaceDir, "skills", "demo");
    const skillFile = path.join(skillDir, "SKILL.md");
    const seen: SkillsChangeEvent[] = [];
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(skillFile, "---\nname: demo\ndescription: Demo\n---\n");
    refreshModule.registerSkillsChangeListener((change) => {
      seen.push(change);
    });

    refreshModule.ensureSkillsWatcher({
      workspaceDir,
      config: { skills: { load: {} } },
    });

    const watcher = watchForSkillRoot(path.join(workspaceDir, "skills")).watcher;
    const stat = vi.spyOn(fsSync, "statSync");
    const emitRaw = () => watcher.emit("raw", "change", "SKILL.md", { watchedPath: skillDir });
    seen.length = 0;
    emitRaw();
    await vi.advanceTimersByTimeAsync(249);
    // Raw events can renew a write without a different size or filesystem timestamp.
    for (let event = 0; event < 32; event += 1) {
      emitRaw();
    }
    await vi.advanceTimersByTimeAsync(499);
    expect(seen).toEqual([]);

    await vi.advanceTimersByTimeAsync(102);
    expect(seen).toEqual([
      {
        workspaceDir,
        reason: "watch",
        changedPath: skillFile,
      },
    ]);
    // The burst must not multiply filesystem polling by the number of events.
    expect(stat.mock.calls.filter(([file]) => file === skillFile).length).toBeLessThanOrEqual(10);
  });

  it("stabilizes a recreated skill when raw events arrive before the missing-file continuation", async () => {
    vi.useFakeTimers();
    const skillDir = await createFixtureDirectory("workspace/skills/recreated");
    const skillFile = path.join(skillDir, "SKILL.md");
    const seen: SkillsChangeEvent[] = [];
    refreshModule.registerSkillsChangeListener((change) => seen.push(change));
    refreshModule.ensureSkillsWatcher({ workspaceDir: fixtureWorkspaceDir });
    const watcher = watchForSkillRoot(path.join(fixtureWorkspaceDir, "skills")).watcher;
    seen.length = 0;

    watcher.emit("raw", "rename", "SKILL.md", { watchedPath: skillDir });
    // Keep recreation in this turn, after the missing stat and before its caller resumes.
    fsSync.writeFileSync(skillFile, "recreated skill content");
    watcher.emit("raw", "change", "SKILL.md", { watchedPath: skillDir });
    await vi.advanceTimersByTimeAsync(499);
    expect(seen).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(seen).toEqual([
      { workspaceDir: fixtureWorkspaceDir, reason: "watch", changedPath: skillFile },
    ]);
  });

  it("refreshes a stable skill while another file in the same watcher keeps changing", async () => {
    vi.useFakeTimers();
    const firstDir = await createFixtureDirectory("workspace/skills/first");
    const secondDir = await createFixtureDirectory("workspace/skills/second");
    const firstFile = path.join(firstDir, "SKILL.md");
    const secondFile = path.join(secondDir, "SKILL.md");
    await fs.writeFile(firstFile, "stable skill");
    await fs.writeFile(secondFile, "changing skill");
    const seen: SkillsChangeEvent[] = [];
    refreshModule.registerSkillsChangeListener((change) => seen.push(change));
    refreshModule.ensureSkillsWatcher({ workspaceDir: fixtureWorkspaceDir });
    const watcher = watchForSkillRoot(path.join(fixtureWorkspaceDir, "skills")).watcher;
    seen.length = 0;
    watcher.emit("raw", "change", "SKILL.md", { watchedPath: firstDir });
    watcher.emit("raw", "change", "SKILL.md", { watchedPath: secondDir });

    for (let write = 0; write < 6; write += 1) {
      await fs.appendFile(secondFile, " still writing");
      watcher.emit("raw", "change", "SKILL.md", { watchedPath: secondDir });
      await vi.advanceTimersByTimeAsync(100);
    }
    const firstChange = {
      workspaceDir: fixtureWorkspaceDir,
      reason: "watch",
      changedPath: firstFile,
    };
    expect(seen).toEqual([firstChange]);
    await vi.advanceTimersByTimeAsync(600);
    expect(seen).toEqual([
      firstChange,
      { workspaceDir: fixtureWorkspaceDir, reason: "watch", changedPath: secondFile },
    ]);
  });

  it("retires raw-file stability polling without publishing after watchers close", async () => {
    vi.useFakeTimers();
    const skillDir = await createFixtureDirectory("workspace/skills/demo");
    const skillFile = path.join(skillDir, "SKILL.md");
    await fs.writeFile(skillFile, "skill content");
    const seen: SkillsChangeEvent[] = [];
    refreshModule.registerSkillsChangeListener((change) => seen.push(change));
    refreshModule.ensureSkillsWatcher({ workspaceDir: fixtureWorkspaceDir });
    const watched = watchForSkillRoot(path.join(fixtureWorkspaceDir, "skills"));
    const versionBefore = getSkillsSnapshotVersion(fixtureWorkspaceDir);
    const stat = vi.spyOn(fsSync, "statSync");

    seen.length = 0;
    watched.watcher.emit("raw", "change", "SKILL.md", { watchedPath: skillDir });
    await refreshModule.closeSkillsWatchers();
    expect(watched.watcher.close).toHaveBeenCalledOnce();
    stat.mockClear();
    for (let tick = 0; tick < 4; tick += 1) {
      await fs.appendFile(skillFile, " still writing");
      await vi.advanceTimersByTimeAsync(100);
    }

    expect(seen).toEqual([]);
    expect(getSkillsSnapshotVersion(fixtureWorkspaceDir)).toBe(versionBefore);
    expect({
      postCloseReads: stat.mock.calls.filter(([file]) => file === skillFile).length,
      pendingTimers: vi.getTimerCount(),
    }).toEqual({ postCloseReads: 0, pendingTimers: 0 });
  });

  it("lets a replacement watcher refresh a file while retired raw polling settles", async () => {
    vi.useFakeTimers();
    const skillDir = await createFixtureDirectory("workspace/skills/replaced");
    const skillFile = path.join(skillDir, "SKILL.md");
    await fs.writeFile(skillFile, "replacement skill content");
    const seen: SkillsChangeEvent[] = [];
    refreshModule.registerSkillsChangeListener((change) => seen.push(change));
    const params = { workspaceDir: fixtureWorkspaceDir };
    refreshModule.ensureSkillsWatcher(params);
    const previous = watchForSkillRoot(path.join(fixtureWorkspaceDir, "skills")).watcher;
    previous.emit("raw", "change", "SKILL.md", { watchedPath: skillDir });
    await refreshModule.closeSkillsWatchers();
    refreshModule.ensureSkillsWatcher(params);
    const replacement = watchForSkillRoot(path.join(fixtureWorkspaceDir, "skills")).watcher;
    expect(replacement).not.toBe(previous);
    expect(previous.closed).toBe(true);
    seen.length = 0;

    replacement.emit("raw", "change", "SKILL.md", { watchedPath: skillDir });
    await vi.advanceTimersByTimeAsync(499);
    expect(seen).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(seen).toEqual([
      { workspaceDir: fixtureWorkspaceDir, reason: "watch", changedPath: skillFile },
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
