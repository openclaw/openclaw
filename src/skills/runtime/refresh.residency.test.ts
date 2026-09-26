import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import {
  createSkillsWatcherMock,
  useSkillsWatcherFixture,
} from "./refresh.watcher.test-support.js";

const {
  createdWatchers,
  watchMock,
  nativeWatchMock,
  nativeContentWatchMock,
  watchForSkillRoot,
  watcherAdmissions,
} = createSkillsWatcherMock();

vi.mock("chokidar", () => ({ default: { watch: watchMock } }));
vi.mock("./refresh-ancestor-native.js", () => ({
  createNativeSkillsAncestorWatcher: nativeWatchMock,
}));
vi.mock("./refresh-content-native.js", () => ({
  createNativeSkillsContentWatcher: nativeContentWatchMock,
}));
vi.mock("../loading/plugin-skills.js", () => ({
  resolvePluginSkillRoots: () => [],
  resolvePluginSkillRootsFromMetadata: () => [],
}));

let refreshModule: typeof import("./refresh.js");
let registry: typeof import("./refresh-watch-registry.js");

describe("skills watcher residency", () => {
  const fixture = useSkillsWatcherFixture();

  beforeAll(async () => {
    refreshModule = await import("./refresh.js");
    registry = await import("./refresh-watch-registry.js");
  });

  beforeEach(() => {
    vi.stubEnv("CHOKIDAR_USEPOLLING", "false");
    watchMock.mockClear();
    createdWatchers.length = 0;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  async function ensureExecutionRoot(index: number) {
    const executionWorkspaceDir = await fixture.createFixtureDirectory(`execution-${index}`);
    await fs.mkdir(path.join(executionWorkspaceDir, "skills"), { recursive: true });
    refreshModule.ensureSkillsWatcher({
      workspaceDir: fixture.workspaceDir,
      executionWorkspaceDir,
    });
    return {
      executionWorkspaceDir,
      watcher: watchForSkillRoot(path.join(executionWorkspaceDir, "skills")).watcher,
    };
  }

  function executionTargetStates(executionWorkspaceDir: string) {
    const key = JSON.stringify([
      fixture.workspaceDir,
      path.resolve(executionWorkspaceDir),
      undefined,
    ]);
    const targets = expectDefined(
      registry.workspaceWatchTargets.get(key),
      "execution watch targets",
    );
    const states = targets
      .filter((target) => target.executionOnly)
      .map((target) => ({
        target,
        state: expectDefined(registry.pathWatchers.get(target.path), "execution path owner"),
      }));
    expect(states.length).toBeGreaterThan(0);
    return states;
  }

  it("bounds recent execution roots while retaining the most recently used and shared roots", async () => {
    const first = await ensureExecutionRoot(0);
    const oldest = await ensureExecutionRoot(1);
    const shared = watchForSkillRoot(path.join(fixture.workspaceDir, "skills")).watcher;
    for (let index = 2; index < 128; index += 1) {
      await ensureExecutionRoot(index);
    }
    await ensureExecutionRoot(0);
    expect(createdWatchers.every((watcher) => !watcher.closed)).toBe(true);

    await ensureExecutionRoot(128);

    expect(oldest.watcher.closed).toBe(true);
    expect(first.watcher.closed).toBe(false);
    expect(shared.closed).toBe(false);
    expect(watchForSkillRoot(path.join(fixture.workspaceDir, "skills")).watcher).toBe(shared);
    const seen = vi.fn();
    refreshModule.registerSkillsChangeListener(seen);
    const changedPath = path.join(first.executionWorkspaceDir, "skills", "probe", "SKILL.md");
    first.watcher.emit("all", "change", changedPath);
    await vi.advanceTimersByTimeAsync(250);
    expect(seen).toHaveBeenCalledExactlyOnceWith({
      workspaceDir: fixture.workspaceDir,
      reason: "watch",
      changedPath,
    });
  });

  it.each([false, true])(
    "consumes fresh skills on capacity re-entry (repaired: %s)",
    async (repair) => {
      const { resolveReusableWorkspaceSkillSnapshot } = await import("./session-snapshot.js");
      const first = await ensureExecutionRoot(0);
      const skillDir = path.join(first.executionWorkspaceDir, "skills", "residency-proof");
      await writeSkill({
        dir: skillDir,
        name: "residency-proof",
        description: "Original instructions",
      });
      if (repair) {
        await fs.writeFile(path.join(skillDir, "SKILL.md"), "invalid skill frontmatter\n");
      }
      const params = {
        workspaceDir: fixture.workspaceDir,
        executionWorkspaceDir: first.executionWorkspaceDir,
        config: {},
        skillFilter: ["residency-proof"],
      };
      const initial = await resolveReusableWorkspaceSkillSnapshot(params);
      if (repair) {
        expect(initial.snapshot.skills).toEqual([]);
      } else {
        expect(initial.snapshot.prompt).toContain("Original instructions");
      }
      const retiring = executionTargetStates(first.executionWorkspaceDir);
      for (let index = 1; index <= 128; index += 1) {
        await ensureExecutionRoot(index);
      }
      expect(first.watcher.closed).toBe(true);
      expect(retiring.every(({ state }) => state.closed)).toBe(true);
      // A closed handle does not mean its logical owner has joined content and ancestors.
      // This oracle covers settled re-entry; the held-retirement case below covers the gap.
      const retired = await Promise.all(retiring.map(({ state }) => state.close()));
      expect(retired.every((result) => result.ok)).toBe(true);
      for (const { target, state } of retiring) {
        expect(registry.pathWatchers.get(target.path)).not.toBe(state);
      }
      const cached = initial.snapshot;
      if (repair) {
        await writeSkill({
          dir: skillDir,
          name: "residency-proof",
          description: "Repaired instructions",
        });
        expect(
          (
            await resolveReusableWorkspaceSkillSnapshot({
              ...params,
              existingSnapshot: cached,
              watch: false,
            })
          ).snapshot,
        ).toBe(cached);
      }

      // No native events: acquisition must reconcile before the first snapshot is consumed.
      const refreshed = await resolveReusableWorkspaceSkillSnapshot({
        ...params,
        existingSnapshot: cached,
      });
      expect(refreshed.shouldRefresh).toBe(repair);
      if (repair) {
        expect(refreshed.snapshot.prompt).toContain("Repaired instructions");
      } else {
        expect(refreshed.snapshot).toBe(initial.snapshot);
      }
      expect(
        watchForSkillRoot(path.join(first.executionWorkspaceDir, "skills")).watcher.closed,
      ).toBe(false);
    },
  );

  it("joins retired native closes during shutdown without publishing late work", async () => {
    const skillDir = await fixture.createFixtureDirectory("workspace/skills/probe");
    const changedPath = path.join(skillDir, "SKILL.md");
    await fs.writeFile(changedPath, "skill content");
    refreshModule.ensureSkillsWatcher({ workspaceDir: fixture.workspaceDir });
    const watcher = watchForSkillRoot(path.join(fixture.workspaceDir, "skills")).watcher;
    const originalClose = expectDefined(watcher.close.getMockImplementation(), "watcher close");
    const retirement = createDeferred();
    watcher.close.mockImplementation(async () => {
      await originalClose();
      await retirement.promise;
    });
    watcher.emit("raw", "change", "SKILL.md", { watchedPath: skillDir });
    refreshModule.ensureSkillsWatcher({
      workspaceDir: fixture.workspaceDir,
      config: { skills: { load: { watch: false } } },
    });
    expect(watcher.closed).toBe(true);
    const seen = vi.fn();
    refreshModule.registerSkillsChangeListener(seen);
    let closed = false;
    const shutdown = refreshModule.closeSkillsWatchers().then(() => {
      closed = true;
    });
    try {
      for (const [event, callback] of watcher.on.mock.calls) {
        if (event === "ready") {
          callback();
        }
        if (event === "all") {
          callback("change", changedPath);
        }
        if (event === "raw") {
          callback("change", "SKILL.md", { watchedPath: skillDir });
        }
      }
      await vi.advanceTimersByTimeAsync(500);
      expect(seen).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      expect(closed).toBe(false);
    } finally {
      retirement.resolve();
      await shutdown;
    }
    expect(closed).toBe(true);
  });

  it("refreshes preparation while capacity re-entry waits for retirement", async () => {
    const { resolveReusableWorkspaceSkillSnapshot } = await import("./session-snapshot.js");
    const first = await ensureExecutionRoot(0);
    const skillDir = path.join(first.executionWorkspaceDir, "skills", "residency-proof");
    await writeSkill({
      dir: skillDir,
      name: "residency-proof",
      description: "Original instructions",
    });
    const params = {
      workspaceDir: fixture.workspaceDir,
      executionWorkspaceDir: first.executionWorkspaceDir,
      config: {},
      skillFilter: ["residency-proof"],
    };
    const initial = await resolveReusableWorkspaceSkillSnapshot(params);
    const retiring = executionTargetStates(first.executionWorkspaceDir);
    const contentRoot = path.join(first.executionWorkspaceDir, "skills").replaceAll("\\", "/");
    const held = expectDefined(
      retiring.find(({ target }) => target.path === contentRoot),
      "retiring content owner",
    );
    const watcher = watchForSkillRoot(contentRoot).watcher;
    const originalClose = expectDefined(watcher.close.getMockImplementation(), "watcher close");
    const retirement = createDeferred();
    watcher.close.mockImplementationOnce(async () => {
      await originalClose();
      await retirement.promise;
    });
    const admitted = watcherAdmissions(contentRoot, false).length;
    const seen = vi.fn();
    try {
      for (let index = 1; index <= 128; index += 1) {
        await ensureExecutionRoot(index);
      }
      expect(retiring.every(({ state }) => state.closed)).toBe(true);
      // Settle unrelated execution targets so this isolates the one held retirement.
      const otherCloses = await Promise.all(
        retiring.filter(({ state }) => state !== held.state).map(({ state }) => state.close()),
      );
      expect(otherCloses.every((result) => result.ok)).toBe(true);
      expect(registry.pathWatchers.get(contentRoot)).toBe(held.state);
      refreshModule.registerSkillsChangeListener(seen);
      const reentered = await resolveReusableWorkspaceSkillSnapshot({
        ...params,
        existingSnapshot: initial.snapshot,
      });
      expect(reentered.shouldRefresh).toBe(true);
      expect(reentered.snapshot.prompt).toContain("Original instructions");
      expect(registry.pathWatchers.get(contentRoot)).toBe(held.state);
      expect(watcherAdmissions(contentRoot, false)).toHaveLength(admitted);
      expect(
        seen.mock.calls.filter(([event]) => event.reason === "watch-unavailable"),
      ).toHaveLength(1);
      expect(seen.mock.calls.filter(([event]) => event.reason === "watch-available")).toHaveLength(
        0,
      );

      await writeSkill({
        dir: skillDir,
        name: "residency-proof",
        description: "Edited while retiring",
      });
      const refreshed = await resolveReusableWorkspaceSkillSnapshot({
        ...params,
        existingSnapshot: reentered.snapshot,
      });
      expect(refreshed.shouldRefresh).toBe(true);
      expect(refreshed.snapshot.prompt).toContain("Edited while retiring");
      expect(registry.pathWatchers.get(contentRoot)).toBe(held.state);
      expect(watcherAdmissions(contentRoot, false)).toHaveLength(admitted);
      expect(
        seen.mock.calls.filter(([event]) => event.reason === "watch-unavailable"),
      ).toHaveLength(1);
      expect(seen.mock.calls.filter(([event]) => event.reason === "watch-available")).toHaveLength(
        0,
      );
      expect(watcher.close).toHaveBeenCalledTimes(1);
    } finally {
      const closing = refreshModule.closeSkillsWatchers();
      retirement.resolve();
      await closing;
    }
    expect(createdWatchers.every((created) => created.closed)).toBe(true);
  });
});
