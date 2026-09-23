import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import type { SkillSnapshot } from "../types.js";
import { getSkillsSnapshotVersion, getSkillsSourceVersion } from "./refresh-state.js";
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
  const acquire = () => {
    refresh.ensureSkillsWatcher({ workspaceDir: fixture.workspaceDir });
    const root = path.join(fixture.workspaceDir, "skills");
    const active = watchForSkillRoot(root).watcher;
    for (const watcher of createdWatchers) {
      if (watcher !== active) {
        watcher.emit("ready");
      }
    }
    return { root, active };
  };
  const start = (phase: "initial" | "replacement" = "replacement") => {
    const { root, active: first } = acquire();
    if (phase === "initial") {
      first.emit("ready");
      return { root, active: first, pending: watchForSkillRoot(root).watcher };
    }
    for (const watcher of createdWatchers) {
      watcher.emit("ready");
    }
    const active = watchForSkillRoot(root).watcher;
    active.emit("all", "addDir", path.join(root, "first"));
    const pending = watchForSkillRoot(root).watcher;
    expect(pending).not.toBe(active);
    expect(active.closed).toBe(false);
    return { root, active, pending };
  };

  it("publishes initial readiness only after a scan under continuous observation", () => {
    const { root, active } = acquire();
    const before = getSkillsSourceVersion(fixture.workspaceDir);
    active.emit("ready");
    const pending = watchForSkillRoot(root).watcher;
    expect(pending).not.toBe(active);
    expect(active.closed).toBe(false);
    expect(getSkillsSourceVersion(fixture.workspaceDir)).toBe(before);
    pending.emit("ready");
    expect(active.closed).toBe(true);
    expect(pending.closed).toBe(false);
    const ready = getSkillsSourceVersion(fixture.workspaceDir);
    expect(ready).toBeGreaterThan(before);
    pending.emit("ready");
    active.emit("ready");
    expect(getSkillsSourceVersion(fixture.workspaceDir)).toBe(ready);
  });

  it.each(["initial", "replacement"] as const)(
    "verifies every expanding directory inventory during %s coverage",
    (phase) => {
      const { root, active, pending } = start(phase);
      const before = getSkillsSourceVersion(fixture.workspaceDir);
      // The observer can discover these after its first ready. Its mutable
      // inventory cannot prove their watches predated the verifier's listing.
      const directories: Record<string, string[]> = { [root]: ["outer"] };
      active.getWatched.mockReturnValue(directories);
      pending.getWatched.mockReturnValue(directories);
      let observer = active;
      let verifier = pending;
      for (const directory of [root, path.join(root, "outer"), path.join(root, "outer", "inner")]) {
        directories[directory] = [];
        verifier.emit("ready");
        expect(observer.closed).toBe(true);
        expect(verifier.closed).toBe(false);
        expect(getSkillsSourceVersion(fixture.workspaceDir)).toBe(before);
        observer = verifier;
        verifier = watchForSkillRoot(root).watcher;
        expect(verifier).not.toBe(observer);
        verifier.getWatched.mockReturnValue(directories);
      }
      verifier.emit("ready");
      expect(observer.closed).toBe(true);
      expect(verifier.closed).toBe(false);
      expect(getSkillsSourceVersion(fixture.workspaceDir)).toBeGreaterThan(before);
      expect(active.getWatched).toHaveBeenCalledOnce();
      expect(pending.getWatched).toHaveBeenCalledOnce();
    },
  );

  it("recovers an initial verification error on the next real directory wave", () => {
    vi.useFakeTimers();
    const { root, active, pending } = start("initial");
    const before = getSkillsSourceVersion(fixture.workspaceDir);
    pending.emit("error", Object.assign(new Error("scan failed"), { code: "EIO" }));
    expect(active.closed).toBe(false);
    expect(pending.closed).toBe(true);
    const count = createdWatchers.length;
    const failed = getSkillsSourceVersion(fixture.workspaceDir);
    expect(failed).toBeGreaterThan(before);
    pending.emit("ready");
    expect(createdWatchers).toHaveLength(count);
    expect(getSkillsSourceVersion(fixture.workspaceDir)).toBe(failed);
    active.emit("all", "addDir", path.join(root, "second"));
    const recovery = watchForSkillRoot(root).watcher;
    expect(recovery).not.toBe(active);
    recovery.emit("ready");
    expect(active.closed).toBe(true);
    expect(getSkillsSourceVersion(fixture.workspaceDir)).toBeGreaterThan(failed);
  });

  it.each(["workspace", "shared", "execution"] as const)(
    "reconciles only affected %s sources during preparation after a verification error",
    async (scope) => {
      const { resolveReusableWorkspaceSkillSnapshot } = await import("./session-snapshot.js");
      const workspaceDir = fixture.workspaceDir;
      const healthyWorkspace = await fixture.createFixtureDirectory("healthy-workspace");
      const sharedRoot = await fixture.createFixtureDirectory("shared/skills");
      const executionWorkspaceDir = await fixture.createFixtureDirectory("execution");
      const otherExecution = await fixture.createFixtureDirectory("other-execution");
      const config = scope === "shared" ? { skills: { load: { extraDirs: [sharedRoot] } } } : {};
      const root =
        scope === "shared"
          ? sharedRoot
          : path.join(scope === "execution" ? executionWorkspaceDir : workspaceDir, "skills");
      const write = (description: string) =>
        writeSkill({ dir: path.join(root, "scan-proof"), name: "scan-proof", description });
      await write("Original verified preparation");
      const request = {
        workspaceDir,
        config,
        ...(scope === "execution" ? { executionWorkspaceDir } : {}),
      };
      const affected = [
        request,
        ...(scope === "shared"
          ? [{ workspaceDir: await fixture.createFixtureDirectory("shared-subscriber"), config }]
          : []),
      ];
      const snapshots = new Map<string, SkillSnapshot>();
      const prepare = async (params: typeof request) => {
        const key = JSON.stringify(params);
        const { snapshot } = await resolveReusableWorkspaceSkillSnapshot({
          ...params,
          existingSnapshot: snapshots.get(key),
          skillFilter: ["scan-proof"],
        });
        snapshots.set(key, snapshot);
        return snapshot;
      };
      for (const params of affected) {
        expect((await prepare(params)).prompt).toContain("Original verified preparation");
      }
      const healthy = { workspaceDir: healthyWorkspace, config: {} };
      const healthySnapshot = await prepare(healthy);
      if (scope === "execution") {
        await prepare({ workspaceDir, config });
        await prepare({ workspaceDir, config, executionWorkspaceDir: otherExecution });
      }
      const active = watchForSkillRoot(root).watcher;
      for (const watcher of createdWatchers) {
        if (watcher !== active) {
          watcher.emit("ready");
        }
      }
      active.emit("ready");
      const pending = watchForSkillRoot(root).watcher;
      const unaffected = [
        getSkillsSourceVersion(healthyWorkspace),
        getSkillsSourceVersion(workspaceDir),
        getSkillsSourceVersion(workspaceDir, { executionWorkspaceDir: otherExecution }),
      ];
      vi.useFakeTimers();
      pending.emit("error", Object.assign(new Error("verifier read failed"), { code: "EIO" }));
      expect(active.closed).toBe(false);
      expect(pending.closed).toBe(true);
      const watcherCount = createdWatchers.length;
      for (const description of ["Second preparation", "Third preparation"]) {
        await write(description);
        for (const params of affected) {
          expect((await prepare(params)).prompt).toContain(description);
        }
        expect(await prepare(healthy)).toBe(healthySnapshot);
      }
      expect(getSkillsSourceVersion(healthyWorkspace)).toBe(unaffected[0]);
      if (scope === "execution") {
        expect(getSkillsSourceVersion(workspaceDir)).toBe(unaffected[1]);
        expect(
          getSkillsSourceVersion(workspaceDir, { executionWorkspaceDir: otherExecution }),
        ).toBe(unaffected[2]);
      }
      const seen = vi.fn();
      refresh.registerSkillsChangeListener(seen);
      const version = getSkillsSnapshotVersion(workspaceDir);
      await prepare(request);
      await prepare(request);
      expect(getSkillsSnapshotVersion(workspaceDir)).toBe(version);
      expect(seen).not.toHaveBeenCalled();
      expect(createdWatchers).toHaveLength(watcherCount);

      if (scope === "shared") {
        const late = {
          workspaceDir: await fixture.createFixtureDirectory("late-subscriber"),
          config,
        };
        await prepare(late);
        expect(seen).toHaveBeenCalledExactlyOnceWith({
          workspaceDir: late.workspaceDir,
          reason: "watch-unavailable",
          changedPath: expect.any(String),
        });
        seen.mockClear();
        await prepare(late);
        expect(seen).not.toHaveBeenCalled();
        for (const watcher of createdWatchers) {
          if (watcher !== active) {
            watcher.emit("ready");
          }
        }
      }

      const added = await fixture.createFixtureDirectory(
        scope === "shared"
          ? "shared/skills/recovered"
          : `${scope === "execution" ? "execution" : "workspace"}/skills/recovered`,
      );
      active.emit("all", "addDir", added);
      const recovery = watchForSkillRoot(root).watcher;
      recovery.emit("ready");
      expect(active.closed).toBe(true);
      expect(recovery.closed).toBe(false);
      await vi.advanceTimersByTimeAsync(500);
      const readyVersion = getSkillsSourceVersion(workspaceDir, request);
      await prepare(request);
      expect(getSkillsSourceVersion(workspaceDir, request)).toBe(readyVersion);
    },
  );

  it.each([false, true])(
    "verifies recovery after an initial read error (late ready=%s)",
    async (lateReady) => {
      vi.useFakeTimers();
      const { root, active } = acquire();
      active.emit("error", Object.assign(new Error("initial read failed"), { code: "EIO" }));
      const failed = getSkillsSourceVersion(fixture.workspaceDir);
      const changed = vi.fn();
      refresh.registerSkillsChangeListener(changed);
      if (lateReady) {
        active.emit("ready");
      } else {
        const second = await fixture.createFixtureDirectory("workspace/skills/second");
        active.emit("all", "addDir", second);
      }
      const healthy = watchForSkillRoot(root).watcher;
      healthy.emit("ready");
      const verification = watchForSkillRoot(root).watcher;
      expect(verification).not.toBe(healthy);
      expect(active.closed).toBe(true);
      expect(healthy.closed).toBe(false);
      expect(getSkillsSourceVersion(fixture.workspaceDir)).toBe(failed);
      expect(changed).not.toHaveBeenCalled();
      verification.emit("ready");
      expect(healthy.closed).toBe(true);
      expect(verification.closed).toBe(false);
      expect(getSkillsSourceVersion(fixture.workspaceDir)).toBeGreaterThan(failed);
      expect(changed).toHaveBeenCalledOnce();
    },
  );

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
      ).toHaveLength(4);
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
      ).toHaveLength(3);
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

  it.each(
    (["initial", "replacement"] as const).flatMap((phase) =>
      (["active", "pending"] as const).map((source) => ({ phase, source })),
    ),
  )(
    "falls back after native capacity failure from $source during $phase coverage",
    ({ phase, source }) => {
      vi.useFakeTimers();
      const watches = start(phase);
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

  it.each(["initial", "replacement"] as const)(
    "joins the retired generation when %s publication closes all subscriptions",
    async (phase) => {
      vi.useFakeTimers();
      const { active, pending } = start(phase);
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
    },
  );

  it.each(["initial", "replacement"] as const)(
    "joins both native closes and ignores late events during %s shutdown",
    async (phase) => {
      vi.useFakeTimers();
      const { active, pending } = start(phase);
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
    },
  );
});
