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

const { createdWatchers, watchMock, watchForSkillRoot } = createSkillsWatcherMock();

vi.mock("chokidar", () => ({ default: { watch: watchMock } }));
vi.mock("../loading/plugin-skills.js", () => ({
  resolvePluginSkillRoots: () => [],
  resolvePluginSkillRootsFromMetadata: () => [],
}));

let refreshModule: typeof import("./refresh.js");

describe("skills watcher residency", () => {
  const fixture = useSkillsWatcherFixture();

  beforeAll(async () => {
    refreshModule = await import("./refresh.js");
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
      for (let index = 1; index <= 128; index += 1) {
        await ensureExecutionRoot(index);
      }
      expect(first.watcher.closed).toBe(true);
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
});
