import nativeFs from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import chokidar from "chokidar";
import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveSkillsWatcherUsePolling } from "./refresh-watch-path.js";

vi.mock("../loading/plugin-skills.js", () => ({
  resolvePluginSkillRoots: () => [],
  resolvePluginSkillRootsFromMetadata: () => [],
}));

it.runIf(
  process.platform === "linux" && !process.versions.bun && !resolveSkillsWatcherUsePolling(),
)("refreshes discovery after a skill rename before descendant watch registration", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "skills-registration-")));
  const workspaceDir = path.join(root, "workspace");
  const skillsRoot = path.join(workspaceDir, "skills");
  const skillDir = path.join(skillsRoot, "registration-proof");
  const skillFile = path.join(skillDir, "SKILL.md");
  const renamedSkillFile = path.join(skillDir, "SKILL.saved");
  await fs.mkdir(skillsRoot, { recursive: true });
  const { ensureSkillsWatcher, closeSkillsWatchers, registerSkillsChangeListener } =
    await import("./refresh.js");
  const { getSkillsSourceVersion } = await import("./refresh-state.js");
  const { loadWorkspaceSkills } = await import("../loading/workspace-skill-loader.js");
  const read = () =>
    loadWorkspaceSkills(workspaceDir, {
      config: {},
      bundledSkillsDir: "",
      managedSkillsDir: path.join(root, "unused"),
    }).map((entry) => entry.skill.name);

  const releaseScan = createDeferredCore();
  let scanBlocked = false;
  const registeredPaths = new Set<string>();
  const errors: unknown[] = [];
  const watches: Array<{ ready: boolean; watcher: ReturnType<typeof chokidar.watch> }> = [];
  const changes: Array<{ reason: string; changedPath?: string }> = [];
  const unregister = registerSkillsChangeListener((event) => {
    if (event.workspaceDir === workspaceDir) {
      changes.push(event);
    }
  });
  const originalNativeWatch = nativeFs.watch;
  const watchNative = vi.spyOn(nativeFs, "watch").mockImplementation((...args) => {
    const watcher = originalNativeWatch(...args);
    registeredPaths.add(path.resolve(String(args[0])));
    return watcher;
  });
  const originalWatch = chokidar.watch;
  const watch = vi.spyOn(chokidar, "watch").mockImplementation((...args) => {
    const watcher = originalWatch(...args);
    const observation = { ready: false, watcher };
    watches.push(observation);
    watcher.once("ready", () => {
      observation.ready = true;
    });
    watcher.on("error", (error) => errors.push(error));
    return watcher;
  });
  const originalReaddir = fs.readdir;
  const readdir = vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
    if (path.resolve(String(args[0])) === skillDir) {
      // Chokidar 5 emits addDir before this scan, then installs fs.watch after it.
      // Hold real registration open without replacing event delivery or discovery.
      scanBlocked = true;
      await releaseScan.promise;
    }
    return originalReaddir(...args);
  });
  syncBuiltinESMExports();

  try {
    ensureSkillsWatcher({ workspaceDir, config: {} });
    await vi.waitFor(() => {
      expect(watches.length).toBeGreaterThan(0);
      expect(watches.every(({ ready, watcher }) => ready || watcher.closed)).toBe(true);
      expect(errors).toEqual([]);
    });
    expect(read()).toEqual([]);
    const initialVersion = getSkillsSourceVersion(workspaceDir);
    changes.length = 0;

    nativeFs.mkdirSync(skillDir);
    nativeFs.writeFileSync(
      skillFile,
      "---\nname: registration-proof\ndescription: Native registration gap\n---\n",
    );
    await expect
      .poll(
        () => ({
          scanBlocked,
          discoveryAdvanced: getSkillsSourceVersion(workspaceDir) > initialVersion,
          addDirPublished: changes.some(
            (event) => event.reason === "watch" && event.changedPath === skillDir,
          ),
          names: read(),
        }),
        { timeout: 3_000 },
      )
      .toEqual({
        scanBlocked: true,
        discoveryAdvanced: true,
        addDirPublished: true,
        names: ["registration-proof"],
      });
    expect(registeredPaths.has(skillDir)).toBe(false);

    nativeFs.renameSync(skillFile, renamedSkillFile);
    const renameBeforeRegistration = !registeredPaths.has(skillDir);
    expect(read()).toEqual(["registration-proof"]);
    releaseScan.resolve();

    await expect.poll(() => registeredPaths.has(skillDir), { timeout: 3_000 }).toBe(true);
    expect(renameBeforeRegistration).toBe(true);
    expect(errors).toEqual([]);
    await expect.poll(read, { timeout: 3_000 }).toEqual([]);
  } finally {
    // Every failure path releases the real scan before closing native watchers.
    releaseScan.resolve();
    unregister();
    try {
      await closeSkillsWatchers(true);
    } finally {
      readdir.mockRestore();
      watch.mockRestore();
      watchNative.mockRestore();
      syncBuiltinESMExports();
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});
