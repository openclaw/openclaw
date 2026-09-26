import nativeFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import chokidar from "chokidar";
import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveWorkspaceSkillSourcePlan } from "../loading/workspace-skill-sources.js";
import * as contentOwner from "./refresh-content-watch.js";
import { resolveSkillsWatcherUsePolling } from "./refresh-watch-path.js";

vi.mock("../loading/plugin-skills.js", () => ({
  resolvePluginSkillRoots: () => [],
  resolvePluginSkillRootsFromMetadata: () => [],
}));

it
  .runIf(
    // Darwin retains stock Chokidar. Windows replacement coverage uses the
    // separate delete/recreate fixture because descendant handles block rename.
    process.platform === "linux" && !process.versions.bun && !resolveSkillsWatcherUsePolling(),
  )
  .each(["directory", "symlink"] as const)(
  "invalidates the direct Skills cache when a ready %s is replaced with the same shape",
  async (kind) => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "skills-native-discovery-")),
    );
    const workspaceDir = path.join(root, "workspace");
    const skillsRoot = path.join(workspaceDir, "skills");
    const watchedEntry = path.join(skillsRoot, "proof");
    const firstTarget = path.join(root, "first-target");
    const nextTarget = path.join(root, "next-target");
    const source = (description: string) =>
      `---\nname: owner-proof\ndescription: ${description}\n---\n`;
    await fs.mkdir(skillsRoot, { recursive: true });
    await fs.mkdir(firstTarget);
    await fs.mkdir(nextTarget);
    if (kind === "symlink") {
      await fs.writeFile(path.join(firstTarget, "SKILL.md"), source("before"));
      await fs.writeFile(path.join(nextTarget, "SKILL.md"), source("replacement"));
      await fs.symlink(firstTarget, watchedEntry);
    } else {
      await fs.mkdir(watchedEntry);
      await fs.writeFile(path.join(watchedEntry, "SKILL.md"), source("before"));
    }
    const config = { skills: { load: { allowSymlinkTargets: [firstTarget, nextTarget] } } };
    const sourcePlan = resolveWorkspaceSkillSourcePlan(workspaceDir, {
      config,
      workspaceOnly: true,
    });
    const { ensureSkillsWatcher, closeSkillsWatchers } = await import("./refresh.js");
    const { loadWorkspaceSkills } = await import("../loading/workspace-skill-loader.js");
    const read = () =>
      loadWorkspaceSkills(workspaceDir, {
        config,
        workspaceOnly: true,
        bundledSkillsDir: "",
        managedSkillsDir: path.join(root, "unused"),
      }).map((entry) => entry.skill.description);

    const observed: Array<{ ready: boolean; watcher: { readonly closed: boolean } }> = [];
    const errors: unknown[] = [];
    const originalContentOwner = contentOwner.createSkillsContentWatcher;
    const contentSpy = vi
      .spyOn(contentOwner, "createSkillsContentWatcher")
      .mockImplementation((params) =>
        originalContentOwner({
          ...params,
          watch: () => {
            const watcher = params.watch();
            const state = { ready: false, watcher };
            observed.push(state);
            watcher.on("ready", () => {
              state.ready = true;
            });
            watcher.on("error", (error) => errors.push(error));
            return watcher;
          },
        }),
      );
    // Observe both implementations so the frozen stock-owner control keeps the
    // same real readiness and cached-loader prerequisites as the repaired owner.
    const originalChokidar = chokidar.watch;
    const chokidarSpy = vi.spyOn(chokidar, "watch").mockImplementation((...args) => {
      const watcher = originalChokidar(...args);
      const state = { ready: false, watcher };
      observed.push(state);
      watcher.once("ready", () => {
        state.ready = true;
      });
      watcher.on("error", (error) => errors.push(error));
      return watcher;
    });
    const timers = new Map<
      Parameters<typeof clearTimeout>[0],
      { settled: Promise<void>; finish(): void }
    >();
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const timeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((callback, delay, ...args) => {
        const { promise: settled, resolve: finish } = createDeferredCore();
        const timer = originalSetTimeout(() => {
          timers.delete(timer);
          try {
            callback.apply(timer, args);
          } finally {
            finish();
          }
        }, delay);
        timers.set(timer, { settled, finish });
        return timer;
      });
    const clearSpy = vi.spyOn(globalThis, "clearTimeout").mockImplementation((timer) => {
      originalClearTimeout(timer);
      timers.get(timer)?.finish();
      timers.delete(timer);
    });
    const settle = async () => {
      for (;;) {
        await vi.waitFor(() => {
          expect(observed.length).toBeGreaterThan(0);
          expect(observed.every(({ ready, watcher }) => ready || watcher.closed)).toBe(true);
          expect(errors).toEqual([]);
        });
        const count = observed.length;
        await Promise.all(Array.from(timers.values(), ({ settled }) => settled));
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        if (
          timers.size === 0 &&
          count === observed.length &&
          observed.every(({ ready, watcher }) => ready || watcher.closed)
        ) {
          return;
        }
      }
    };
    let peer: ReturnType<typeof chokidar.watch> | undefined;
    try {
      ensureSkillsWatcher({ workspaceDir, config, sourcePlan });
      await settle();
      expect(read()).toEqual(["before"]);
      peer = originalChokidar(watchedEntry, {
        persistent: true,
        ignoreInitial: true,
        usePolling: false,
      });
      await new Promise<void>((resolve, reject) => {
        peer!.once("ready", resolve);
        peer!.once("error", reject);
      });
      const inode = nativeFs.lstatSync(watchedEntry).ino;
      if (kind === "directory") {
        nativeFs.renameSync(watchedEntry, path.join(root, "retained-directory"));
        nativeFs.mkdirSync(watchedEntry);
        nativeFs.writeFileSync(path.join(watchedEntry, "SKILL.md"), source("replacement"));
      } else {
        nativeFs.symlinkSync(nextTarget, path.join(root, "replacement-symlink"));
        nativeFs.renameSync(path.join(root, "replacement-symlink"), watchedEntry);
      }
      expect(nativeFs.lstatSync(watchedEntry).ino).not.toBe(inode);
      await expect.poll(read, { timeout: 3_000 }).toEqual(["replacement"]);
      await settle();
      expect(peer.closed).toBe(false);
      if (kind === "directory") {
        // Prime only after actual scan/debounce settlement. Startup invalidation
        // cannot satisfy this later edit, and no ensure/preparation runs here.
        expect(read()).toEqual(["replacement"]);
        await fs.writeFile(path.join(watchedEntry, "SKILL.md"), source("later deep edit"));
        await expect.poll(read, { timeout: 3_000 }).toEqual(["later deep edit"]);
      } else {
        // A retarget must retain directory-link relevance through the next
        // genuine unlink, after all replacement discovery work has settled.
        expect(read()).toEqual(["replacement"]);
        await fs.unlink(watchedEntry);
        await expect.poll(read, { timeout: 3_000 }).toEqual([]);
      }
      expect(errors).toEqual([]);
    } catch (error) {
      expect.soft(errors).toEqual([]);
      expect.soft(peer?.closed).toBe(false);
      expect.soft(observed.length).toBeGreaterThan(0);
      expect.soft(observed.every(({ ready, watcher }) => ready || watcher.closed)).toBe(true);
      expect.soft(timers.size).toBe(0);
      throw error;
    } finally {
      await closeSkillsWatchers(true);
      await peer?.close();
      contentSpy.mockRestore();
      chokidarSpy.mockRestore();
      timeoutSpy.mockRestore();
      clearSpy.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
