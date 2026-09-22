import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { getSkillsSourceVersion } from "./refresh-state.js";
import {
  createSkillsWatcherMock,
  useSkillsWatcherFixture,
} from "./refresh.watcher.test-support.js";

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

let refresh: typeof import("./refresh.js");
describe("skills content rescan handoff", () => {
  const fixture = useSkillsWatcherFixture();
  beforeAll(async () => {
    refresh = await import("./refresh.js");
  });
  beforeEach(() => {
    vi.stubEnv("CHOKIDAR_USEPOLLING", "false");
    watchMock.mockClear();
    createdWatchers.length = 0;
  });
  const start = () => {
    refresh.ensureSkillsWatcher({ workspaceDir: fixture.workspaceDir });
    for (const watcher of createdWatchers) {
      watcher.emit("ready");
    }
    const root = path.join(fixture.workspaceDir, "skills");
    const active = watchForSkillRoot(root).watcher;
    active.emit("all", "addDir", path.join(root, "first"));
    const pending = watchForSkillRoot(root).watcher;
    expect(pending).not.toBe(active);
    expect(active.closed).toBe(false);
    return { root, active, pending };
  };

  it.each(["native", "unknown-name", "polling"] as const)(
    "keeps coverage until a stable scan follows %s structural overlap",
    async (kind) => {
      vi.useFakeTimers();
      vi.stubEnv("CHOKIDAR_USEPOLLING", kind === "polling" ? "true" : "false");
      const { root, active, pending } = start();
      for (const watcher of [active, pending]) {
        if (kind === "polling") {
          watcher.emit("raw", "change", root, {
            curr: { isDirectory: () => true },
            prev: { isDirectory: () => true },
          });
        } else {
          watcher.emit("raw", "rename", kind === "native" ? "second" : undefined, {
            watchedPath: root,
          });
        }
      }
      // Do not deliver normalized addDir: the native observation precedes its scan.
      pending.emit("ready");
      const replacement = watchForSkillRoot(root).watcher;
      expect(replacement).not.toBe(pending);
      expect(pending.closed).toBe(true);
      expect(active.closed).toBe(false);
      const version = getSkillsSourceVersion(fixture.workspaceDir);
      replacement.emit("ready");
      expect(active.closed).toBe(true);
      expect(replacement.closed).toBe(false);
      expect(getSkillsSourceVersion(fixture.workspaceDir)).toBeGreaterThan(version);
      expect(
        watchMock.mock.calls.filter(
          ([watched, options]) => watched === root.replaceAll("\\", "/") && options.depth > 0,
        ),
      ).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(500);
    },
  );

  it.each([false, true])(
    "does not restart scans for supporting-file writes (polling=%s)",
    (polling) => {
      vi.useFakeTimers();
      vi.stubEnv("CHOKIDAR_USEPOLLING", String(polling));
      const { root, active, pending } = start();
      const file = path.join(root, "first", "README.md");
      for (const watcher of [active, pending]) {
        watcher.emit(
          "raw",
          "change",
          polling ? file : "README.md",
          polling
            ? {
                curr: { isDirectory: () => false },
                prev: { isDirectory: () => false },
              }
            : { watchedPath: path.dirname(file) },
        );
      }
      pending.emit("ready");
      expect(active.closed).toBe(true);
      expect(watchForSkillRoot(root).watcher).toBe(pending);
      expect(
        watchMock.mock.calls.filter(
          ([watched, options]) => watched === root.replaceAll("\\", "/") && options.depth > 0,
        ),
      ).toHaveLength(2);
    },
  );

  it("retains the active watcher after a failed rescan and permits a later directory wave", async () => {
    vi.useFakeTimers();
    const { root, active, pending } = start();
    pending.emit("error", Object.assign(new Error("scan failed"), { code: "EIO" }));
    expect(pending.closed).toBe(true);
    expect(active.closed).toBe(false);
    pending.emit("ready");
    expect(watchForSkillRoot(root).watcher).toBe(active);
    const before = getSkillsSourceVersion(fixture.workspaceDir);
    active.emit("all", "change", path.join(root, "first", "SKILL.md"));
    await vi.advanceTimersByTimeAsync(250);
    expect(getSkillsSourceVersion(fixture.workspaceDir)).toBeGreaterThan(before);
    active.emit("all", "addDir", path.join(root, "second"));
    const replacement = watchForSkillRoot(root).watcher;
    expect(replacement).not.toBe(active);
    replacement.emit("ready");
    expect(active.closed).toBe(true);
  });

  it.each(["active", "pending"] as const)(
    "falls back after native capacity failure from %s",
    (source) => {
      vi.useFakeTimers();
      const watches = start();
      watches[source].emit(
        "error",
        Object.assign(new Error("native capacity"), { code: "ENOSPC", syscall: "watch" }),
      );
      expect(createdWatchers.every((watcher) => watcher.closed)).toBe(true);
      const count = createdWatchers.length;
      const version = getSkillsSourceVersion(fixture.workspaceDir);
      refresh.ensureSkillsWatcher({ workspaceDir: fixture.workspaceDir });
      expect(createdWatchers).toHaveLength(count);
      expect(getSkillsSourceVersion(fixture.workspaceDir)).toBeGreaterThan(version);
    },
  );

  it("keeps shared subscriptions when another workspace joins during a rescan", async () => {
    vi.useFakeTimers();
    const { root, active, pending } = start();
    const secondWorkspace = await fixture.createFixtureDirectory("second-workspace");
    const config = { skills: { load: { extraDirs: [root] } } };
    refresh.ensureSkillsWatcher({ workspaceDir: secondWorkspace, config });
    const versions = [fixture.workspaceDir, secondWorkspace].map((workspaceDir) =>
      getSkillsSourceVersion(workspaceDir),
    );
    pending.emit("ready");
    expect(active.closed).toBe(true);
    for (const [index, workspaceDir] of [fixture.workspaceDir, secondWorkspace].entries()) {
      expect(getSkillsSourceVersion(workspaceDir)).toBeGreaterThan(versions[index]!);
    }
    refresh.ensureSkillsWatcher({
      workspaceDir: fixture.workspaceDir,
      config: { skills: { load: { watch: false } } },
    });
    expect(pending.closed).toBe(false);
    refresh.ensureSkillsWatcher({
      workspaceDir: secondWorkspace,
      config: { skills: { load: { watch: false } } },
    });
    expect(pending.closed).toBe(true);
  });

  it("joins the retired generation when publication closes all subscriptions", async () => {
    vi.useFakeTimers();
    const { active, pending } = start();
    const release = createDeferredCore();
    const close = active.close.getMockImplementation()!;
    active.close.mockImplementation(async () => {
      await close();
      await release.promise;
    });
    let closing: Promise<void> | undefined;
    let settled = false;
    refresh.registerSkillsChangeListener((event) => {
      if (event.workspaceDir === fixture.workspaceDir && event.reason === "watch") {
        closing = refresh.closeSkillsWatchers().then(() => {
          settled = true;
        });
      }
    });
    try {
      pending.emit("ready");
      await vi.advanceTimersByTimeAsync(0);
      expect(closing).toBeDefined();
      expect(settled).toBe(false);
      expect(active.closed).toBe(true);
      expect(pending.closed).toBe(true);
      expect(active.close).toHaveBeenCalledOnce();
      expect(pending.close).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      await closing;
    }
    expect(settled).toBe(true);
  });

  it("joins both native closes and ignores late events during shutdown", async () => {
    vi.useFakeTimers();
    const { active, pending } = start();
    const release = createDeferredCore();
    for (const watcher of [active, pending]) {
      const close = watcher.close.getMockImplementation()!;
      watcher.close.mockImplementation(async () => {
        await close();
        await release.promise;
      });
    }
    let settled = false;
    const closing = refresh.closeSkillsWatchers().then(() => {
      settled = true;
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      expect(active.closed).toBe(true);
      expect(pending.closed).toBe(true);
      const version = getSkillsSourceVersion(fixture.workspaceDir);
      pending.emit("ready");
      active.emit("all", "addDir", "late");
      expect(() => pending.emit("error", new Error("late scan"))).not.toThrow();
      expect(getSkillsSourceVersion(fixture.workspaceDir)).toBe(version);
    } finally {
      release.resolve();
      await closing;
    }
    expect(settled).toBe(true);
  });
});
