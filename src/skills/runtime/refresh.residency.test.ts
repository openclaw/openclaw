import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import { toWatchRoot } from "./refresh-watch-path.js";
import {
  createSkillsWatcherMock,
  useSkillsWatcherFixture,
} from "./refresh.watcher.test-support.js";

const observer = createSkillsWatcherMock();
const { watchMock } = observer;

vi.mock("@openclaw/fs-safe/watch", () => ({ watch: watchMock }));
vi.mock("../loading/plugin-skills.js", () => ({
  resolvePluginSkillRoots: () => [],
  resolvePluginSkillRootsFromMetadata: () => [],
}));

let refreshModule: typeof import("./refresh.js");
let registry: typeof import("./refresh-watch-registry.js");

describe("skills watcher residency", () => {
  const fixture = useSkillsWatcherFixture(observer);

  beforeAll(async () => {
    refreshModule = await import("./refresh.js");
    registry = await import("./refresh-watch-registry.js");
  });

  beforeEach(() => {
    // Logical workspace retention is bounded independently of native transport.
    vi.stubEnv("CHOKIDAR_USEPOLLING", "true");
    watchMock.mockClear();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  async function ensureExecutionRoots(indices: readonly number[]) {
    const directories = await Promise.all(
      indices.map(async (index) => {
        const executionWorkspaceDir = await fixture.createFixtureDirectory(`execution-${index}`);
        await fs.mkdir(path.join(executionWorkspaceDir, "skills"), { recursive: true });
        return executionWorkspaceDir;
      }),
    );
    // Admission order owns the LRU. Settle the cohort once rather than joining
    // every already-ready peer again after each individual acquisition.
    for (const executionWorkspaceDir of directories) {
      refreshModule.ensureSkillsWatcher({
        workspaceDir: fixture.workspaceDir,
        executionWorkspaceDir,
      });
    }
    await observer.readyAll();
    return directories.map((executionWorkspaceDir) => ({
      executionWorkspaceDir,
      watcher: observer.forRoot(path.join(executionWorkspaceDir, "skills")),
    }));
  }

  async function ensureExecutionRoot(index: number) {
    return (await ensureExecutionRoots([index]))[0]!;
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
    const shared = observer.forRoot(path.join(fixture.workspaceDir, "skills"));
    await ensureExecutionRoots(Array.from({ length: 126 }, (_, index) => index + 2));
    await ensureExecutionRoot(0);
    expect(observer.subscriptions.every((watcher) => !watcher.closed)).toBe(true);

    await ensureExecutionRoot(128);

    expect(oldest.watcher.closed).toBe(true);
    expect(first.watcher.closed).toBe(false);
    expect(shared.closed).toBe(false);
    expect(observer.forRoot(path.join(fixture.workspaceDir, "skills"))).toBe(shared);
    const seen = vi.fn();
    refreshModule.registerSkillsChangeListener(seen);
    const changedPath = path.join(first.executionWorkspaceDir, "skills", "probe", "SKILL.md");
    first.watcher.change(changedPath);
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
      await ensureExecutionRoots(Array.from({ length: 128 }, (_, index) => index + 1));
      expect(first.watcher.closed).toBe(true);
      expect(retiring.every(({ state }) => state.closed)).toBe(true);
      // A closed handle does not mean its logical owner has joined content and ancestors.
      // This oracle covers settled re-entry; the held-retirement case below covers the gap.
      await Promise.all(retiring.map(({ state }) => state.close()));
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
      await observer.readyAll();
      expect(observer.forRoot(path.join(first.executionWorkspaceDir, "skills")).closed).toBe(false);
    },
  );

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
    const contentRoot = toWatchRoot(path.join(first.executionWorkspaceDir, "skills"));
    const held = expectDefined(
      retiring.find(({ target }) => target.path === contentRoot),
      "retiring content owner",
    );
    const watcher = observer.forRoot(contentRoot);
    const retirement = createDeferred();
    watcher.holdClose(retirement.promise);
    const seen = vi.fn();
    try {
      await ensureExecutionRoots(Array.from({ length: 128 }, (_, index) => index + 1));
      expect(retiring.every(({ state }) => state.closed)).toBe(true);
      // Settle unrelated execution targets so this isolates the one held retirement.
      await Promise.all(
        retiring.filter(({ state }) => state !== held.state).map(({ state }) => state.close()),
      );
      expect(registry.pathWatchers.get(contentRoot)).toBe(held.state);
      refreshModule.registerSkillsChangeListener(seen);
      const reentered = await resolveReusableWorkspaceSkillSnapshot({
        ...params,
        existingSnapshot: initial.snapshot,
      });
      expect(reentered.shouldRefresh).toBe(true);
      expect(reentered.snapshot.prompt).toContain("Original instructions");
      expect(registry.pathWatchers.get(contentRoot)).toBe(held.state);
      expect(observer.forRoot(contentRoot, true)).toBe(watcher);
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
      expect(observer.forRoot(contentRoot, true)).toBe(watcher);
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
    expect(observer.subscriptions.every((created) => created.closed)).toBe(true);
  });
});
