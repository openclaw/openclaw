import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import { getSkillsSnapshotVersion, getSkillsSourceVersion } from "./refresh-state.js";
import {
  createSkillsWatcherMock,
  useSkillsWatcherFixture,
  waitForSkillsWatcherTurn,
} from "./refresh.watcher.test-support.js";

const {
  createdWatchers,
  watchMock,
  nativeWatchMock,
  nativeContentWatchMock,
  watchForSkillRoot,
  readyAll,
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

let refresh: typeof import("./refresh.js");
let registry: typeof import("./refresh-watch-registry.js");
let loadWorkspaceSkills: typeof import("../loading/workspace-skill-loader.js").loadWorkspaceSkills;

describe("skills structural change retirement", () => {
  const fixture = useSkillsWatcherFixture();
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  beforeAll(async () => {
    refresh = await import("./refresh.js");
    registry = await import("./refresh-watch-registry.js");
    ({ loadWorkspaceSkills } = await import("../loading/workspace-skill-loader.js"));
  });
  beforeEach(() => {
    // This models persistent pooled uncertainty; native macOS delivery has separate CI proof.
    Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
    vi.stubEnv("CHOKIDAR_USEPOLLING", "false");
    watchMock.mockClear();
    createdWatchers.length = 0;
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", platform);
  });

  const acquireUnavailableRoot = async () => {
    const root = await fixture.createFixtureDirectory("observed/parent/skills");
    await writeSkill({
      dir: path.join(root, "proof"),
      name: "proof",
      description: "Before removal",
    });
    const params = {
      workspaceDir: fixture.workspaceDir,
      config: { skills: { load: { extraDirs: [root] } } },
    };
    refresh.ensureSkillsWatcher(params);
    await readyAll();
    watchForSkillRoot(root).watcher.emit(
      "error",
      Object.assign(new Error("pooled observer lost"), { code: "EIO" }),
    );
    refresh.ensureSkillsWatcher(params);
    await readyAll();
    const state = expectDefined(
      registry.pathWatchers.get(root.replaceAll("\\", "/")),
      "path owner",
    );
    expect(state).toMatchObject({
      closed: false,
      failed: false,
      unavailable: true,
      verified: false,
    });
    const read = () =>
      loadWorkspaceSkills(params.workspaceDir, {
        config: params.config,
        bundledSkillsDir: "",
        managedSkillsDir: path.join(params.workspaceDir, "missing-managed"),
      }).map((entry) => entry.skill.name);
    expect(read()).toEqual(["proof"]);
    return { root, params, state, read, active: watchForSkillRoot(root).watcher };
  };

  it.each([false, true])(
    "refreshes cached content before retirement settles (close failure: %s)",
    async (failure) => {
      const { root, params, state, read, active } = await acquireUnavailableRoot();
      const release = createDeferredCore();
      const closeError = new Error("content retirement failed");
      const close = active.close.getMockImplementation()!;
      active.close.mockImplementationOnce(async () => {
        await close();
        await release.promise;
        if (failure) {
          throw closeError;
        }
      });
      const seen = vi.fn();
      refresh.registerSkillsChangeListener(seen);
      const admissions = watchMock.mock.calls.length;
      const version = getSkillsSnapshotVersion(params.workspaceDir);
      try {
        await fs.rm(root, { recursive: true });
        expect(read()).toEqual(["proof"]);
        active.emit("all", "unlinkDir", root);
        // No preparation, replacement ready, or close settlement can supply this refresh.
        expect(read()).toEqual([]);
        expect(seen).toHaveBeenCalledExactlyOnceWith({
          workspaceDir: params.workspaceDir,
          reason: "watch",
          changedPath: root,
        });
        const changedVersion = getSkillsSnapshotVersion(params.workspaceDir);
        expect(changedVersion).toBeGreaterThan(version);
        await waitForSkillsWatcherTurn();
        expect(state.closed).toBe(true);
        expect(registry.pathWatchers.get(root.replaceAll("\\", "/"))).toBe(state);
        expect(watchMock).toHaveBeenCalledTimes(admissions);
        expect(active.close).toHaveBeenCalledOnce();
        release.resolve();
        const result = await state.close();
        expect(result.ok).toBe(!failure);
        if (!result.ok) {
          expect(result.error).toBe(closeError);
        }
        await waitForSkillsWatcherTurn();
        const current = registry.pathWatchers.get(root.replaceAll("\\", "/"));
        if (failure) {
          expect(current).toBe(state);
          expect(watchMock).toHaveBeenCalledTimes(admissions);
        } else {
          expect(current).not.toBe(state);
          expect(current).toMatchObject({ closed: false, unavailable: true, verified: false });
        }
        expect(read()).toEqual([]);
        expect(getSkillsSnapshotVersion(params.workspaceDir)).toBe(changedVersion);
        expect(seen).toHaveBeenCalledOnce();
      } finally {
        const closing = refresh.closeSkillsWatchers();
        release.resolve();
        await closing;
      }
    },
  );

  it.each(["unsubscribe", "shutdown"] as const)(
    "does not rearm after structural publication triggers %s",
    async (action) => {
      const { root, params, state, read, active } = await acquireUnavailableRoot();
      const release = createDeferredCore();
      const close = active.close.getMockImplementation()!;
      active.close.mockImplementationOnce(async () => {
        await close();
        await release.promise;
      });
      const staleChanges = active.on.mock.calls.flatMap(([event, callback]) =>
        event === "all" ? [callback] : [],
      );
      expect(staleChanges.length).toBeGreaterThan(0);
      let closing: Promise<void> | undefined;
      let settled = false;
      const seen = vi.fn();
      refresh.registerSkillsChangeListener((event) => {
        seen(event);
        if (event.workspaceDir !== params.workspaceDir || event.reason !== "watch") {
          return;
        }
        if (action === "shutdown") {
          closing = refresh.closeSkillsWatchers().then(() => {
            settled = true;
          });
        } else {
          refresh.ensureSkillsWatcher({
            ...params,
            config: { skills: { load: { watch: false } } },
          });
        }
      });
      const admissions = watchMock.mock.calls.length;
      try {
        await fs.rm(root, { recursive: true });
        active.emit("all", "unlinkDir", root);
        expect(read()).toEqual([]);
        expect(state.closed).toBe(true);
        await waitForSkillsWatcherTurn();
        expect(settled).toBe(false);
        if (action === "shutdown") {
          expect(closing).toBeDefined();
        } else {
          expect(state.subscribers.size).toBe(0);
        }
        expect(watchMock).toHaveBeenCalledTimes(admissions);
        expect(active.close).toHaveBeenCalledOnce();
        expect(seen).toHaveBeenCalledExactlyOnceWith({
          workspaceDir: params.workspaceDir,
          reason: "watch",
          changedPath: root,
        });
        const version = getSkillsSnapshotVersion(params.workspaceDir);
        const source = getSkillsSourceVersion(params.workspaceDir);
        for (const callback of staleChanges) {
          callback("unlinkDir", root);
        }
        expect(getSkillsSnapshotVersion(params.workspaceDir)).toBe(version);
        expect(getSkillsSourceVersion(params.workspaceDir)).toBe(source);
      } finally {
        const allClosing = refresh.closeSkillsWatchers();
        release.resolve();
        await Promise.all([closing, allClosing]);
      }
      expect(watchMock).toHaveBeenCalledTimes(admissions);
      expect(createdWatchers.every((watcher) => watcher.closed)).toBe(true);
      expect(seen).toHaveBeenCalledOnce();
    },
  );
});
