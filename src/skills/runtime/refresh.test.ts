// Skill refresh tests cover runtime reload events and refresh-state updates.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  bumpSkillsSnapshotVersion,
  getSkillsSnapshotVersion,
  getSkillsSourceVersion,
  shouldRefreshSnapshotForVersion,
} from "./refresh-state.js";
import {
  createSkillsWatcherMock,
  useSkillsWatcherFixture,
} from "./refresh.watcher.test-support.js";

type SkillsChangeEvent = NonNullable<Parameters<typeof bumpSkillsSnapshotVersion>[0]>;

const { createdWatchers, watchMock, nativeWatchMock, nativeContentWatchMock, watchForSkillRoot } =
  createSkillsWatcherMock();

const pluginSkillsMocks = vi.hoisted(() => ({
  resolvePluginSkillRoots: vi.fn((): Array<{ dir: string; rejectHardlinks: boolean }> => []),
  resolvePluginSkillRootsFromMetadata: vi.fn(
    (): Array<{ dir: string; rejectHardlinks: boolean }> => [],
  ),
}));

let refreshModule: typeof import("./refresh.js");
let fixtureWorkspaceDir: string;

vi.mock("chokidar", () => ({
  default: { watch: watchMock },
}));
vi.mock("./refresh-ancestor-native.js", () => ({
  createNativeSkillsAncestorWatcher: vi.fn(nativeWatchMock),
}));
vi.mock("./refresh-content-native.js", () => ({
  createNativeSkillsContentWatcher: vi.fn(nativeContentWatchMock),
}));

vi.mock("../loading/plugin-skills.js", () => ({
  resolvePluginSkillRoots: pluginSkillsMocks.resolvePluginSkillRoots,
  resolvePluginSkillRootsFromMetadata: pluginSkillsMocks.resolvePluginSkillRootsFromMetadata,
}));

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
    pluginSkillsMocks.resolvePluginSkillRoots.mockClear();
    pluginSkillsMocks.resolvePluginSkillRootsFromMetadata.mockClear();
    fixtureWorkspaceDir = fixture.workspaceDir;
  });

  it("watches skill roots and filters non-skill churn", async () => {
    const workspaceDir = fixtureWorkspaceDir;
    refreshModule.ensureSkillsWatcher({ workspaceDir });
    const workspaceSkillsRoot = path.join(workspaceDir, "skills");
    const projectSkillsRoot = path.join(workspaceDir, ".agents", "skills");
    const { options, watchRoot } = watchForSkillRoot(workspaceSkillsRoot);
    expect(watchRoot).toBe(workspaceSkillsRoot.replaceAll("\\", "/"));
    expect(options.followSymlinks).toBe(false);
    // Six skill-directory levels plus one for per-skill identity metadata.
    expect(options.depth).toBe(7);
    const projectWatch = watchForSkillRoot(projectSkillsRoot);
    expect(projectWatch.watchRoot).toBe(workspaceDir.replaceAll("\\", "/"));
    expect(projectWatch.options.depth).toBe(0);
    await fs.mkdir(projectSkillsRoot, { recursive: true });
    projectWatch.watcher.emit("all", "addDir", path.dirname(projectSkillsRoot));
    expect(watchForSkillRoot(projectSkillsRoot).options.depth).toBe(7);
    expect(
      watchForSkillRoot(path.join(os.homedir(), ".agents", "skills")).options.followSymlinks,
    ).toBe(false);
    expect(watchMock.mock.calls.every(([target]) => !target.includes("*"))).toBe(true);

    for (const ignoredPath of [
      "node_modules/pkg/index.js",
      "dist/index.js",
      ".git/config",
      "scripts/.venv/bin/python",
      "venv/lib/python3.10/site.py",
      "__pycache__/module.pyc",
      ".mypy_cache/3.10/foo.json",
      ".pytest_cache/v/cache",
      "build/output.js",
      ".cache/data.json",
    ]) {
      expect(options.ignored(path.join(workspaceSkillsRoot, ignoredPath))).toBe(true);
    }
    // Unknown paths within the root remain visible until Chokidar can classify them.
    expect(options.ignored(path.join(workspaceSkillsRoot, ".hidden", "index.md"))).toBe(false);
    const skillDir = path.join(workspaceSkillsRoot, "my-skill");
    expect(options.ignored(skillDir, { isDirectory: () => true })).toBe(false);
    expect(options.ignored(skillDir, { isSymbolicLink: () => true })).toBe(false);
    expect(options.ignored(path.join(skillDir, "README.md"), {})).toBe(true);
    expect(options.ignored(path.join(skillDir, "SKILL.md"), {})).toBe(true);
    expect(options.ignored(path.join(skillDir, ".openclaw", "source-origin.json"), {})).toBe(true);
    expect(options.ignored(path.join(workspaceDir, "unrelated"), { isDirectory: () => true })).toBe(
      true,
    );
  });

  it("does not watch home-scoped personal skills for a non-default state directory", async () => {
    const createdRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-watch-isolated-"));
    const root = await fs.realpath(createdRoot);
    try {
      await withEnvAsync(
        {
          HOME: root,
          OPENCLAW_HOME: undefined,
          OPENCLAW_STATE_DIR: path.join(root, "scratch-state"),
        },
        async () => {
          await fs.mkdir(path.join(root, ".agents", "skills"), { recursive: true });
          refreshModule.ensureSkillsWatcher({ workspaceDir: path.join(root, "workspace") });
          const calls = watchMock.mock.calls as unknown as Array<[string]>;
          const targets = calls.map(([target]) => target);
          expect(targets).not.toContain(path.join(os.homedir(), ".agents", "skills"));
        },
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps discovery file watches in chokidar polling mode", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-watch-polling-"));
    const previousPolling = process.env.CHOKIDAR_USEPOLLING;
    try {
      process.env.CHOKIDAR_USEPOLLING = "true";
      refreshModule.ensureSkillsWatcher({ workspaceDir });

      const opts = watchForSkillRoot(path.join(workspaceDir, "skills")).options;
      expect(opts.usePolling).toBe(true);
      for (const file of [
        "SKILL.md",
        ".openclaw/source-origin.json",
        "origin-alias/source-origin.json",
      ]) {
        expect(opts.ignored(path.join(workspaceDir, "skills", "my-skill", file), {})).toBe(false);
      }
    } finally {
      if (previousPolling === undefined) {
        delete process.env.CHOKIDAR_USEPOLLING;
      } else {
        process.env.CHOKIDAR_USEPOLLING = previousPolling;
      }
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("keeps Darwin content and ancestor generations on stock Chokidar", async () => {
    const ancestor = vi.mocked(
      (await import("./refresh-ancestor-native.js")).createNativeSkillsAncestorWatcher,
    );
    const content = vi.mocked(
      (await import("./refresh-content-native.js")).createNativeSkillsContentWatcher,
    );
    ancestor.mockClear();
    content.mockClear();
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    try {
      Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
      refreshModule.ensureSkillsWatcher({ workspaceDir: fixtureWorkspaceDir });
      expect(ancestor).not.toHaveBeenCalled();
      expect(content).not.toHaveBeenCalled();
      expect(watchForSkillRoot(path.join(fixtureWorkspaceDir, "skills")).options).toMatchObject({
        depth: 7,
        usePolling: false,
      });
      expect(
        watchForSkillRoot(path.join(fixtureWorkspaceDir, ".agents", "skills")).options,
      ).toMatchObject({ depth: 0, usePolling: false });
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });

  it("keeps grouped skill folders within the watcher traversal depth", async () => {
    vi.useFakeTimers();
    const workspaceDir = await createFixtureDirectory("watch-depth");
    const seen: SkillsChangeEvent[] = [];
    refreshModule.registerSkillsChangeListener((change) => {
      seen.push(change);
    });
    refreshModule.ensureSkillsWatcher({
      workspaceDir,
      config: { skills: { load: {} } },
    });

    const watched = watchForSkillRoot(path.join(workspaceDir, "skills"));
    expect(watched.watchRoot).toBe(workspaceDir.replaceAll("\\", "/"));
    expect(watched.options.depth).toBe(0);

    const changedPath = path.join(workspaceDir, "skills", "group", "demo", "SKILL.md");
    await fs.mkdir(path.dirname(changedPath), { recursive: true });
    watched.watcher.emit("all", "addDir", path.join(workspaceDir, "skills"));
    const promoted = watchForSkillRoot(path.join(workspaceDir, "skills"));
    expect(promoted.options.depth).toBe(7);
    await vi.advanceTimersByTimeAsync(250);
    seen.length = 0;
    promoted.watcher.emit("all", "change", changedPath);
    await vi.advanceTimersByTimeAsync(250);

    expect(seen).toEqual([
      {
        workspaceDir,
        reason: "watch",
        changedPath,
      },
    ]);
  });

  it.runIf(process.platform !== "win32")(
    "watches allowed symlink skill targets without following every root symlink",
    async () => {
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-watch-symlink-"));
      const targetRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-watch-symlink-target-"));
      try {
        const workspaceSkillsDir = path.join(workspaceDir, "skills");
        const targetSkillDir = path.join(targetRoot, "linked-skill");
        const groupedLinkDir = path.join(workspaceSkillsDir, "group");
        await fs.mkdir(groupedLinkDir, { recursive: true });
        await fs.mkdir(targetSkillDir, { recursive: true });
        await fs.writeFile(
          path.join(targetSkillDir, "SKILL.md"),
          "---\nname: linked-skill\ndescription: Linked\n---\n",
        );
        await fs.symlink(targetSkillDir, path.join(groupedLinkDir, "linked-skill"), "dir");

        refreshModule.ensureSkillsWatcher({
          workspaceDir,
          config: { skills: { load: { allowSymlinkTargets: [targetRoot] } } },
        });

        const calls = watchMock.mock.calls as unknown as Array<
          [string, { followSymlinks?: boolean }]
        >;
        const target = (await fs.realpath(targetSkillDir)).replaceAll("\\", "/");
        expect(calls.find(([p]) => p.replaceAll("\\", "/") === target)?.[1].followSymlinks).toBe(
          false,
        );
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
        await fs.rm(targetRoot, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")("watches symlinked skill root targets", async () => {
    const workspaceDir = await createFixtureDirectory("watch-root-link");
    const targetSkillsDir = await createFixtureDirectory("watch-root-link-target");
    await fs.writeFile(
      path.join(targetSkillsDir, "SKILL.md"),
      "---\nname: linked-root\ndescription: Linked root\n---\n",
    );
    await fs.symlink(targetSkillsDir, path.join(workspaceDir, "skills"), "dir");

    refreshModule.ensureSkillsWatcher({ workspaceDir });

    const calls = watchMock.mock.calls as unknown as Array<[string, { followSymlinks?: boolean }]>;
    const target = (await fs.realpath(targetSkillsDir)).replaceAll("\\", "/");
    expect(calls.find(([p]) => p.replaceAll("\\", "/") === target)?.[1].followSymlinks).toBe(false);
  });

  it.runIf(process.platform !== "win32")(
    "does not watch untrusted companion skills symlink targets",
    async () => {
      const workspaceDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "openclaw-watch-untrusted-link-"),
      );
      const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-watch-untrusted-repo-"));
      const outsideDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "openclaw-watch-untrusted-target-"),
      );
      try {
        await fs.writeFile(
          path.join(outsideDir, "SKILL.md"),
          "---\nname: untrusted\ndescription: Untrusted\n---\n",
        );
        await fs.symlink(outsideDir, path.join(repoDir, "skills"), "dir");

        refreshModule.ensureSkillsWatcher({
          workspaceDir,
          config: { skills: { load: { extraDirs: [repoDir] } } },
        });

        const target = (await fs.realpath(outsideDir)).replaceAll("\\", "/");
        const targets = (watchMock.mock.calls as unknown as Array<[string]>).map(([p]) =>
          p.replaceAll("\\", "/"),
        );
        expect(targets).not.toContain(target);
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
        await fs.rm(repoDir, { recursive: true, force: true });
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    },
  );

  it("watches nested skills roots for repo-style extra dirs", async () => {
    const repoDir = await createFixtureDirectory("skills-watch");
    await fs.mkdir(path.join(repoDir, "skills", "group", "demo"), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, "skills", "group", "demo", "SKILL.md"),
      "---\nname: demo\ndescription: Demo\n---\n",
    );

    refreshModule.ensureSkillsWatcher({
      workspaceDir: fixtureWorkspaceDir,
      config: { skills: { load: { extraDirs: [repoDir] } } },
    });

    const calls = watchMock.mock.calls as unknown as Array<[string, { depth?: number }]>;
    const targets = calls.map(([p]) => p.replaceAll("\\", "/"));
    const repoRoot = repoDir.replaceAll("\\", "/");
    const nestedRoot = path.join(repoDir, "skills").replaceAll("\\", "/");
    expect(targets).toContain(nestedRoot);
    expect(targets).toContain(repoRoot);
    expect(targets).not.toContain(path.join(repoDir, "SKILL.md").replaceAll("\\", "/"));
    expect(calls.find(([p]) => p.replaceAll("\\", "/") === repoRoot)?.[1].depth).toBe(3);
    expect(calls.find(([p]) => p.replaceAll("\\", "/") === nestedRoot)?.[1].depth).toBe(7);
  });

  it("watches nested skills roots for built-in workspace skill dirs", async () => {
    const workspaceDir = await createFixtureDirectory("workspace-skills");
    await fs.mkdir(path.join(workspaceDir, "skills", "skills", "group", "demo"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(workspaceDir, "skills", "skills", "group", "demo", "SKILL.md"),
      "---\nname: demo\ndescription: Demo\n---\n",
    );

    refreshModule.ensureSkillsWatcher({ workspaceDir });

    const targets = (watchMock.mock.calls as unknown as Array<[string, object]>).map(([p]) =>
      p.replaceAll("\\", "/"),
    );
    expect(targets).toContain(path.join(workspaceDir, "skills").replaceAll("\\", "/"));
    expect(targets).toContain(path.join(workspaceDir, "skills", "skills").replaceAll("\\", "/"));
  });

  it("reuses watch roots while config is unchanged", async () => {
    const repoDir = await createFixtureDirectory("skills-watch-cache");
    await fs.mkdir(path.join(repoDir, "skills", "group", "demo"), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, "skills", "group", "demo", "SKILL.md"),
      "---\nname: demo\ndescription: Demo\n---\n",
    );
    const config = { skills: { load: { extraDirs: [repoDir] } } };

    refreshModule.ensureSkillsWatcher({ workspaceDir: fixtureWorkspaceDir, config });
    const firstCallCount = watchMock.mock.calls.length;
    await fs.rm(path.join(repoDir, "skills"), { recursive: true, force: true });
    refreshModule.ensureSkillsWatcher({ workspaceDir: fixtureWorkspaceDir, config });

    const calls = watchMock.mock.calls as unknown as Array<[string, { depth?: number }]>;
    const targets = calls.map(([p]) => p.replaceAll("\\", "/"));
    const repoRoot = repoDir.replaceAll("\\", "/");
    const nestedRoot = path.join(repoDir, "skills").replaceAll("\\", "/");
    expect(watchMock).toHaveBeenCalledTimes(firstCallCount);
    expect(targets).toContain(nestedRoot);
    expect(targets).toContain(repoRoot);
    expect(calls.find(([p]) => p.replaceAll("\\", "/") === repoRoot)?.[1].depth).toBe(3);
    expect(calls.find(([p]) => p.replaceAll("\\", "/") === nestedRoot)?.[1].depth).toBe(7);
  });

  it("reuses prepared plugin metadata when reconciling watch targets", () => {
    const config = { skills: { load: {} } };
    const pluginMetadataSnapshot = { policyHash: "prepared" } as PluginMetadataSnapshot;

    refreshModule.ensureSkillsWatcher({
      workspaceDir: fixtureWorkspaceDir,
      config,
      pluginMetadataSnapshot,
    });
    refreshModule.ensureSkillsWatcher({
      workspaceDir: fixtureWorkspaceDir,
      config,
      pluginMetadataSnapshot,
    });

    expect(pluginSkillsMocks.resolvePluginSkillRoots).not.toHaveBeenCalled();
    expect(pluginSkillsMocks.resolvePluginSkillRootsFromMetadata).toHaveBeenCalledTimes(2);
    expect(pluginSkillsMocks.resolvePluginSkillRootsFromMetadata).toHaveBeenLastCalledWith({
      workspaceDir: fixtureWorkspaceDir,
      config,
      metadataSnapshot: pluginMetadataSnapshot,
    });
  });

  it("watches extra-dir roots and companion skills folders without resolving them", async () => {
    const repoDir = await createFixtureDirectory("skills-watch-pair");
    refreshModule.ensureSkillsWatcher({
      workspaceDir: fixtureWorkspaceDir,
      config: { skills: { load: { extraDirs: [repoDir] } } },
    });

    const rootWatch = watchForSkillRoot(repoDir);
    const companionWatch = watchForSkillRoot(path.join(repoDir, "skills"));
    expect(rootWatch.watchRoot).toBe(repoDir.replaceAll("\\", "/"));
    expect(companionWatch.watchRoot).toBe(rootWatch.watchRoot);
    expect(rootWatch.options.depth).toBe(3);
    expect(companionWatch.options.depth).toBe(0);
    expect(companionWatch.options.ignored(path.join(repoDir, "other"))).toBe(true);
  });

  it("promotes missing configured roots for first nested skill creation", async () => {
    const parentDir = await createFixtureDirectory("missing-skill-root");
    const missingRoot = path.join(parentDir, "repo");
    refreshModule.ensureSkillsWatcher({
      workspaceDir: fixtureWorkspaceDir,
      config: { skills: { load: { extraDirs: [missingRoot] } } },
    });

    const rootWatch = watchForSkillRoot(missingRoot);
    const companionWatch = watchForSkillRoot(path.join(missingRoot, "skills"));
    expect(rootWatch.watchRoot).toBe(parentDir.replaceAll("\\", "/"));
    expect(companionWatch.watchRoot).toBe(rootWatch.watchRoot);
    expect(rootWatch.options.depth).toBe(0);
    expect(companionWatch.watcher).toBe(rootWatch.watcher);
    await fs.mkdir(path.join(missingRoot, "skills", "group", "demo"), { recursive: true });
    rootWatch.watcher.emit("all", "addDir", missingRoot);
    expect(watchForSkillRoot(missingRoot).options.depth).toBe(3);
    expect(watchForSkillRoot(path.join(missingRoot, "skills")).options.depth).toBe(7);
  });

  it("watches configured roots named skills at grouped depth", async () => {
    const parentDir = await createFixtureDirectory("configured-skills-root");
    const skillsDir = path.join(parentDir, "skills");
    await fs.mkdir(skillsDir, { recursive: true });
    refreshModule.ensureSkillsWatcher({
      workspaceDir: fixtureWorkspaceDir,
      config: { skills: { load: { extraDirs: [skillsDir] } } },
    });

    const calls = watchMock.mock.calls as unknown as Array<[string, { depth?: number }]>;
    const root = skillsDir.replaceAll("\\", "/");
    expect(calls.find(([p]) => p.replaceAll("\\", "/") === root)?.[1].depth).toBe(7);
  });

  it("dedupes overlapping watch roots by path while keeping the deepest depth", async () => {
    const workspaceDir = await createFixtureDirectory("watch-dedupe");
    const skillsDir = path.join(workspaceDir, "skills");
    await fs.mkdir(path.join(skillsDir, "skills"), { recursive: true });
    refreshModule.ensureSkillsWatcher({
      workspaceDir,
      config: { skills: { load: { extraDirs: [skillsDir] } } },
    });

    const calls = watchMock.mock.calls as unknown as Array<[string, { depth?: number }]>;
    const root = skillsDir.replaceAll("\\", "/");
    const overlapping = calls.filter(([p]) => p.replaceAll("\\", "/") === root);
    expect(overlapping).toHaveLength(1);
    expect(overlapping[0]?.[1].depth).toBe(7);
  });

  it("does not downgrade a shared watcher when a shallow subscriber arrives later", async () => {
    const workspaceDir = await createFixtureDirectory("watch-share-a");
    const otherDir = await createFixtureDirectory("watch-share-b");
    const skillsDir = path.join(workspaceDir, "skills");
    await fs.mkdir(path.join(skillsDir, "skills"), { recursive: true });
    refreshModule.ensureSkillsWatcher({ workspaceDir });
    const firstCalls = watchMock.mock.calls as unknown as Array<[string, { depth?: number }]>;
    const root = skillsDir.replaceAll("\\", "/");
    const firstIndex = firstCalls.findIndex(([p]) => p.replaceAll("\\", "/") === root);

    refreshModule.ensureSkillsWatcher({
      workspaceDir: otherDir,
      config: { skills: { load: { extraDirs: [skillsDir] } } },
    });

    const calls = watchMock.mock.calls as unknown as Array<[string, { depth?: number }]>;
    const overlapping = calls.filter(([p]) => p.replaceAll("\\", "/") === root);
    expect(overlapping).toHaveLength(1);
    expect(overlapping[0]?.[1].depth).toBe(7);
    expect(createdWatchers[firstIndex]?.close).not.toHaveBeenCalled();
  });

  it.each(["error", "error-then-ready", "ready-then-error", "null-error"] as const)(
    "retries a failed shared ancestor for a new root after %s",
    async (scan) => {
      vi.useFakeTimers();
      const ancestor = await createFixtureDirectory("failed-ancestor");
      const firstRoot = path.join(ancestor, "first");
      const secondRoot = path.join(ancestor, "second");
      const secondWorkspace = await createFixtureDirectory("second-workspace");
      refreshModule.ensureSkillsWatcher({
        workspaceDir: fixtureWorkspaceDir,
        config: { skills: { load: { extraDirs: [firstRoot] } } },
      });
      const failed = watchForSkillRoot(firstRoot).watcher;
      const lateReady = failed.on.mock.calls.find(([event]) => event === "ready")![1];
      const lateError = failed.on.mock.calls.find(([event]) => event === "error")![1];
      if (scan === "ready-then-error") {
        for (const watcher of createdWatchers) {
          watcher.emit("ready");
        }
      }
      failed.emit(
        "error",
        scan === "null-error"
          ? null
          : Object.assign(new Error("native watch failed"), { code: "EIO" }),
      );
      if (scan === "error-then-ready") {
        // Chokidar can finish scanning after native watch installation failed.
        failed.emit("ready");
      }
      refreshModule.ensureSkillsWatcher({
        workspaceDir: secondWorkspace,
        config: { skills: { load: { extraDirs: [secondRoot] } } },
      });
      const replacement = watchForSkillRoot(secondRoot).watcher;
      expect(replacement).not.toBe(failed);
      expect(watchForSkillRoot(firstRoot).watcher).toBe(replacement);
      expect(failed.close).toHaveBeenCalledOnce();
      for (const watcher of createdWatchers) {
        if (watcher !== replacement) {
          watcher.emit("ready");
        }
      }
      const firstBeforeReady = getSkillsSourceVersion(fixtureWorkspaceDir);
      const secondBeforeReady = getSkillsSourceVersion(secondWorkspace);
      lateReady();
      lateError(new Error("retired scan failed"));
      expect(getSkillsSourceVersion(fixtureWorkspaceDir)).toBe(firstBeforeReady);
      expect(getSkillsSourceVersion(secondWorkspace)).toBe(secondBeforeReady);
      replacement.emit("ready");
      if (scan === "ready-then-error") {
        expect(getSkillsSourceVersion(fixtureWorkspaceDir)).toBe(firstBeforeReady);
      } else {
        expect(getSkillsSourceVersion(fixtureWorkspaceDir)).toBeGreaterThan(firstBeforeReady);
      }
      expect(getSkillsSourceVersion(secondWorkspace)).toBeGreaterThan(secondBeforeReady);

      const firstBeforeCreation = getSkillsSourceVersion(fixtureWorkspaceDir);
      await fs.mkdir(firstRoot);
      replacement.emit("all", "addDir", firstRoot);
      await vi.advanceTimersByTimeAsync(250);
      expect(getSkillsSourceVersion(fixtureWorkspaceDir)).toBeGreaterThan(firstBeforeCreation);
      expect(replacement.close).not.toHaveBeenCalled();
      const secondBeforeCreation = getSkillsSourceVersion(secondWorkspace);
      await fs.mkdir(secondRoot);
      replacement.emit("all", "addDir", secondRoot);
      await vi.advanceTimersByTimeAsync(250);
      expect(getSkillsSourceVersion(secondWorkspace)).toBeGreaterThan(secondBeforeCreation);
      expect(replacement.close).not.toHaveBeenCalled();
      const first = watchForSkillRoot(firstRoot).watcher;
      const second = watchForSkillRoot(secondRoot).watcher;
      refreshModule.ensureSkillsWatcher({
        workspaceDir: fixtureWorkspaceDir,
        config: { skills: { load: { watch: false } } },
      });
      expect(first.close).toHaveBeenCalledOnce();
      expect(second.close).not.toHaveBeenCalled();
      expect(replacement.close).not.toHaveBeenCalled();
      refreshModule.ensureSkillsWatcher({
        workspaceDir: secondWorkspace,
        config: { skills: { load: { watch: false } } },
      });
      expect(second.close).toHaveBeenCalledOnce();
      expect(replacement.close).toHaveBeenCalledOnce();
    },
  );

  it.each(["before-content", "around-content"] as const)(
    "discovers initial content when ancestor scans fail %s",
    async (ordering) => {
      const { loadWorkspaceSkills } = await import("../loading/workspace-skill-loader.js");
      const ancestor = await createFixtureDirectory("ancestor-error");
      const intermediate = path.join(ancestor, "nested");
      const innerAncestor = path.join(intermediate, "inner");
      const logicalRoot = path.join(innerAncestor, "skills");
      const config = { skills: { load: { extraDirs: [logicalRoot] } } };
      const read = () =>
        loadWorkspaceSkills(fixtureWorkspaceDir, {
          config,
          bundledSkillsDir: "",
          managedSkillsDir: path.join(ancestor, "unused"),
        }).map((entry) => entry.skill.name);
      refreshModule.ensureSkillsWatcher({ workspaceDir: fixtureWorkspaceDir, config });
      const initialAncestor = watchForSkillRoot(logicalRoot).watcher;
      await fs.mkdir(logicalRoot, { recursive: true });
      // Promotion through initial readiness creates no addDir debounce that could
      // later invalidate the empty cache independently of content readiness.
      initialAncestor.emit("ready");
      const content = watchForSkillRoot(logicalRoot).watcher;
      expect(content).not.toBe(initialAncestor);
      const failedIndex = watchMock.mock.calls.findLastIndex(
        ([watchRoot, options], index) =>
          watchRoot === intermediate.replaceAll("\\", "/") &&
          options.depth === 0 &&
          !createdWatchers[index]?.closed,
      );
      expect(failedIndex).toBeGreaterThanOrEqual(0);
      const failedAncestor = createdWatchers[failedIndex]!;
      const lastFailedIndex =
        ordering === "around-content"
          ? watchMock.mock.calls.findLastIndex(
              ([watchRoot, options], index) =>
                watchRoot === innerAncestor.replaceAll("\\", "/") &&
                options.depth === 0 &&
                !createdWatchers[index]?.closed,
            )
          : -1;
      if (ordering === "around-content") {
        expect(lastFailedIndex).toBeGreaterThanOrEqual(0);
      }
      const lastFailedAncestor = createdWatchers[lastFailedIndex];
      for (const watcher of createdWatchers) {
        if (watcher !== content && watcher !== failedAncestor && watcher !== lastFailedAncestor) {
          watcher.emit("ready");
        }
      }
      // Existing shared ancestors notify late subscriptions in a microtask. Finish
      // those callbacks before error delivery; they must not repair the cache later.
      await Promise.resolve();
      failedAncestor.emit(
        "error",
        Object.assign(new Error("ancestor scan failed"), { code: "EIO" }),
      );
      expect(read()).toEqual([]);
      const skillDir = path.join(logicalRoot, "ancestor-error-proof");
      await fs.mkdir(skillDir);
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        "---\nname: ancestor-error-proof\ndescription: Discovered by healthy content scan\n---\n",
      );
      // ignoreInitial may suppress all/change events for content found by this scan.
      expect(read()).toEqual([]);
      content.emit("ready");
      expect(read()).toEqual([]);
      watchForSkillRoot(logicalRoot).watcher.emit("ready");
      if (lastFailedAncestor) {
        expect(read()).toEqual([]);
        lastFailedAncestor.emit(
          "error",
          Object.assign(new Error("last ancestor scan failed"), { code: "EIO" }),
        );
      }
      expect(read()).toEqual(["ancestor-error-proof"]);
    },
  );

  it.each(["ready", "error-then-ready"] as const)(
    "preserves shared coverage when a replaced ancestor scan is %s",
    async (scan) => {
      vi.useFakeTimers();
      const ancestor = await createFixtureDirectory("ancestor");
      const logicalRoot = path.join(ancestor, "a", "b", "c", "d", "repo");
      const secondWorkspace = await createFixtureDirectory("second-workspace");
      const executionWorkspaceDir = await createFixtureDirectory("first-execution");
      const config = { skills: { load: { extraDirs: [logicalRoot] } } };
      refreshModule.ensureSkillsWatcher({
        workspaceDir: fixtureWorkspaceDir,
        executionWorkspaceDir,
        config,
      });
      const shallow = watchForSkillRoot(logicalRoot);
      expect(shallow.watchRoot).toBe(ancestor.replaceAll("\\", "/"));
      expect(shallow.options.depth).toBe(0);
      for (const watcher of createdWatchers) {
        watcher.emit("ready");
      }
      const beforeReplacement = getSkillsSourceVersion(fixtureWorkspaceDir);

      await fs.mkdir(logicalRoot, { recursive: true });
      await fs.symlink(
        logicalRoot,
        path.join(secondWorkspace, "skills"),
        process.platform === "win32" ? "junction" : "dir",
      );
      refreshModule.ensureSkillsWatcher({ workspaceDir: secondWorkspace });
      const deeper = watchForSkillRoot(logicalRoot);
      expect(deeper.watchRoot).toBe(logicalRoot.replaceAll("\\", "/"));
      expect(deeper.options.depth).toBe(7);
      for (const watcher of createdWatchers) {
        if (watcher !== deeper.watcher) {
          watcher.emit("ready");
        }
      }
      expect(shallow.watcher.close).not.toHaveBeenCalled();
      if (scan === "error-then-ready") {
        deeper.watcher.emit("error", new Error("initial scan interrupted"));
        expect(getSkillsSourceVersion(fixtureWorkspaceDir)).toBeGreaterThan(beforeReplacement);
      }
      const beforeReady = getSkillsSourceVersion(fixtureWorkspaceDir);
      deeper.watcher.emit("ready");
      expect(getSkillsSourceVersion(fixtureWorkspaceDir)).toBe(beforeReady);
      watchForSkillRoot(logicalRoot).watcher.emit("ready");
      if (scan === "error-then-ready") {
        expect(getSkillsSourceVersion(fixtureWorkspaceDir)).toBe(beforeReady);
        watchForSkillRoot(logicalRoot).watcher.emit("ready");
      }
      expect(getSkillsSourceVersion(fixtureWorkspaceDir)).toBeGreaterThan(beforeReady);

      const seen: SkillsChangeEvent[] = [];
      refreshModule.registerSkillsChangeListener((change) => seen.push(change));
      const versionBefore = getSkillsSnapshotVersion(fixtureWorkspaceDir);
      const removedParent = path.dirname(logicalRoot);
      const parentWatchRoot = path.dirname(removedParent).replaceAll("\\", "/");
      const parentWatchIndex = watchMock.mock.calls.findLastIndex(
        ([watchRoot, options], index) =>
          watchRoot === parentWatchRoot && options.depth === 0 && !createdWatchers[index]?.closed,
      );
      expect(parentWatchIndex).toBeGreaterThanOrEqual(0);
      const parentWatcher = createdWatchers[parentWatchIndex]!;
      await fs.rm(removedParent, { recursive: true });
      parentWatcher.emit("all", "unlinkDir", removedParent);
      await vi.advanceTimersByTimeAsync(250);
      expect(getSkillsSnapshotVersion(fixtureWorkspaceDir)).toBeGreaterThan(versionBefore);

      // A shallow subscriber reconciles first; the surviving deeper subscriber
      // still requires six skill levels and their metadata below the logical root.
      refreshModule.ensureSkillsWatcher({
        workspaceDir: fixtureWorkspaceDir,
        executionWorkspaceDir,
        config,
      });
      const rebuilt = watchForSkillRoot(logicalRoot);
      expect(deeper.watcher.close).toHaveBeenCalledOnce();
      expect(rebuilt.watchRoot).toBe(path.dirname(removedParent).replaceAll("\\", "/"));
      expect(rebuilt.options.depth).toBe(0);
      const changedPath = path.join(logicalRoot, "group", "nested", "demo", "SKILL.md");
      await fs.mkdir(path.dirname(changedPath), { recursive: true });
      rebuilt.watcher.emit("all", "addDir", removedParent);
      const promoted = watchForSkillRoot(logicalRoot);
      expect(promoted.watchRoot).toBe(logicalRoot.replaceAll("\\", "/"));
      expect(promoted.options.depth).toBe(7);
      await vi.advanceTimersByTimeAsync(250);
      seen.length = 0;
      promoted.watcher.emit("all", "change", changedPath);
      await vi.advanceTimersByTimeAsync(250);
      expect(seen).toEqual([
        { workspaceDir: fixtureWorkspaceDir, reason: "watch", changedPath },
        { workspaceDir: secondWorkspace, reason: "watch", changedPath },
      ]);
    },
  );

  it("watches extra-dir skills folders for first nested skill creation", async () => {
    const repoDir = await createFixtureDirectory("skills-watch-create");
    refreshModule.ensureSkillsWatcher({
      workspaceDir: fixtureWorkspaceDir,
      config: { skills: { load: { extraDirs: [repoDir] } } },
    });

    const nestedRoot = path.join(repoDir, "skills");
    const watched = watchForSkillRoot(nestedRoot);
    expect(watched.watchRoot).toBe(repoDir.replaceAll("\\", "/"));
    expect(watched.options.depth).toBe(0);
    expect(watched.options.ignored(path.join(repoDir, "unrelated"))).toBe(true);
    await fs.mkdir(path.join(nestedRoot, "group", "demo"), { recursive: true });
    watched.watcher.emit("all", "addDir", nestedRoot);
    const promoted = watchForSkillRoot(nestedRoot);
    expect(promoted.watchRoot).toBe(nestedRoot.replaceAll("\\", "/"));
    expect(promoted.options.depth).toBe(7);
  });

  it("watches nested skills roots for plugin skill dirs", async () => {
    const pluginDir = await createFixtureDirectory("plugin-skills-watch");
    await fs.mkdir(path.join(pluginDir, "skills", "group", "demo"), { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, "skills", "group", "demo", "SKILL.md"),
      "---\nname: demo\ndescription: Demo\n---\n",
    );
    const pluginSkills = await import("../loading/plugin-skills.js");
    vi.mocked(pluginSkills.resolvePluginSkillRoots).mockReturnValueOnce([
      { dir: pluginDir, rejectHardlinks: true },
    ]);

    refreshModule.ensureSkillsWatcher({ workspaceDir: fixtureWorkspaceDir });

    const calls = watchMock.mock.calls as unknown as Array<[string, { depth?: number }]>;
    const targets = calls.map(([p]) => p.replaceAll("\\", "/"));
    const pluginRoot = pluginDir.replaceAll("\\", "/");
    const nestedRoot = path.join(pluginDir, "skills").replaceAll("\\", "/");
    expect(targets).toContain(nestedRoot);
    expect(targets).toContain(pluginRoot);
    expect(calls.find(([p]) => p.replaceAll("\\", "/") === pluginRoot)?.[1].depth).toBe(3);
    expect(calls.find(([p]) => p.replaceAll("\\", "/") === nestedRoot)?.[1].depth).toBe(7);
  });

  it("watches plugin skills folders for first nested skill creation", async () => {
    const pluginDir = await createFixtureDirectory("plugin-skills-watch-create");
    const pluginSkills = await import("../loading/plugin-skills.js");
    vi.mocked(pluginSkills.resolvePluginSkillRoots).mockReturnValueOnce([
      { dir: pluginDir, rejectHardlinks: true },
    ]);

    refreshModule.ensureSkillsWatcher({ workspaceDir: fixtureWorkspaceDir });

    const nestedRoot = path.join(pluginDir, "skills");
    const watched = watchForSkillRoot(nestedRoot);
    expect(watched.watchRoot).toBe(pluginDir.replaceAll("\\", "/"));
    expect(watched.options.depth).toBe(0);
    expect(watched.options.ignored(path.join(pluginDir, "unrelated"))).toBe(true);
    await fs.mkdir(path.join(nestedRoot, "group", "demo"), { recursive: true });
    watched.watcher.emit("all", "addDir", nestedRoot);
    const promoted = watchForSkillRoot(nestedRoot);
    expect(promoted.watchRoot).toBe(nestedRoot.replaceAll("\\", "/"));
    expect(promoted.options.depth).toBe(7);
  });

  it.runIf(process.platform !== "win32")(
    "does not watch untrusted plugin skill symlink targets",
    async () => {
      const pluginDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "openclaw-plugin-skills-untrusted-link-"),
      );
      const outsideDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "openclaw-plugin-skills-untrusted-target-"),
      );
      try {
        await fs.mkdir(path.join(pluginDir, "skills"), { recursive: true });
        await fs.writeFile(
          path.join(outsideDir, "SKILL.md"),
          "---\nname: untrusted-plugin\ndescription: Untrusted plugin\n---\n",
        );
        await fs.symlink(outsideDir, path.join(pluginDir, "skills", "untrusted"), "dir");
        const pluginSkills = await import("../loading/plugin-skills.js");
        vi.mocked(pluginSkills.resolvePluginSkillRoots).mockReturnValueOnce([
          { dir: pluginDir, rejectHardlinks: true },
        ]);

        refreshModule.ensureSkillsWatcher({ workspaceDir: fixtureWorkspaceDir });

        const target = (await fs.realpath(outsideDir)).replaceAll("\\", "/");
        const targets = (watchMock.mock.calls as unknown as Array<[string]>).map(([p]) =>
          p.replaceAll("\\", "/"),
        );
        expect(targets).not.toContain(target);
      } finally {
        await fs.rm(pluginDir, { recursive: true, force: true });
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    },
  );

  it.each(["add", "addDir", "change", "unlink", "unlinkDir"] as const)(
    "refreshes skills snapshots on %s",
    async (event) => {
      vi.useFakeTimers();
      const seen: SkillsChangeEvent[] = [];
      refreshModule.registerSkillsChangeListener((change) => {
        seen.push(change);
      });
      refreshModule.ensureSkillsWatcher({
        workspaceDir: fixtureWorkspaceDir,
        config: { skills: { load: {} } },
      });

      seen.length = 0;
      const changedPath = path.join(
        fixtureWorkspaceDir,
        "skills",
        "demo",
        ...(event.endsWith("Dir") ? [] : ["SKILL.md"]),
      );
      watchForSkillRoot(path.join(fixtureWorkspaceDir, "skills")).watcher.emit(
        "all",
        event,
        changedPath,
      );
      await vi.advanceTimersByTimeAsync(250);

      expect(seen).toEqual([
        {
          workspaceDir: fixtureWorkspaceDir,
          reason: "watch",
          changedPath,
        },
      ]);
    },
  );

  it.each(
    ["skills", ".agents/skills"].flatMap((directory) =>
      ["add", "change", "unlink"].map((event) => ({ directory, event })),
    ),
  )(
    "refreshes the owning snapshot when execution $directory emits $event",
    async ({ directory, event }) => {
      vi.useFakeTimers();
      const workspaceDir = fixtureWorkspaceDir;
      const executionWorkspaceDir = await createFixtureDirectory("execution-workspace");
      const skillRoot = path.join(executionWorkspaceDir, directory);
      await fs.mkdir(skillRoot, { recursive: true });
      const seen: SkillsChangeEvent[] = [];
      refreshModule.registerSkillsChangeListener((change) => {
        seen.push(change);
      });
      refreshModule.ensureSkillsWatcher({ workspaceDir, executionWorkspaceDir });
      const versionBefore = getSkillsSnapshotVersion(workspaceDir);
      const watched = watchForSkillRoot(skillRoot);
      const changedPath = path.join(skillRoot, "demo", "SKILL.md");
      watched.watcher.emit("all", event, changedPath);
      await vi.advanceTimersByTimeAsync(250);

      const versionAfter = getSkillsSnapshotVersion(workspaceDir);
      expect(shouldRefreshSnapshotForVersion(versionBefore, versionAfter)).toBe(true);
      expect(seen).toContainEqual({
        workspaceDir,
        reason: "watch",
        changedPath,
      });
    },
  );

  it("refreshes skills snapshots when watched skill roots change", async () => {
    vi.useFakeTimers();
    const sharedA = await createFixtureDirectory("shared-a");
    const sharedB = await createFixtureDirectory("shared-b");
    const seen: SkillsChangeEvent[] = [];
    refreshModule.registerSkillsChangeListener((change) => {
      seen.push(change);
    });
    refreshModule.ensureSkillsWatcher({
      workspaceDir: fixtureWorkspaceDir,
      config: { skills: { load: { extraDirs: [sharedA] } } },
    });
    const previousWatcher = watchForSkillRoot(sharedA).watcher;
    seen.length = 0;

    refreshModule.ensureSkillsWatcher({
      workspaceDir: fixtureWorkspaceDir,
      config: { skills: { load: { extraDirs: [sharedB] } } },
    });

    expect(previousWatcher.close).toHaveBeenCalledTimes(1);
    expect(watchForSkillRoot(sharedB).watchRoot).toBe(sharedB.replaceAll("\\", "/"));
    expect(seen).toEqual([
      {
        workspaceDir: fixtureWorkspaceDir,
        reason: "watch-targets",
        changedPath: expect.stringContaining(sharedB.replaceAll("\\", "/")),
      },
    ]);
    seen.length = 0;
    const replacement = watchForSkillRoot(sharedB).watcher;
    for (const watcher of createdWatchers) {
      if (watcher !== replacement) {
        watcher.emit("ready");
      }
    }
    await vi.advanceTimersByTimeAsync(250);
    expect(seen).toEqual([]);
    replacement.emit("ready");
    expect(seen).toEqual([]);
    watchForSkillRoot(sharedB).watcher.emit("ready");
    await vi.advanceTimersByTimeAsync(250);
    expect(seen).toEqual([
      { workspaceDir: fixtureWorkspaceDir, reason: "watch", changedPath: undefined },
    ]);
  });

  it("reuses one watcher when multiple workspaces watch the same shared skill root", async () => {
    const secondWorkspace = await createFixtureDirectory("second-workspace");
    const sharedSkillsRoot = await createFixtureDirectory("shared/skills");
    const sharedRoot = path.dirname(sharedSkillsRoot);
    const config = { skills: { load: { extraDirs: [sharedRoot] } } };
    refreshModule.ensureSkillsWatcher({ workspaceDir: fixtureWorkspaceDir, config });
    const firstRootWatcher = watchForSkillRoot(sharedRoot).watcher;
    const firstSkillsWatcher = watchForSkillRoot(sharedSkillsRoot).watcher;
    refreshModule.ensureSkillsWatcher({ workspaceDir: secondWorkspace, config });

    expect(watchForSkillRoot(sharedRoot).watcher).toBe(firstRootWatcher);
    expect(watchForSkillRoot(sharedSkillsRoot).watcher).toBe(firstSkillsWatcher);
    const callPaths = watchMock.mock.calls.map(([watchRoot]) => watchRoot);
    expect(callPaths.filter((target) => target === sharedRoot.replaceAll("\\", "/"))).toHaveLength(
      1,
    );
    expect(
      callPaths.filter((target) => target === sharedSkillsRoot.replaceAll("\\", "/")),
    ).toHaveLength(1);
  });

  it.each(["change", "ready"] as const)(
    "fans out shared-directory %s once per workspace across execution subscriptions",
    async (event) => {
      vi.useFakeTimers();
      const secondWorkspace = await createFixtureDirectory("second-workspace");
      const executionWorkspaceDir = await createFixtureDirectory("execution-worktree");
      const sharedRoot = await createFixtureDirectory("shared");
      const config = { skills: { load: { extraDirs: [sharedRoot] } } };
      const seen: SkillsChangeEvent[] = [];
      refreshModule.registerSkillsChangeListener((change) => {
        seen.push(change);
      });
      refreshModule.ensureSkillsWatcher({ workspaceDir: fixtureWorkspaceDir, config });
      refreshModule.ensureSkillsWatcher({ workspaceDir: secondWorkspace, config });
      refreshModule.ensureSkillsWatcher({
        workspaceDir: fixtureWorkspaceDir,
        executionWorkspaceDir,
        config,
      });
      seen.length = 0;
      const changedPath =
        event === "change" ? path.join(sharedRoot, "demo", "SKILL.md") : undefined;
      const watcher = watchForSkillRoot(sharedRoot).watcher;
      if (event === "ready") {
        for (const other of createdWatchers) {
          if (other !== watcher) {
            other.emit("ready");
          }
        }
        await vi.advanceTimersByTimeAsync(250);
        expect(seen).toEqual([]);
        watcher.emit("ready");
        expect(seen).toEqual([]);
        watchForSkillRoot(sharedRoot).watcher.emit("ready");
      } else {
        watcher.emit("all", event, changedPath);
      }
      await vi.advanceTimersByTimeAsync(250);

      expect(seen).toEqual([
        { workspaceDir: fixtureWorkspaceDir, reason: "watch", changedPath },
        { workspaceDir: secondWorkspace, reason: "watch", changedPath },
      ]);
    },
  );
});
